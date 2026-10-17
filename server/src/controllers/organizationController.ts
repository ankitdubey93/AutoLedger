import type { RequestHandler } from 'express';
import * as invitationService from '../services/invitationService.js';
import * as loginEventService from '../services/loginEventService.js';
import * as emailSettingsService from '../services/mail/organizationEmailSettingsService.js';
import * as organizationService from '../services/organizationService.js';
import * as roleService from '../services/roleService.js';
import {
  createInvitationSchema,
  roleBodySchema,
  updateEmailSettingsSchema,
  updateMemberRoleSchema,
  updateOrganizationSchema,
} from '../schemas/organizationSchema.js';
import { parseBody } from '../utils/parseBody.js';
import { requireUser } from '../utils/requireUser.js';
import { requireParam } from '../utils/routeParam.js';
import { requireUuid } from '../utils/validate.js';

/**
 * Thin adapters over organizationService. Zero SQL (guardrails rule 2).
 *
 * Note what these handlers never read: `req.params.orgId`, `req.query.orgId`,
 * or an `X-Org-Id` header. The organization comes from `requireUser(req).orgId`
 * — the verified access token — and nowhere else. There is a test that sends
 * all three of those pointing at another tenant and asserts the response is
 * unchanged.
 */

/** GET /organizations — the caller's active organization. */
export const getActiveOrganization: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const organization = await organizationService.getById(user.orgId);
  res.json({ success: true, organization });
};

/** GET /organizations/members — everyone in the active organization. */
export const listMembers: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const members = await organizationService.listMembers(user.orgId);
  res.json({ success: true, count: members.length, members });
};

/** GET /organizations/members/activity — per-member sign-in and change counts (Phase 46d). */
export const memberActivity: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const members = await loginEventService.listMemberActivity(user.orgId);
  res.json({ success: true, count: members.length, members });
};

/** PATCH /organizations — edit the active organization's name and/or base currency. */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateOrganizationSchema, req.body);
  const organization = await organizationService.updateOrganization(user.orgId, input);
  res.json({ success: true, organization });
};

/* ------------------------------------------------------------- Phase 37 */

/** A `:param` that must be a UUID — a clean 400 rather than a driver error. */
function uuidParam(req: Parameters<RequestHandler>[0], name: string): string {
  return requireUuid({ [name]: requireParam(req, name) }, name);
}

/** PATCH /organizations/members/:userId — change a member's role. */
export const updateMemberRole: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const body = parseBody(updateMemberRoleSchema, req.body);
  const member = await organizationService.updateMemberRole(user.orgId, user, uuidParam(req, 'userId'), {
    role: body.role ?? 'CUSTOM',
    customRoleId: body.customRoleId ?? null,
  });
  res.json({ success: true, member });
};

/** DELETE /organizations/members/:userId — remove someone else from the organization. */
export const removeMember: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await organizationService.removeMember(user.orgId, user, uuidParam(req, 'userId'));
  res.json({ success: true });
};

/** GET /organizations/invitations — open invitations in the active organization. */
export const listInvitations: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const invitations = await invitationService.listInvitations(user.orgId);
  res.json({ success: true, count: invitations.length, invitations });
};

/** POST /organizations/invitations — invite an email address; the link is returned once. */
export const createInvitation: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const body = parseBody(createInvitationSchema, req.body);
  const { invitation, acceptUrl } = await invitationService.createInvitation(user.orgId, user, {
    email: body.email,
    role: body.role ?? 'CUSTOM',
    customRoleId: body.customRoleId ?? null,
  });
  res.status(201).json({ success: true, invitation, acceptUrl });
};

/** DELETE /organizations/invitations/:id — revoke an open invitation. */
export const revokeInvitation: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await invitationService.revokeInvitation(user.orgId, uuidParam(req, 'id'));
  res.json({ success: true });
};

/** GET /organizations/email-settings — Phase 38b. */
export const getEmailSettings: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const settings = await emailSettingsService.getEmailSettings(user.orgId);
  res.json({ success: true, settings });
};

/** PATCH /organizations/email-settings — Phase 38b. */
export const updateEmailSettings: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateEmailSettingsSchema, req.body);
  const settings = await emailSettingsService.updateEmailSettings(user.orgId, input);
  res.json({ success: true, settings });
};

/* ------------------------------------------------------------ Phase 38c */

/** GET /organizations/roles — built-in presets, custom roles, and the permission catalogue. */
export const listRoles: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const roles = await roleService.listRoles(user.orgId);
  res.json({ success: true, ...roles });
};

/** POST /organizations/roles */
export const createRole: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(roleBodySchema, req.body);
  const role = await roleService.createRole(user.orgId, user, input);
  res.status(201).json({ success: true, role });
};

/** PATCH /organizations/roles/:id */
export const updateRole: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(roleBodySchema, req.body);
  const role = await roleService.updateRole(user.orgId, user, uuidParam(req, 'id'), input);
  res.json({ success: true, role });
};

/** DELETE /organizations/roles/:id */
export const deleteRole: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await roleService.deleteRole(user.orgId, user, uuidParam(req, 'id'));
  res.json({ success: true });
};
