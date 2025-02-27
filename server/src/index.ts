import express, {Request, Response} from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';
import connectDB from './db/connect';
import User from './models/User';

dotenv.config();

const app = express();

app.use(express.json());

app.use(cors());

connectDB();

app.post("/add-user", async (req: Request, res: Response) => {
    try {
      const newUser = new User({
        name: req.body.name,
        email: req.body.email,
      });
  
      const savedUser = await newUser.save();
      res.status(201).json(savedUser);
    } catch (error) {
      res.status(500).json({ error: "Failed to add user", details: error });
    }
  });

app.get("/" , (req: Request, res: Response) => {
    res.status(200).send("Hello");
})


app.listen(4000, () => {
    console.log("Server is listening on port 4000....")
})