import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reportService } from '../services/reportService';
import pool from '../db/connect';

// Mock the DB pool
vi.mock('../db/connect', () => ({
    default: {
        query: vi.fn(),
    },
}));

describe('reportService - trial balance accuracy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('calculates trial balance accurately and identifies if balanced', async () => {
        const userId = 'user-123';

        // Mock DB rows that represent a balanced trial balance
        const mockRows = [
            { id: '1', name: 'Cash', code: '1001', type: 'Asset', total_debit: '1000.00', total_credit: '500.00', net_balance: '500.00' },
            { id: '2', name: 'Sales Revenue', code: '4001', type: 'Revenue', total_debit: '0.00', total_credit: '500.00', net_balance: '500.00' }
        ];

        (pool.query as any).mockResolvedValue({ rows: mockRows });

        const result = await reportService.getTrialBalance(userId);

        expect(result.isBalanced).toBe(true);
        expect(result.totals.debit).toBe(1000.00);
        expect(result.totals.credit).toBe(1000.00);
        expect(result.data).toHaveLength(2);
    });

    it('identifies an unbalanced trial balance', async () => {
        const userId = 'user-123';

        // Mock unbalanced rows
        const mockRows = [
            { id: '1', name: 'Accounts Receivable', code: '1201', type: 'Asset', total_debit: '100.00', total_credit: '0.00', net_balance: '100.00' },
            { id: '2', name: 'Sales', code: '4001', type: 'Revenue', total_debit: '0.00', total_credit: '99.99', net_balance: '99.99' }
        ];

        (pool.query as any).mockResolvedValue({ rows: mockRows });

        const result = await reportService.getTrialBalance(userId);

        expect(result.isBalanced).toBe(false);
        expect(result.totals.debit).toBe(100.00);
        expect(result.totals.credit).toBe(99.99);
    });

    it('handles floating point precision boundaries in balancing check', async () => {
        const userId = 'user-123';

        // 0.1 + 0.2 vs 0.3
        const mockRows = [
            { id: '1', name: 'A', code: '1', type: 'Asset', total_debit: '0.1', total_credit: '0.0', net_balance: '0.1' },
            { id: '2', name: 'B', code: '2', type: 'Asset', total_debit: '0.2', total_credit: '0.0', net_balance: '0.2' },
            { id: '3', name: 'C', code: '3', type: 'Revenue', total_debit: '0.0', total_credit: '0.3', net_balance: '0.3' }
        ];

        (pool.query as any).mockResolvedValue({ rows: mockRows });

        const result = await reportService.getTrialBalance(userId);

        // totals.debit will be 0.1 + 0.2 = 0.30000000000000004
        // totals.credit will be 0.3
        // Math.abs(diff) < 0.01 should make it balanced
        expect(result.isBalanced).toBe(true);
    });
});
