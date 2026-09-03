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

// Editing the organization's name or base currency is administrative, same
// tier as the member list.
router.patch('/', authenticate, requireRole('OWNER', 'ADMIN'), organizationController.update);

export default router;
