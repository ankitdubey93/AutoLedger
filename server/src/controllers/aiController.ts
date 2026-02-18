import { Request, Response, NextFunction } from "express";
import pool from "../db/connect";
import ApiError from "../utils/apiError";
import { parseTransaction } from "../utils/ruleEngine"; // Import the engine

export const analyzeTransaction = async (req: any, res: Response, next: NextFunction) => {
    const { sentence } = req.body;
    const userId = req.user?.userId;

    try {
        // Fetch real accounts from DB to pass to the rule engine
        const accountsResult = await pool.query(
            "SELECT id, name, code, type FROM accounts WHERE user_id = $1",
            [userId]
        );
        
        // Using the rule engine instead of Gemini
        const suggestion = parseTransaction(sentence, accountsResult.rows);

        res.status(200).json({ success: true, suggestion });
    } catch (error: any) {
        console.error("Rule Engine Error:", error.message);
        next(new ApiError(400, error.message || "Could not process transaction."));
    }
};