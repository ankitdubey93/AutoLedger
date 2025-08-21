import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import cors from "cors";
import connectDB from "./db/connect";
import journalEntryRoutes from "./routes/journalEntries";
import authRoute from "./routes/auth";
import  errorHandler  from "./middleware/errorHandler";
import ApiError from "./utils/apiError";

dotenv.config();

const app = express();
const PORT = process.env.PORT;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cors());

connectDB();


app.use("/api/journal-entries", journalEntryRoutes);
app.use("/api/auth", authRoute);

// Example 404 route handler
app.all("*", (req, res, next) => {
  next(new ApiError(404, `Route ${req.originalUrl} not found`));
});

// Centralized error handling
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server is listening on port: ${PORT}....`);
});
