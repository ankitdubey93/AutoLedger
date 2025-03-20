import express, { Request, Response } from "express";
import AuthMiddleware from "../middleware/auth";

const router = express.Router();

interface CustomRequest extends Request {
  user?: any;
}

router.post("/verify", AuthMiddleware, (req: CustomRequest, res: Response) => {
  res.status(200).json({ message: "Token is valid", user: req.user });
});

export default router;
