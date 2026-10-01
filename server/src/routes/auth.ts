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

// 2026-09-29 — password reset. Throttled like login: forgot-password could be
// used to spam an address, reset-password to guess tokens (hopeless at 256
// bits, but the limiter costs nothing).
router.post('/forgot-password', authLimiter, authController.forgotPassword);
router.post('/reset-password', authLimiter, authController.resetPassword);

// POST rather than GET — it rotates the refresh token, and a state-changing
// GET is reachable by a cross-site top-level navigation under SameSite=Lax.
router.post('/refresh', authController.refresh);

// Public: logging out must work even with an expired access token, otherwise
// the one moment you most want to clear cookies is the moment you cannot.
router.post('/logout', authController.logout);

router.get('/check', authenticate, authController.check);
router.post('/switch-org', authenticate, authController.switchOrg);

// Phase 37 — session-moving organization routes. Under /auth because the
// refresh cookie (path=/api/v1/auth) is only sent here; see authController.
router.post('/organizations', authenticate, authController.createOrganization);
router.post('/leave-org', authenticate, authController.leaveOrganization);
// Public: the invitee may not have an account yet. Throttled like login —
// an unthrottled lookup by token is a guessing oracle (hopeless at 256 bits,
// but the limiter costs nothing).
router.get('/invitations/:token', authLimiter, authController.previewInvitation);
router.post('/invitations/:token/accept', authLimiter, authenticate, authController.acceptInvitation);

// Phase 38a — self-service on the caller's own identity (user settings).
router.patch('/me', authenticate, authController.updateProfile);
// Throttled like login: a wrong current password is a guess.
router.post('/change-password', authLimiter, authenticate, authController.changePassword);
router.get('/sessions', authenticate, authController.listSessions);
router.post('/sessions/revoke-others', authenticate, authController.revokeOtherSessions);
router.delete('/sessions/:id', authenticate, authController.revokeSession);

// Phase 38b — the email address. The two public token routes are throttled
// like reset-password; the two that send an email are throttled like login.
router.post('/verify-email', authLimiter, authController.verifyEmail);
router.post('/verify-email/resend', authLimiter, authenticate, authController.resendVerification);
router.post('/me/email', authLimiter, authenticate, authController.requestEmailChange);
router.post('/confirm-email-change', authLimiter, authController.confirmEmailChange);
router.get('/me/notifications', authenticate, authController.getNotificationPreferences);
router.put('/me/notifications', authenticate, authController.setNotificationPreferences);

export default router;
