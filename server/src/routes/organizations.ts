import { Router } from 'express';
import * as organizationController from '../controllers/organizationController.js';
import * as organizationProfileController from '../controllers/organizationProfileController.js';
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

// Phase 30 — the organization's postal identity. Any member may read it: the
// invoice document renders it, and a VIEWER can open an invoice.
router.get('/profile', authenticate, organizationProfileController.get);

// Editing it is organization configuration, same tier as PATCH / above.
router.patch(
  '/profile',
  authenticate,
  requireRole('OWNER', 'ADMIN'),
  organizationProfileController.update,
);

// Phase 37 — member administration, same tier as the member list. Whether
// the OWNER role itself may be granted or removed is checked in the service
// (only an OWNER may), since it depends on the target, not just the caller.
router.patch(
  '/members/:userId',
  authenticate,
  requireRole('OWNER', 'ADMIN'),
  organizationController.updateMemberRole,
);
router.delete(
  '/members/:userId',
  authenticate,
  requireRole('OWNER', 'ADMIN'),
  organizationController.removeMember,
);

// Phase 37 — invitations into the active organization.
router.get('/invitations', authenticate, requireRole('OWNER', 'ADMIN'), organizationController.listInvitations);
router.post('/invitations', authenticate, requireRole('OWNER', 'ADMIN'), organizationController.createInvitation);
router.delete(
  '/invitations/:id',
  authenticate,
  requireRole('OWNER', 'ADMIN'),
  organizationController.revokeInvitation,
);

export default router;
