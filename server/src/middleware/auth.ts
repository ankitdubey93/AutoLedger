import jwt, {JwtPayload} from 'jsonwebtoken';
import dotenv from 'dotenv';
import { Request, Response, NextFunction } from 'express';
dotenv.config();

interface CustomRequest extends Request {
    user?: JwtPayload;
}

const secretKey = process.env.JWT_SECRET;

const auth = (req: CustomRequest,res: Response,next: NextFunction) => {
    
    const authHeader = req.headers.authorization;

    if(!authHeader || !authHeader.startsWith("Bearer ")) {
        res.status(401).json({message: 'Authorization denied, no token provided.'});
        return;
    }
    const idToken = authHeader.split(" ")[1];

    try {
        const decoded = jwt.verify(idToken,secretKey as string) as JwtPayload;
        console.log(decoded);
        req.user = decoded;
        next();
    } catch(error) {
        res.status(401).json({message: 'Token is not valid.'});
    }
};

export default auth;