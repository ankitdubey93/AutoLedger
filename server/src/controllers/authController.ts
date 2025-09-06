import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import pool from "../db/connect";
import jwt from "jsonwebtoken";
import ApiError from "../utils/apiError";
import crypto from "crypto";
import { generateAccessToken, generateRefreshToken } from "../utils/jwt";


const jwtSecret = process.env.JWT_SECRET as string;


const accessTokenCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 15 * 60 * 1000,
}

const refreshTokenCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
}

const TOKEN_EXPIRY_5_HOURS = 1000 * 60 * 60 * 5;

export const register = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email,  password } = req.body;

    if (!name || !email || !password) {
      throw new ApiError(400, "All fields are required");
    }

    const existingUser = await pool.query(
      "SELECT * FROM users WHERE LOWER(email) = LOWER($1)",
      [email]
    );

    
    if (existingUser.rowCount && existingUser.rowCount > 0 ) {
      throw new ApiError(400, "User already exists");
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const token = crypto.randomBytes(32).toString("hex");

   const result = await pool.query(
  `INSERT INTO users
    (name, email, password, email_verification_token, email_verification_token_expires)
   VALUES ($1, $2, $3, $4, $5)
   RETURNING id, name, email`,
  [name, email, hashedPassword, token, new Date(Date.now() + TOKEN_EXPIRY_5_HOURS)]
);

  const newUser = result.rows[0];



    const accessToken = generateAccessToken(newUser.id.toString());
    const refreshToken = generateRefreshToken(newUser.id.toString());
        
        
       await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, created_at)
       VALUES ($1, $2, NOW())`,
      [newUser.id, refreshToken]
    );
        res.cookie("accessToken", accessToken, accessTokenCookieOptions);
        res.cookie("refreshToken", refreshToken, refreshTokenCookieOptions);


    res.status(201).json({ message: "User created successfully." , 
      user: {_id: newUser._id, name: newUser.name, email: newUser.email}
    });
  } catch (err) {
    next(err);
  }
};

 export const login = async (req: Request, res: Response, next: NextFunction) => {
 try {
     const { email, password } = req.body;

     if (!email || !password) {
       throw new ApiError(400, "Username and password are required");
     }

     const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
     const user = result.rows[0];
    
   if (!user) {
       throw new ApiError(400, "Invalid credentials");
     }

     const isMatch = await bcrypt.compare(password, user.password);
     if (!isMatch) {
       throw new ApiError(400, "Invalid credentials");
     }

    const accessToken = generateAccessToken(user.id.toString());
    const refreshToken = generateRefreshToken(user.id.toString());

    await pool.query(`INSERT INTO refresh_tokens (user_id, token, created_at) VALUES ($1,$2, NOW())`, [user.id, refreshToken]);

        res.cookie("accessToken", accessToken, accessTokenCookieOptions);
        res.cookie("refreshToken", refreshToken, refreshTokenCookieOptions);

    res.status(200).json({
      user: {
        id: user.id, name: user.name, email: user.email
      },
    })
  } catch (err) {
    next(err);
  }
};

export const checkUser = async (req: Request, res: Response, next: NextFunction) => {
  const accessToken = req.cookies?.accessToken;
 
  if(!accessToken) {
  res.status(401).json({message: "Not Authenticated."})
  return;
  }

  try {
    const payload = jwt.verify(
      accessToken, 
      process.env.ACCESS_TOKEN_SECRET as string,
    ) as {userId: string};

    const result = await pool.query(
      "SELECT id, name, email, email_verified FROM users WHERE id=$1", [payload.userId]
    );
    const user = result.rows[0];

    if(!user) {
      res.status(404).json({message: "User not found."})
      return;
    }

    res.status(200).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
      }
    });


  } catch (error) {
    next(error);
  }
};


export const refreshUser = async (req: Request, res: Response, next: NextFunction) => {
  const refreshToken = req.cookies?.refreshToken;

  if(!refreshToken) {
    res.status(400).json({
      message: "Refresh token is required."
    })
    return;
  }

  try {
    const result = await pool.query(
      "SELECT * FROM refresh_tokens WHERE token=$1",
      [refreshToken]
    );

    const storedToken = result.rows[0];

    if(!storedToken) {
      res.status(403).json({
        message: "Invalid refresh token."
      })
      return;
    }

    const payload = jwt.verify(
      refreshToken, 
      process.env.REFRESH_TOKEN_SECRET as string,
    ) as {userId: string};

    const newAccessToken = generateAccessToken(payload.userId);
    res.cookie("accessToken", newAccessToken, accessTokenCookieOptions);
    res.status(200).json({message: "Access token refreshed."})
  } catch (error) {
    next(error);
  }
};


