import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createJournalEntry, AuthenticatedRequest } from '../controllers/journalController';
import pool from '../db/connect';
import ApiError from '../utils/apiError';

// Mock the DB pool
vi.mock('../db/connect', () => ({
    default: {
        connect: vi.fn(),
        query: vi.fn(),
    },
}));

const mockRequest = (body: any = {}): AuthenticatedRequest => ({
    user: { userId: 'user-123' },
    body,
} as AuthenticatedRequest);

const mockResponse = (): Partial<Response> => ({
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
});

const mockNext = (): NextFunction => vi.fn();

describe('journalController - double entry hardening', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects unbalanced entries (cents arithmetic check)', async () => {
        // 0.1 + 0.2 = 0.30000000000000004 in float
        // But our cents logic should handle it. Let's send something clearly unbalanced in cents.
        const req = mockRequest({
            date: '2024-01-01',
            description: 'Unbalanced',
            lines: [
                { accountId: 'acc-1', debit: 100.00, credit: 0 },
                { accountId: 'acc-2', debit: 0, credit: 99.99 }, // 1 cent difference
            ],
        });
        const res = mockResponse();
        const next = mockNext();

        await createJournalEntry(req as AuthenticatedRequest, res as Response, next);

        expect(next).toHaveBeenCalledWith(expect.any(ApiError));
        const error = (next as any).mock.calls[0][0];
        expect(error.statusCode).toBe(400);
        expect(error.message).toContain('Entry is unbalanced');
        expect(error.message).toContain('10000¢');
        expect(error.message).toContain('9999¢');
    });

    it('accepts float-precise entries that would fail simple epsilon check but pass cents rounding', async () => {
        // 0.1 + 0.2 = 0.30000000000000004
        const client = {
            query: vi.fn()
                .mockResolvedValueOnce({}) // BEGIN
                .mockResolvedValueOnce({ rows: [{ id: 'entry-123', date: '2024-01-01', description: 'Float test', created_at: new Date() }] }) // INSERT header
                .mockResolvedValue({}), // INSERT lines
            release: vi.fn(),
        };
        (pool.connect as any).mockResolvedValue(client);
        (pool.query as any).mockResolvedValue({ rows: [{ id: 'entry-123' }] });

        const req = mockRequest({
            date: '2024-01-01',
            description: 'Float test',
            lines: [
                { accountId: 'acc-1', debit: 0.1, credit: 0 },
                { accountId: 'acc-2', debit: 0.2, credit: 0 },
                { accountId: 'acc-3', debit: 0, credit: 0.3 },
            ],
        });
        const res = mockResponse();
        const next = mockNext();

        await createJournalEntry(req as AuthenticatedRequest, res as Response, next);

        // Should not call next with error
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(201);
        expect(client.query).toHaveBeenCalledWith('BEGIN');
        expect(client.query).toHaveBeenCalledWith('COMMIT');
    });

    it('rejects lines that have both debit and credit > 0', async () => {
        const req = mockRequest({
            date: '2024-01-01',
            description: 'Mutual Exclusion Fail',
            lines: [
                { accountId: 'acc-1', debit: 100, credit: 100 }, // Invalid
                { accountId: 'acc-2', debit: 0, credit: 0 },     // Also invalid (checked later)
            ],
        });
        const res = mockResponse();
        const next = mockNext();

        await createJournalEntry(req as AuthenticatedRequest, res as Response, next);

        expect(next).toHaveBeenCalledWith(expect.any(ApiError));
        const error = (next as any).mock.calls[0][0];
        expect(error.statusCode).toBe(400);
        expect(error.message).toBe('A ledger line cannot have both a debit and a credit.');
    });

    it('rejects lines that have neither debit nor credit > 0', async () => {
        const req = mockRequest({
            date: '2024-01-01',
            description: 'Zero lines',
            lines: [
                { accountId: 'acc-1', debit: 100, credit: 0 },
                { accountId: 'acc-2', debit: 0, credit: 100 },
                { accountId: 'acc-3', debit: 0, credit: 0 }, // Invalid
            ],
        });
        const res = mockResponse();
        const next = mockNext();

        await createJournalEntry(req as AuthenticatedRequest, res as Response, next);

        expect(next).toHaveBeenCalledWith(expect.any(ApiError));
        const error = (next as any).mock.calls[0][0];
        expect(error.statusCode).toBe(400);
        expect(error.message).toBe('A ledger line must have a debit or credit value greater than 0.');

        // Should NOT call pool.connect
        expect(pool.connect).not.toHaveBeenCalled();
    });
});
