import express from "express";
import auth from "../middleware/auth";
import { generateJournalEntry, } from "../controllers/journalController";



const router = express.Router();

// router.get(
//   "/",
//   auth,
//   getAllJournalEntries
// );

// router.post(
//   "/",
//   auth,
//   createJournalEntry
// );

// router.put(
//   "/:id",
//   auth,
//   updateJournalEntry);

// router.delete(
//   "/:id",
//   auth,
//   deleteJournalEntry
// );

router.post("/generate", auth, generateJournalEntry);


export default router;
