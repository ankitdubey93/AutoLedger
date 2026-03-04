import jwt, { JwtPayload } from 'jsonwebtoken';
import dotenv from 'dotenv';
import { Request, Response, NextFunction } from 'express';
import ApiError from '../utils/apiError';
dotenv.config();

const secretKey = process.env.ACCESS_TOKEN_SECRET;

const auth = (req: Request, res: Response, next: NextFunction) => {


    const token = req.cookies?.accessToken ||
        (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.split(" ")[1] : null);



    if (!token) {
        return next(new ApiError(401, 'Authorization denied, no token provided.'));
    }


    try {
        const decoded = jwt.verify(token, secretKey as string) as JwtPayload & { userId: string };
        req.user = decoded;
        next();
    } catch (error) {
        next(new ApiError(401, 'Token is not valid.'));
    }
};

export default auth;