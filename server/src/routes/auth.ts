import express from "express";
import AuthMiddleware from "../middleware/auth";
import { checkUser, getAllUsers, getUserById, login, refreshUser, register, verifyToken } from "../controllers/authController";

const router = express.Router();

router.post("/verify",AuthMiddleware,verifyToken);

router.post('/register', register);

router.post('/login', login);

router.get('/:id', getUserById)

router.get("/check", checkUser);

router.get("/refresh", refreshUser);
// THis is a development level route only. Delete after development testing.
router.get('/', getAllUsers)

export default router;
