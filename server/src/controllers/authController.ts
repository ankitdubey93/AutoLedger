import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import User from "../models/User";
import jwt from "jsonwebtoken";
import ApiError from "../utils/apiError";

const jwtSecret = process.env.JWT_SECRET as string;

export const verifyToken = (req: Request, res: Response) => {
  res.status(200).json({ message: "Token is valid", user: (req as any).user });
};

export const signup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      throw new ApiError(400, "Username and password are required");
    }

    const existingUser = await User.findOne({ username });
    if (existingUser) {
      throw new ApiError(400, "User already exists");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, password: hashedPassword });

    await newUser.save();

    res.status(201).json({ message: "User created successfully." });
  } catch (err) {
    next(err);
  }
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      throw new ApiError(400, "Username and password are required");
    }

    const user = await User.findOne({ username });
    if (!user) {
      throw new ApiError(400, "Invalid credentials");
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      throw new ApiError(400, "Invalid credentials");
    }

    const payload = { user: { id: user.id } };
    const token = jwt.sign(payload, jwtSecret, { expiresIn: "1h" });

    res.json({ token });
  } catch (err) {
    next(err);
  }
};

export const getUserById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      throw new ApiError(404, "User not found");
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
