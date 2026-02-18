import { Request, Response, NextFunction } from "express";
import pool from "../db/connect";
import ApiError from "../utils/apiError";

// Reuse the interface we created earlier
interface AuthenticatedRequest extends Request {
    user?: { userId: string; [key: string]: any };
}

export const getTrialBalance = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user?.userId) return next(new ApiError(401, "Unauthorized"));

    const userId = req.user.userId;

    try {
        //  COMPLEX SQL: Aggregation & Grouping
        // We join Accounts with Ledger Lines to sum up the values.
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

        res.status(200).json({
            success: true,
            isBalanced,
            totals,
            data: result.rows
        });

    } catch (error) {
        next(error);
    }
};