import { Router } from 'express';
import * as organizationController from '../controllers/organizationController.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

/**
 * /api/v1/organizations — see docs/api.md.
 *
 * Every route is authenticated, and every one is scoped to the active
 * organization carried by the access token.
 */
const router = Router();

// Any member may see which organization they are in.
router.get('/', authenticate, organizationController.getActiveOrganization);

// The member list is administrative: it exposes every colleague's email, which
// an ACCOUNTANT or VIEWER has no need for.
router.get(
  '/members',
  authenticate,
  requireRole('OWNER', 'ADMIN'),
  organizationController.listMembers,
);

export default router;
