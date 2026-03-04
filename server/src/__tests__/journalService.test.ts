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

// Mock CSV utilities so tests stay pure (no filesystem I/O).
// vi.mock factories are hoisted to the top of the file, so we must declare
// the spies with vi.hoisted() to make them accessible inside the factory.
const { mockAppendToCsv, mockInvalidateCsvCache } = vi.hoisted(() => ({
    mockAppendToCsv: vi.fn(),
    mockInvalidateCsvCache: vi.fn(),
}));
vi.mock('../utils/csvParser', () => ({ appendToCsv: mockAppendToCsv }));
vi.mock('../utils/ruleEngine', () => ({ invalidateCsvCache: mockInvalidateCsvCache }));

describe('journalService - transactional integrity', () => {
    let mockClient: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = {
            query: vi.fn(),
            release: vi.fn(),
        };
        (pool.connect as any).mockResolvedValue(mockClient);
        // Default: top-level pool.query (used for account name lookup) returns empty rows
        (pool.query as any).mockResolvedValue({ rows: [] });
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

// ── Self-Learning CSV Append ──────────────────────────────────────────────────

describe('journalService - CSV self-learning', () => {
    let mockClient: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = {
            query: vi.fn(),
            release: vi.fn(),
        };
        (pool.connect as any).mockResolvedValue(mockClient);
        (pool.query as any).mockResolvedValue({ rows: [] });
    });

    /** Reusable helper: sets up mockClient to succeed through COMMIT */
    function setupSuccessfulCommit(description = 'Test Entry') {
        mockClient.query.mockResolvedValueOnce({}); // BEGIN
        mockClient.query.mockResolvedValueOnce({
            rows: [{ id: 'entry-1', date: '2024-01-01', description }]
        }); // INSERT header
        mockClient.query.mockResolvedValue({}); // INSERT lines + COMMIT
    }

    it('appends to CSV and invalidates cache for a simple 2-line entry', async () => {
        setupSuccessfulCommit('Paid rent for January');

        // Account name lookup returns both accounts
        (pool.query as any).mockResolvedValueOnce({
            rows: [
                { id: 'acc-1', name: 'Rent Expense' },
                { id: 'acc-2', name: 'Bank' },
            ],
        });

        await journalService.createEntry('user-1', {
            date: '2024-01-01',
            description: 'Paid rent for January',
            lines: [
                { accountId: 'acc-1', debit: 1500, credit: 0 },
                { accountId: 'acc-2', debit: 0, credit: 1500 },
            ],
        });

        expect(mockAppendToCsv).toHaveBeenCalledOnce();
        expect(mockAppendToCsv).toHaveBeenCalledWith(
            'Paid rent for January',
            'Rent Expense',
            'Bank',
            1500,
        );
        expect(mockInvalidateCsvCache).toHaveBeenCalledOnce();
    });

    it('does NOT append to CSV for compound entries (more than 2 lines)', async () => {
        mockClient.query.mockResolvedValueOnce({}); // BEGIN
        mockClient.query.mockResolvedValueOnce({
            rows: [{ id: 'entry-2', date: '2024-01-01', description: 'Compound entry' }]
        }); // INSERT header
        mockClient.query.mockResolvedValue({}); // INSERT lines + COMMIT

        await journalService.createEntry('user-1', {
            date: '2024-01-01',
            description: 'Compound entry',
            lines: [
                { accountId: 'acc-1', debit: 100, credit: 0 },
                { accountId: 'acc-2', debit: 200, credit: 0 },
                { accountId: 'acc-3', debit: 0,   credit: 300 },
            ],
        });

        expect(mockAppendToCsv).not.toHaveBeenCalled();
        expect(mockInvalidateCsvCache).not.toHaveBeenCalled();
    });

    it('does NOT append to CSV when description is empty', async () => {
        setupSuccessfulCommit('');

        await journalService.createEntry('user-1', {
            date: '2024-01-01',
            description: '   ',          // whitespace-only counts as empty
            lines: [
                { accountId: 'acc-1', debit: 500, credit: 0 },
                { accountId: 'acc-2', debit: 0,   credit: 500 },
            ],
        });

        expect(mockAppendToCsv).not.toHaveBeenCalled();
    });

    it('still returns success if CSV append throws (non-fatal)', async () => {
        setupSuccessfulCommit('Paid office supplies');

        (pool.query as any).mockResolvedValueOnce({
            rows: [
                { id: 'acc-1', name: 'Office Supplies Expense' },
                { id: 'acc-2', name: 'Cash' },
            ],
        });

        // Simulate a filesystem error in appendToCsv
        mockAppendToCsv.mockImplementationOnce(() => { throw new Error('EACCES: permission denied'); });

        const result = await journalService.createEntry('user-1', {
            date: '2024-01-01',
            description: 'Paid office supplies',
            lines: [
                { accountId: 'acc-1', debit: 200, credit: 0 },
                { accountId: 'acc-2', debit: 0,   credit: 200 },
            ],
        });

        // Entry must still be saved successfully
        expect(result.id).toBe('entry-1');
        // Cache should NOT have been invalidated since append failed
        expect(mockInvalidateCsvCache).not.toHaveBeenCalled();
    });

    it('skips CSV append when account name lookup returns partial results', async () => {
        setupSuccessfulCommit('Mystery entry');

        // Only one account name found (the other ID is unknown)
        (pool.query as any).mockResolvedValueOnce({
            rows: [{ id: 'acc-1', name: 'Rent Expense' }],
            // acc-2 is missing from result
        });

        await journalService.createEntry('user-1', {
            date: '2024-01-01',
            description: 'Mystery entry',
            lines: [
                { accountId: 'acc-1', debit: 750, credit: 0 },
                { accountId: 'acc-2', debit: 0,   credit: 750 },
            ],
        });

        // creditName would be undefined → guard prevents append
        expect(mockAppendToCsv).not.toHaveBeenCalled();
        expect(mockInvalidateCsvCache).not.toHaveBeenCalled();
    });
});
