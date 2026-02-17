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
  secure: false, // always false in dev
  sameSite: "lax" as const,
  path: "/",
};

const refreshTokenCookieOptions = {
  httpOnly: true,
  secure: false,
  sameSite: "strict" as const,
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

const clearCookieOptions = {
  httpOnly: true,
  secure: false,
  sameSite: 'lax' as const,
  path: '/',
};

const TOKEN_EXPIRY_5_HOURS = 1000 * 60 * 60 * 5;

export const register = async (req: Request, res: Response, next: NextFunction) => {
  
    const { name, email,  password } = req.body;

    if (!name || !email || !password) {
      throw new ApiError(400, "All fields are required");
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      
      const existingUser = await pool.query(
        "SELECT * FROM users WHERE LOWER(email) = LOWER($1)",
        [email]
      );

      if (existingUser.rowCount && existingUser.rowCount > 0 ) {
        throw new ApiError(400, "User already exists");
      }
  
      const hashedPassword = await bcrypt.hash(password, 10);
  
      const verificationToken = crypto.randomBytes(32).toString("hex");
     
      const result = await pool.query(
     `INSERT INTO users
       (name, email, password, email_verification_token, email_verification_token_expires)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, email`,
     [name, email, hashedPassword, verificationToken, new Date(Date.now() + TOKEN_EXPIRY_5_HOURS)]
      );
        const newUser = result.rows[0];

        const userId = newUser.id;

        // 3. 🚀 THE MAGIC STEP: Seed Default Accounts for this User
        // We insert multiple rows in one go.
        await client.query(
            `INSERT INTO accounts (user_id, name, code, type, description) VALUES 
            ($1, 'Cash on Hand', '1000', 'Asset', 'Physical cash and petty cash'),
            ($1, 'Bank Account', '1001', 'Asset', 'Primary business checking account'),
            ($1, 'Accounts Receivable', '1200', 'Asset', 'Money owed by customers'),
            ($1, 'Accounts Payable', '2000', 'Liability', 'Unpaid bills to vendors'),
            ($1, 'Sales Revenue', '4000', 'Revenue', 'Income from goods or services'),
            ($1, 'Cost of Goods Sold', '5000', 'Expense', 'Direct costs of production'),
            ($1, 'Office Expenses', '6000', 'Expense', 'General office supplies and utilities')`,
            [userId]
        );
      
        const accessToken = generateAccessToken(newUser.id.toString());
        const refreshToken = generateRefreshToken(newUser.id.toString());

        
        await pool.query(
       `INSERT INTO refresh_tokens (user_id, token, created_at)
        VALUES ($1, $2, NOW())`,
       [newUser.id, refreshToken]
     );

      await client.query('COMMIT');
     
     
             res.cookie("accessToken", accessToken, clearCookieOptions);
             res.cookie("refreshToken", refreshToken, {...clearCookieOptions, sameSite:'strict'});
             
                 res.status(201).json({ message: "User created successfully." ,
                   user: {id: newUser.id, name: newUser.name, email: newUser.email}
                 });
    }catch (err) {
        await client.query('ROLLBACK'); // Undo user creation if accounts fail
        next(err);
    } finally {
        client.release();
    }
  }

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
        emailVerified: user.email_verified,
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


export const logoutUser = async (req: Request,res: Response, next: NextFunction) => {
   try {
    const refreshToken = req.cookies?.refreshToken;

    if(refreshToken) {
      await pool.query(
        "DELETE FROM refresh_tokens WHERE token = $1", [refreshToken]
      );
    }

    res.clearCookie("accessToken", accessTokenCookieOptions);
    res.clearCookie("refreshToken", refreshTokenCookieOptions);

    res.status(200).json({message: "Logged out successfully."

    })

   } catch (error) {
      next(error);
   }

  }