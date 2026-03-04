import { Request, Response, NextFunction } from "express";
import ApiError from "../utils/apiError";
import { journalService } from "../services/journalService";



// 2. Define the expected structure of a Line Item from Frontend
interface JournalLineInput {
    accountId: string; // The UUID of the account (e.g., Cash, Sales)
    debit: number;
    credit: number;
}

// 3. Define the Body of the POST Request
interface CreateJournalEntryBody {
    date: string;
    description: string;
    lines: JournalLineInput[];
}

// --- Controller Functions ---

/**
 * @desc    Create a new Manual Journal Entry (Strict Double-Entry)
 * @route   POST /api/journals
 * @access  Private
 */
export const createJournalEntry = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    // Security: Ensure user is authenticated
    if (!req.user || !req.user.userId) {
        return next(new ApiError(401, "User not authorized."));
    }

    const userId = req.user.userId;
    const { date, description, lines } = req.body as CreateJournalEntryBody;

    // --- VALIDATION LAYER ---

    // 1. Basic Fields
    if (!date || !description || !lines || !Array.isArray(lines) || lines.length < 2) {
        return next(new ApiError(400, "Missing required fields or insufficient lines (minimum 2 required)."));
    }

    // 2. Financial Validation — integer cents to eliminate floating-point errors
    const toCents = (n: number) => Math.round(Number(n) * 100);
    const totalDebitCents = lines.reduce((sum, line) => sum + toCents(line.debit), 0);
    const totalCreditCents = lines.reduce((sum, line) => sum + toCents(line.credit), 0);

    if (totalDebitCents !== totalCreditCents) {
        return next(new ApiError(400, `Entry is unbalanced. Total Debit: ${totalDebitCents}¢, Total Credit: ${totalCreditCents}¢`));
    }

    // 3. Line-Level Validation (Mutual Exclusion & Zero Check)
    for (const line of lines) {
        if (line.debit <= 0 && line.credit <= 0) {
            return next(new ApiError(400, "A ledger line must have a debit or credit value greater than 0."));
        }
        if (line.debit > 0 && line.credit > 0) {
            return next(new ApiError(400, "A ledger line cannot have both a debit and a credit."));
        }
    }

    // --- SERVICE LAYER ---
    try {
        const entry = await journalService.createEntry(userId, { date, description, lines });

        res.status(201).json({
            success: true,
            message: "Journal Entry posted successfully.",
            entry
        });

    } catch (error: any) {
        if (error instanceof ApiError) {
            return next(error);
        }
        next(new ApiError(500, error.message || "Failed to create journal entry."));
    }
};

/**
 * @desc    Get all Journal Entries with their lines and account names
 * @route   GET /api/journals
 * @access  Private
 */
export const getAllJournalEntries = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (!req.user || !req.user.userId) {
        return next(new ApiError(401, "User not authorized."));
    }
    const userId = req.user.userId;

    try {
        // Parse pagination parameters
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        let limit = Math.max(1, parseInt(req.query.limit as string) || 20);
        if (limit > 100) limit = 100; // Enforce max limit

        const { entries, totalCount } = await journalService.getEntriesForUser(userId, page, limit);

        const totalPages = Math.ceil(totalCount / limit);

        res.status(200).json({
            success: true,
            count: entries.length,
            totalCount,
            currentPage: page,
            totalPages,
            entries,
        });

    } catch (error) {
        next(new ApiError(500, "Failed to fetch journal entries."));
    }
};