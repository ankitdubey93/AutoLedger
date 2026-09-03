import { Router } from 'express';
import * as authController from '../controllers/authController.js';
import { authenticate } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';

/**
 * /api/v1/auth — see docs/api.md.
 *
 * register, login and refresh are public by necessity: they are how a caller
 * without a valid access token gets one. Everything else requires `authenticate`.
 */
const router = Router();

// Throttled: these are the two endpoints where an attacker can guess. See
// middleware/rateLimit.ts for why /refresh and /logout are deliberately not.
router.post('/register', authLimiter, authController.register);
router.post('/login', authLimiter, authController.login);

// POST rather than GET — it rotates the refresh token, and a state-changing
// GET is reachable by a cross-site top-level navigation under SameSite=Lax.
router.post('/refresh', authController.refresh);

// Public: logging out must work even with an expired access token, otherwise
// the one moment you most want to clear cookies is the moment you cannot.
router.post('/logout', authController.logout);

router.get('/check', authenticate, authController.check);
router.post('/switch-org', authenticate, authController.switchOrg);

export default router;
