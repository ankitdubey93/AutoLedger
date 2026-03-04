import pool from "../db/connect";

export const reportService = {
    /**
     * Calculates the trial balance for a user.
     * Sums debits and credits per account and computes the net balance.
     */
    async getTrialBalance(userId: string) {
        const query = `
            SELECT 
                a.id,
                a.code,
                a.name,
                a.type,
                COALESCE(SUM(ll.debit), 0) as total_debit,
                COALESCE(SUM(ll.credit), 0) as total_credit,
                -- Calculate Net Balance based on Account Type
                CASE 
                    WHEN a.type IN ('Asset', 'Expense') THEN COALESCE(SUM(ll.debit), 0) - COALESCE(SUM(ll.credit), 0)
                    ELSE COALESCE(SUM(ll.credit), 0) - COALESCE(SUM(ll.debit), 0)
                END as net_balance
            FROM accounts a
            LEFT JOIN ledger_lines ll ON a.id = ll.account_id
            WHERE a.user_id = $1
            GROUP BY a.id, a.code, a.name, a.type
            ORDER BY a.code ASC;
        `;

        const result = await pool.query(query, [userId]);

        // Calculate Totals for the Footer
        const totals = result.rows.reduce((acc, row) => {
            return {
                debit: acc.debit + Number(row.total_debit),
                credit: acc.credit + Number(row.total_credit)
            };
        }, { debit: 0, credit: 0 });

        // Financial Integrity Check
        const isBalanced = Math.abs(totals.debit - totals.credit) < 0.01;

        return {
            isBalanced,
            totals,
            data: result.rows
        };
    }
};
