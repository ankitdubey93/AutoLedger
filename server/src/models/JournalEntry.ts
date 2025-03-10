import mongoose,{Schema,Document} from 'mongoose';


interface JournalEntry extends Document {
    date: Date;
    description: string;
    amount: number;
    userId: mongoose.Schema.Types.ObjectId;
    
}

const JournalEntrySchema: Schema = new Schema({
    date: {type: Date, required: true},
    description: {type: String, required: true},
    amount: {type: Number, required: true},
    userId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
});

export default mongoose.model<JournalEntry>('JournalEntry', JournalEntrySchema);