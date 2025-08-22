import {Request, Response, NextFunction} from "express";
import JournalEntry from "../models/JournalEntry";
import { JwtPayload } from "jsonwebtoken";
import ApiError from "../utils/apiError";

interface CustomRequest extends Request {
  user?: JwtPayload;
}

export const getAllJournalEntries =  async (
    req: CustomRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const userId = req.user?.user.id;
      if(!userId) {
        throw new ApiError(401,"Unauthorized.");
      }


      const journalEntries = await JournalEntry.find({ userId });
      res.status(200).json(journalEntries);
    } catch (err) {
      next(err);
    }
  };


  export const createJournalEntry = async (
  req: CustomRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { date, description, accounts } = req.body;

    if (!Array.isArray(accounts) || accounts.length < 2) {
      throw new ApiError(400, "A journal entry must have at least two accounts.");
    }

    const userId = req.user?.user.id;
    if (!userId) {
      throw new ApiError(401, "Unauthorized");
    }

    const newEntry = new JournalEntry({
      date,
      description,
      accounts,
      userId,
    });

    await newEntry.save();
    res.status(201).json({ message: "Journal entry added successfully." });
  } catch (err) {
    next(err);
  }
};

export const updateJournalEntry = async (
  req: CustomRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { date, description, accounts } = req.body;
    const journalEntry = await JournalEntry.findById(req.params.id);

    if (!journalEntry) {
      throw new ApiError(404, "Journal entry not found");
    }

    if (journalEntry.userId.toString() !== req.user?.user.id) {
      throw new ApiError(403, "Unauthorized");
    }

    await JournalEntry.findByIdAndUpdate(
      req.params.id,
      { date, description, accounts },
      { new: true }
    );

    res.status(202).json({ message: "Journal entry updated successfully." });
  } catch (err) {
    next(err);
  }
};

export const deleteJournalEntry = async (
  req: CustomRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const journalEntry = await JournalEntry.findById(req.params.id);

    if (!journalEntry) {
      throw new ApiError(404, "Journal entry not found");
    }

    if (journalEntry.userId.toString() !== req.user?.user.id) {
      throw new ApiError(403, "Unauthorized");
    }

    await JournalEntry.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "Journal entry deleted successfully." });
  } catch (err) {
    next(err);
  }
};


