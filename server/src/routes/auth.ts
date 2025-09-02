import express from "express";
import AuthMiddleware from "../middleware/auth";
import {  register, verifyToken } from "../controllers/authController";

const router = express.Router();

router.post("/verify",AuthMiddleware,verifyToken);

router.post('/register', register);

// router.post('/login', login);


// router.get("/check", checkUser);

// router.get("/refresh", refreshUser);


export default router;
