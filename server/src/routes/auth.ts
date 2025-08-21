import express, { Request, Response } from "express";
import AuthMiddleware from "../middleware/auth";
import { getAllUsers, getUserById, login, signup, verifyToken } from "../controllers/authController";

const router = express.Router();

const jwtSecret = process.env.JWT_SECRET;

interface CustomRequest extends Request {
  user?: any;
}

router.post("/verify",AuthMiddleware,verifyToken);


router.post('/signup', signup);

router.post('/login', login);

router.get('/:id', getUserById)



// THis is a development level route only. Delete after development testing.


router.get('/', getAllUsers)



export default router;
