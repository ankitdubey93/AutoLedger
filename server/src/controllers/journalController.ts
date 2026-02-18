import { Request, Response, NextFunction } from "express";
import pool from "../db/connect";
import ApiError from "../utils/apiError";

// --- Interfaces for Type Safety ---

// 1. Extend Express Request to include User (from Auth Middleware)
interface AuthenticatedRequest extends Request {
    user?: {
        userId: string;
        [key: string]: any;
    };
}

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
    req: AuthenticatedRequest, 
    res: Response, 
    next: NextFunction
) => {
    // Security: Ensure user is authenticated
    if (!req.user || !req.user.userId) {
        return next(new ApiError(401, "User not authorized."));
    }

    const userId = req.user.userId;
    // Cast the body to our interface for type safety
    const { date, description, lines } = req.body as CreateJournalEntryBody;

    // --- VALIDATION LAYER ---
    
    // 1. Basic Fields
    if (!date || !description || !lines || !Array.isArray(lines) || lines.length < 2) {
        return next(new ApiError(400, "Missing required fields or insufficient lines (minimum 2 required)."));
    }

    // 2. Financial Validation (The "Accora" Logic)
    // We use a small epsilon (0.01) to handle floating point variations safely
    const totalDebit = lines.reduce((sum, line) => sum + Number(line.debit), 0);
    const totalCredit = lines.reduce((sum, line) => sum + Number(line.credit), 0);
    
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return next(new ApiError(400, `Entry is unbalanced. Total Debit: ${totalDebit}, Total Credit: ${totalCredit}`));
    }

    // --- DATABASE LAYER (Transactional) ---
    
    // We must use a single client for transactions, not the pool directly
    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // Starting ACID Transaction

        // Step 1: Insert the Header (Journal Entry)
        const entryResult = await client.query(
            `INSERT INTO journal_entries (user_id, date, description, source_type)
             VALUES ($1, $2, $3, 'manual')
             RETURNING id, date, description, created_at`,
            [userId, date, description]
        );
        const journalEntryId = entryResult.rows[0].id;

        // Step 2: Insert the Ledger Lines
        // We map over the lines and insert them one by one linked to the header ID
        for (const line of lines) {
            // Check constraint: At least one side must be > 0
            if (line.debit <= 0 && line.credit <= 0) {
                throw new Error("Line items must have a value greater than 0.");
            }

            await client.query(
                `INSERT INTO ledger_lines (journal_entry_id, account_id, user_id, debit, credit)
                 VALUES ($1, $2, $3, $4, $5)`,
                [journalEntryId, line.accountId, userId, line.debit, line.credit]
            );
        }

        await client.query('COMMIT'); // Commit changes to disk

        res.status(201).json({
            success: true,
            message: "Journal Entry posted successfully.",
            entry: entryResult.rows[0]
        });

    } catch (error: any) {
        await client.query('ROLLBACK'); // Critical: Undo everything if error occurs
        console.error("Transaction Failed:", error);
        
        // Handle Foreign Key violation (e.g., invalid accountId)
        if (error.code === '23503') {
            return next(new ApiError(400, "Invalid Account ID provided. Please refresh your accounts list."));
        }
        
        next(new ApiError(500, error.message || "Failed to create journal entry."));
    } finally {
        client.release(); // Return client to pool
    }
};

/**
 * @desc    Get all Journal Entries with their lines and account names
 * @route   GET /api/journals
 * @access  Private
 */
export const getAllJournalEntries = async (
    req: AuthenticatedRequest, 
    res: Response, 
    next: NextFunction
) => {
    if (!req.user || !req.user.userId) {
        return next(new ApiError(401, "User not authorized."));
    }
    const userId = req.user.userId;

    try {
        // --- COMPLEX SQL QUERY ---
        // This query joins entries, lines, and accounts.
        // It uses JSON_AGG to nest the lines inside the entry object.
        // This is much faster than doing a separate query for every single entry.
        
        const query = `
            SELECT 
                je.id,
                je.date,
                je.description,
                je.source_type,
                je.created_at,
                -- Aggregate lines into a JSON array
                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'id', ll.id,
                            'accountId', ll.account_id,
                            'accountName', a.name,   -- Get the readable name from Accounts table
                            'accountCode', a.code,   -- Get the code (e.g., 1001)
                            'debit', ll.debit,
                            'credit', ll.credit
                        ) ORDER BY ll.debit DESC     -- Show Debits first for standard accounting view
                    ), 
                    '[]'
                ) AS lines
            FROM journal_entries je
            LEFT JOIN ledger_lines ll ON je.id = ll.journal_entry_id
            LEFT JOIN accounts a ON ll.account_id = a.id
            WHERE je.user_id = $1
            GROUP BY je.id
            ORDER BY je.date DESC, je.created_at DESC
        `;

        const result = await pool.query(query, [userId]);

        res.status(200).json({
            success: true,
            count: result.rows.length,
            entries: result.rows,
        });

    } catch (error) {
        console.error("Get Entries Error:", error);
        next(new ApiError(500, "Failed to fetch journal entries."));
    }
};