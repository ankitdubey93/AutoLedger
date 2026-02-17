import { Request, Response, NextFunction } from "express";
import pool from "../db/connect";
import ApiError from "../utils/apiError";

// Interface for type safety
interface AuthenticatedRequest extends Request {
    user?: { userId: string; [key: string]: any };
}

/**
 * @desc    Get all accounts for the current user
 * @route   GET /api/accounts
 */
export const getAccounts = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user?.userId) return next(new ApiError(401, "Unauthorized"));

    try {
        // Fetch accounts ordered by code (standard accounting practice)
        const result = await pool.query(
            `SELECT id, name, code, type, description 
             FROM accounts 
             WHERE user_id = $1 
             ORDER BY code ASC`,
            [req.user.userId]
        );

        res.status(200).json({
            success: true,
            count: result.rows.length,
            accounts: result.rows
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @desc    Create a new account in the Chart of Accounts
 * @route   POST /api/accounts
 */
export const createAccount = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user?.userId) return next(new ApiError(401, "Unauthorized"));

    const { name, code, type, description } = req.body;

    // Basic Validation
    if (!name || !code || !type) {
        return next(new ApiError(400, "Name, Code, and Type are required."));
    }

    // Validate Account Type against your Enum/Union type if you have one
    const validTypes = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];
    if (!validTypes.includes(type)) {
        return next(new ApiError(400, `Invalid type. Must be one of: ${validTypes.join(', ')}`));
    }

    try {
        const result = await pool.query(
            `INSERT INTO accounts (user_id, name, code, type, description)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [req.user.userId, name, code, type, description]
        );

        res.status(201).json({
            success: true,
            account: result.rows[0]
        });
    } catch (error: any) {
        // 🎯 INTERVIEW TIP: Handle the Unique Constraint violation
        if (error.code === '23505') { 
            return next(new ApiError(409, `Account code '${code}' already exists.`));
        }
        next(error);
    }
};