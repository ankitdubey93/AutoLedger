import { Router } from 'express';
import * as organizationController from '../controllers/organizationController.js';
import * as organizationProfileController from '../controllers/organizationProfileController.js';
import { authenticate } from '../middleware/auth.js';
import { allowAnyMember, requirePermission } from '../middleware/rbac.js';

/**
 * /api/v1/organizations — see docs/api.md.
 *
 * Every route is authenticated, and every one is scoped to the active
 * organization carried by the access token.
 */
const router = Router();

// Any member may see which organization they are in.
router.get('/', authenticate, allowAnyMember, organizationController.getActiveOrganization);

// The member list is administrative: it exposes every colleague's email, which
// an ACCOUNTANT or VIEWER has no need for.
router.get(
  '/members',
  authenticate,
  requirePermission('members.view'),
  organizationController.listMembers,
);

// Editing the organization's name or base currency is administrative, same
// tier as the member list.
router.patch('/', authenticate, requirePermission('settings.manage'), organizationController.update);

// Phase 30 — the organization's postal identity. Any member may read it: the
// invoice document renders it, and a VIEWER can open an invoice.
router.get('/profile', authenticate, allowAnyMember, organizationProfileController.get);

// Editing it is organization configuration, same tier as PATCH / above.
router.patch(
  '/profile',
  authenticate,
  requirePermission('settings.manage'),
  organizationProfileController.update,
);

// Phase 37 — member administration, same tier as the member list. Whether
// the OWNER role itself may be granted or removed is checked in the service
// (only an OWNER may), since it depends on the target, not just the caller.
router.patch(
  '/members/:userId',
  authenticate,
  requirePermission('members.manage'),
  organizationController.updateMemberRole,
);
router.delete(
  '/members/:userId',
  authenticate,
  requirePermission('members.manage'),
  organizationController.removeMember,
);

// Phase 37 — invitations into the active organization.
router.get('/invitations', authenticate, requirePermission('members.view'), organizationController.listInvitations);
router.post('/invitations', authenticate, requirePermission('members.manage'), organizationController.createInvitation);
router.delete(
  '/invitations/:id',
  authenticate,
  requirePermission('members.manage'),
  organizationController.revokeInvitation,
);

// Phase 38b — how email sent on this organization's behalf presents itself.
// Reading is administrative like the rest of organization configuration.
router.get('/email-settings', authenticate, requirePermission('settings.manage'), organizationController.getEmailSettings);
router.patch('/email-settings', authenticate, requirePermission('settings.manage'), organizationController.updateEmailSettings);

// Phase 38c — custom roles. Reading them is part of managing members (the
// role picker); creating, editing and deleting is its own permission. The
// service re-checks the caller's permissions under the organization lock and
// refuses any role broader than the editor (no privilege escalation).
router.get('/roles', authenticate, requirePermission('members.view'), organizationController.listRoles);
router.post('/roles', authenticate, requirePermission('roles.manage'), organizationController.createRole);
router.patch('/roles/:id', authenticate, requirePermission('roles.manage'), organizationController.updateRole);
router.delete('/roles/:id', authenticate, requirePermission('roles.manage'), organizationController.deleteRole);

export default router;
