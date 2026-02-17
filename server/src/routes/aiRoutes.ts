import express from 'express';
import { analyzeTransaction } from '../controllers/aiController';
import auth from '../middleware/auth'; 

const router = express.Router();

router.post('/analyze', auth, analyzeTransaction);

export default router;