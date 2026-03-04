import { describe, it, expect, vi, beforeEach } from 'vitest';
import { journalService } from '../services/journalService';
import pool from '../db/connect';
import ApiError from '../utils/apiError';

// Mock the DB pool
vi.mock('../db/connect', () => ({
    default: {
        connect: vi.fn(),
        query: vi.fn(),
    },
}));

describe('journalService - transactional integrity', () => {
    let mockClient: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = {
            query: vi.fn(),
            release: vi.fn(),
        };
        (pool.connect as any).mockResolvedValue(mockClient);
    });

    it('successfully creates an entry and commits the transaction', async () => {
        const userId = 'user-123';
        const data = {
            date: '2024-01-01',
            description: 'Test Entry',
            lines: [
                { accountId: 'acc-1', debit: 100, credit: 0 },
                { accountId: 'acc-2', debit: 0, credit: 100 },
            ],
        };

        // Mock SQL responses
        mockClient.query.mockResolvedValueOnce({}); // BEGIN
        mockClient.query.mockResolvedValueOnce({
            rows: [{ id: 'entry-1', date: data.date, description: data.description }]
        }); // INSERT header
        mockClient.query.mockResolvedValue({}); // INSERT lines
        mockClient.query.mockResolvedValueOnce({}); // COMMIT

        const result = await journalService.createEntry(userId, data);

        expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
        expect(mockClient.release).toHaveBeenCalled();
        expect(result.id).toBe('entry-1');
    });

    it('rolls back the transaction on failure', async () => {
        const userId = 'user-123';
        const data = {
            date: '2024-01-01',
            description: 'Failed Entry',
            lines: [{ accountId: 'acc-1', debit: 100, credit: 0 }],
        };

        mockClient.query.mockResolvedValueOnce({}); // BEGIN
        mockClient.query.mockRejectedValueOnce(new Error('Internal DB Error')); // INSERT header fails

        await expect(journalService.createEntry(userId, data)).rejects.toThrow('Internal DB Error');

        expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
        expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(mockClient.release).toHaveBeenCalled();
    });

    it('throws 400 ApiError for foreign key violations (bad accountId)', async () => {
        const userId = 'user-123';
        const data = {
            date: '2024-01-01',
            description: 'FK fail',
            lines: [{ accountId: 'acc-missing', debit: 100, credit: 0 }],
        };

        const fkError = new Error('foreign key violation');
        (fkError as any).code = '23503';

        mockClient.query.mockResolvedValueOnce({}); // BEGIN
        mockClient.query.mockRejectedValueOnce(fkError);
        mockClient.query.mockResolvedValueOnce({}); // ROLLBACK

        const promise = journalService.createEntry(userId, data);

        await expect(promise).rejects.toThrow(ApiError);
        await expect(promise).rejects.toMatchObject({
            statusCode: 400,
            message: 'Invalid Account ID provided. Please refresh your accounts list.'
        });

        expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
});
