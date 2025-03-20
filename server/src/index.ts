import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import cors from "cors";
import connectDB from "./db/connect";
import userRoutes from "./routes/users";
import journalEntryRoutes from "./routes/journalEntries";
import authRoute from "./routes/auth";

dotenv.config();

const app = express();
const PORT = process.env.PORT;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cors());

connectDB();

app.use("/api/users", userRoutes);
app.use("/api/journal-entries", journalEntryRoutes);
app.use("/api/auth", authRoute);

// Error-handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error(err.stack); // Log the error stack
  res.status(500).json({ message: "Internal Server Error" }); // Send a generic error response
});

app.listen(PORT, () => {
  console.log(`Server is listening on port: ${PORT}....`);
});
