
import express from 'express';
import { getTrialBalance } from '../controllers/reportController';
import  auth from '../middleware/auth'; 

const router = express.Router();

router.get('/trial-balance', auth, getTrialBalance);

export default router;