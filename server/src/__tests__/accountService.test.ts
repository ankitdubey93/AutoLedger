import { describe, it, expect, vi, beforeEach } from 'vitest';
import { accountService } from '../services/accountService';
import pool from '../db/connect';
import ApiError from '../utils/apiError';

// Mock the DB pool
vi.mock('../db/connect', () => ({
    default: {
        query: vi.fn(),
    },
}));

describe('accountService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('fetches accounts for a user', async () => {
        const userId = 'user-123';
        const mockAccounts = [
            { id: '1', name: 'Cash', code: '1001', type: 'Asset' },
        ];

        (pool.query as any).mockResolvedValue({ rows: mockAccounts });

        const result = await accountService.getAccountsForUser(userId);

        expect(pool.query).toHaveBeenCalledWith(
            expect.stringMatching(/SELECT.*FROM accounts/is),
            [userId]
        );
        expect(result).toEqual(mockAccounts);
    });

    it('creates a new account successfully', async () => {
        const userId = 'user-123';
        const accountData = {
            name: 'Office Supplies',
            code: '5002',
            type: 'Expense',
            description: 'Stationery and ink'
        };

        const mockAccount = { id: 'acc-99', ...accountData, user_id: userId };
        (pool.query as any).mockResolvedValue({ rows: [mockAccount] });

        const result = await accountService.createAccount(userId as any, accountData as any);

        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO accounts'),
            [userId, accountData.name, accountData.code, accountData.type, accountData.description]
        );
        expect(result).toEqual(mockAccount);
    });

    it('throws 409 ApiError when account code already exists', async () => {
        const userId = 'user-123';
        const accountData = { name: 'Duplicate', code: '1001', type: 'Asset' };

        const error = new Error('unique constraint violation');
        (error as any).code = '23505';

        (pool.query as any).mockRejectedValue(error);

        await expect(accountService.createAccount(userId as any, accountData as any)).rejects.toThrow(ApiError);
        await expect(accountService.createAccount(userId as any, accountData as any)).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining("already exists")
        });
    });

    it('throws 500 ApiError for unknown database errors', async () => {
        const userId = 'user-123';
        (pool.query as any).mockRejectedValue(new Error('Boom'));

        await expect(accountService.getAccountsForUser(userId)).rejects.toThrow('Boom');
    });
});
