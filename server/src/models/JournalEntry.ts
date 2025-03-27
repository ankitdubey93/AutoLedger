import mongoose, { Schema, Document } from "mongoose";

interface AccountEntry {
  accountName: string;
  debit: number;
  credit: number;
}

interface JournalEntry extends Document {
  date: Date;
  description: string;
  accounts: AccountEntry[];
  userId: mongoose.Schema.Types.ObjectId;
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
});

export default mongoose.model<JournalEntry>("JournalEntry", JournalEntrySchema);
