import express from 'express';
import { getAccounts, createAccount } from '../controllers/accountController';
import auth from "../middleware/auth";
const router = express.Router();

router.route('/')
    .get(auth, getAccounts)
    .post(auth, createAccount);

export default router;