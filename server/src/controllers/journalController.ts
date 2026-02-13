import {Request, Response, NextFunction} from "express";
import { JwtPayload } from "jsonwebtoken";
import ApiError from "../utils/apiError";
import pool from "../db/connect";

interface CustomJwtPayload extends JwtPayload {
  userId: string;
}

interface JournalEntryRequestBody {
    date: string;
    description: string;
    accounts: Array<any>;
}

interface CustomRequest extends Request {
  user?: CustomJwtPayload;
  body: JournalEntryRequestBody;
}


// --- getAllJournalEntries (No changes needed here) ---
export const getAllJournalEntries = async (req: CustomRequest, res: Response, next: NextFunction) => {
    if (!req.user || !('userId' in req.user)) {
      return next(new ApiError(401, "User not authorized."));
    }

    const userId = req.user.userId;

    try {
      const result = await pool.query(`SELECT id, date, description, accounts, created_at FROM journal_entries WHERE user_id = $1
        ORDER BY date DESC, created_at DESC
        `, [userId]);


    res.status(200).json({
      count: result.rows.length,
      entries: result.rows,
    });

    } catch (error) {
      next(error);
    }
};



export const createJournalEntry = async (req: CustomRequest, res: Response, next: NextFunction) => {

  if (!req.user || !('userId' in req.user)) {
    return next(new ApiError(401, "User not authenticated."));
  }

  const userId = req.user.userId;
  const {date, description, accounts} = req.body;

  // Validation: Check for required fields and minimum two accounts
  if (!date || !description || !accounts || !Array.isArray(accounts) || accounts.length < 2) {
    return next(new ApiError(400, "Missing required fields or insufficient account lines (requires at least two lines)."));
  }

  try {
    // 💡 FIX: Explicitly convert the accounts array to a JSON string.
    // This is the safest way to insert data into a JSONB column when the driver
    // encounters issues with native array parameter binding.
    const accountsJsonString = JSON.stringify(accounts); 

    const result = await pool.query(
      `INSERT INTO journal_entries (user_id, date, description, accounts)
      VALUES ($1, $2, $3, $4) 
      RETURNING id, date, description, accounts, created_at`,
      // Pass the JSON stringified version of accounts
      [userId, date, description, accountsJsonString] 
    );

      res.status(201).json({
        message: "Journal Entry created successfully.",
        entry: result.rows[0],
      });


  } catch (error) {
    // Check if the error is the JSON syntax error (22P02)
    console.error("Database Error on POST:", error);
    next(new ApiError(500, "Failed to create journal entry due to a data format issue."));
  }
}