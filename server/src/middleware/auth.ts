import jwt, {JwtPayload} from 'jsonwebtoken';
import dotenv from 'dotenv';
import { Request, Response, NextFunction } from 'express';
dotenv.config();

interface CustomRequest extends Request {
    user?: JwtPayload;
}

const secretKey = process.env.JWT_SECRET;

const auth = (req: CustomRequest,res: Response,next: NextFunction) => {


    const token = req.cookies?.accessToken || 
    (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.split(" ")[1] : null);
    
    

    if(!token) {
        res.status(401).json({message: 'Authorization denied, no token provided.'});
        return;
    }
    

    try {
        const decoded = jwt.verify(token,secretKey as string) as JwtPayload;
        console.log(decoded);
        req.user = decoded;
        next();
    } catch(error) {
        res.status(401).json({message: 'Token is not valid.'});
    }
};

export default auth;