import express from "express";

import {  checkUser, login, refreshUser, register, logoutUser } from "../controllers/authController";

const router = express.Router();

router.post('/register', register);

router.post('/login', login);

router.get("/check", checkUser);

router.get("/refresh", refreshUser);

router.post("/logout", logoutUser);

export default router;
