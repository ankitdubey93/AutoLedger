import mongoose, { Schema, Document } from "mongoose";
import { User } from "./User";

export interface AccountEntry {
  accountName: string;
  debit: number;
  credit: number;
}

export interface JournalEntry extends Document {
  date: Date;
  description: string;  
  accounts: AccountEntry[];
  userId: User["_id"];
}

const JournalEntrySchema: Schema = new Schema({
  date: { type: Date, required: true },
  description: { type: String, required: true },
  accounts: [
    {
      accountName: { type: String, required: true },
      debit: { type: Number, required: true, default: 0 },
      credit: { type: Number, required: true, default: 0 },
    },
  ],
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, {timestamps: true});

export default mongoose.model<JournalEntry>("JournalEntry", JournalEntrySchema);
