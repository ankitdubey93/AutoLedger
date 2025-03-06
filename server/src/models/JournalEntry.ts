import mongoose,{Schema,Document} from 'mongoose';

interface IJournalEntryLine {
    account: string;
    debit: number;
    credit: number;
}

interface IJournalEntry extends Document {
    date: Date;
    description: string;
    lines: IJournalEntryLine[];
    userId: mongoose.Schema.Types.ObjectId;
}

const JournalEntrySchema: Schema = new Schema({
    date: {type: Date, required: true},
    description: {type: String, required: true},
    lines: [
        {
            account: {type: String, required: true},
            debit: {type: Number, required: true, default: 0},
            credit: {type: Number, required: true, default:0},
        },
    ],
    userId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
});

export default mongoose.model<IJournalEntry>('JournalEntry', JournalEntrySchema);