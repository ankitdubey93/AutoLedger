import {Request, Response, NextFunction} from "express";

import { JwtPayload } from "jsonwebtoken";
import ApiError from "../utils/apiError";
import { parseTransactionText } from "../utils/parseTransaction";
import pool from "../db/connect";

interface CustomRequest extends Request {
  user?: JwtPayload;
}


export const generateJournalEntry = async (
  req: CustomRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const {text} = req.body;

    if(!text || typeof text !== "string") {
      throw new ApiError(400, "Transaction text is required.")
    } 


    const userId = req.user?.userId;

    if(!userId){
      throw new ApiError(401, "Unauthorized.");

    }


    const {description, accounts} = parseTransactionText(text);

    if(!accounts || accounts.length < 2) {
      throw new ApiError(400, "Unable to determine debit and credit accounts from text.");
    }


     const query = `
      INSERT INTO journal_entries (user_id, date, description, accounts)
      VALUES ($1, NOW(), $2, $3)
      RETURNING *;
    `;

    const values = [userId, description, JSON.stringify(accounts)];

    
    const result = await pool.query(query, values);


    res.status(201).json({
      message: "Journal entry generated succesfully.",
      entry: result.rows[0],
    });


  } catch (error){
    next(error);
  }
}