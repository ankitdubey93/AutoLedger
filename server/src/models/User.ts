import mongoose from "mongoose";


export interface User extends Document {
    _id: mongoose.Types.ObjectId;
    name: string;
    email: string;
    password: string;
    emailVerified: boolean;
    emailVerificationToken: string | null;
    emailVerificationTokenExpires: Date | null;
    passwordResetToken: string | null;
    passwordResetTokenExpires: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, required: true },
     emailVerified: { type: Boolean, default: false },
    emailVerificationToken: { type: String, default: null },
    emailVerificationTokenExpires: { type: Date, default: null },
    passwordResetToken: { type: String, default: null },
    passwordResetTokenExpires: { type: Date, default: null },
    
},   { timestamps: true });

export const User = mongoose.model<User>("User", userSchema);
