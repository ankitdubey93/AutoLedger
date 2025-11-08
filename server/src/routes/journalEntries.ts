import express from "express";
import auth from "../middleware/auth";
import { createJournalEntry, getAllJournalEntries } from "../controllers/journalController";



const router = express.Router();

 router.get(
   "/",
   auth,
   getAllJournalEntries
 );

router.post(
  "/",
  auth,
  createJournalEntry
);

// router.put(
//   "/:id",
//   auth,
//   updateJournalEntry);

// router.delete(
//   "/:id",
//   auth,
//   deleteJournalEntry
// );



export default router;
