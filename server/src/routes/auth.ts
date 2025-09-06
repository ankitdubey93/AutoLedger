import express from "express";
import AuthMiddleware from "../middleware/auth";
import {  checkUser, login, refreshUser, register } from "../controllers/authController";

const router = express.Router();

router.post('/register', register);

router.post('/login', login);

router.get("/check", checkUser);

router.get("/refresh", refreshUser);

export default router;
