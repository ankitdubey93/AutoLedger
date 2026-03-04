import { Request, Response, NextFunction } from "express";
import ApiError from "../utils/apiError";
import { accountService } from "../services/accountService";



/**
 * @desc    Get all accounts for the current user
 * @route   GET /api/accounts
 */
export const getAccounts = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user?.userId) return next(new ApiError(401, "Unauthorized"));

    try {
        const accounts = await accountService.getAccountsForUser(req.user.userId);

        res.status(200).json({
            success: true,
            count: accounts.length,
            accounts
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @desc    Create a new account in the Chart of Accounts
 * @route   POST /api/accounts
 */
export const createAccount = async (req: Request, res: Response, next: NextFunction) => {
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
        const account = await accountService.createAccount(req.user.userId, { name, code, type, description });

        res.status(201).json({
            success: true,
            account
        });
    } catch (error: any) {
        next(error);
    }
};