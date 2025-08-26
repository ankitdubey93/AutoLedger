import mongoose from "mongoose";

const RefreshTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  token: {
    type: String,
    required: true,
  },
  createdAt: { type: Date, default: Date.now, expires: "7d" },
});

export const RefreshToken = mongoose.model("RefreshToken", RefreshTokenSchema);
