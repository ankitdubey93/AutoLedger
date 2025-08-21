import {Request, Response, NextFunction} from "express";
import bcrypt from "bcryptjs";
import User from "../models/User";
import jwt from "jsonwebtoken";


const jwtSecret = process.env.JWT_SECRET as string;


export const verifyToken = (req: Request, res: Response) => {
  res.status(200).json({ message: "Token is valid", user: (req as any).user });
};

export const signup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = req.body;

    const existingUser = await User.findOne({ username });
    if (existingUser) {
        res.status(400).json({ message: "User already exists" });
        return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, password: hashedPassword });

    await newUser.save();

    res.status(201).json({ message: "User created successfully." });
  } catch (err) {
    next(err); // <-- Pass to error middleware
  }
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = req.body;

    const user = await User.findOne({ username });
    if (!user) {
        res.status(400).json({ message: "Invalid credentials." });
        return;
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
        res.status(400).json({ message: "Invalid credentials." });
        return;
    }

    const payload = { user: { id: user.id } };
    const token = jwt.sign(payload, jwtSecret, { expiresIn: "1h" });

    res.json({ token });
  } catch (err) {
    next(err); // <-- Pass to error middleware
  }
};

export const getUserById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
        res.status(404).json({ message: "User not found." });
        return;
    }
    res.status(200).json(user);
  } catch (err) {
    next(err);
  }
};

// Dev-only route
export const getAllUsers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await User.find();
    res.json(users);
  } catch (err) {
    next(err);
  }
};