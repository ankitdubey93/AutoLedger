import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { latestEmailToken } from '../helpers/email.js';

/**
 * Phase 38c — custom roles over the permission catalogue: an "Invoice
 * clerk" that can see and issue invoices and nothing else, edits taking
 * effect on the next request, the no-escalation rules, and cross-tenant
 * isolation of roles.
 */

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>;

let owner: SeededUser;
let ownerAgent: Agent;

beforeEach(async () => {
  await resetTables();
  owner = await createUserWithOrg({ label: 'owner', orgName: 'Alpha Ltd' });
  ownerAgent = await loginAgent(app, owner);
});

afterAll(closePool);

async function createRole(agent: Agent, name: string, permissions: string[]) {
  const res = await agent.post('/api/v1/organizations/roles').send({ name, permissions });
  return res;
}

/** Puts `user` into the owner's organization with a custom role, and returns their agent there. */
async function memberWithRole(user: SeededUser, roleId: string): Promise<Agent> {
  await addMember(owner.orgId, user.id, 'VIEWER');
  await ownerAgent.patch(`/api/v1/organizations/members/${user.id}`).send({ customRoleId: roleId }).expect(200);
  const agent = await loginAgent(app, user);
  await agent.post('/api/v1/auth/switch-org').send({ orgId: owner.orgId }).expect(200);
  return agent;
}

async function accountId(code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [
    owner.orgId,
    code,
  ]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`no account ${code}`);
  return id;
}

/** A draft invoice created by the owner. */
async function draftInvoice(): Promise<string> {
  const customer = await ownerAgent.post('/api/v1/customers').send({ name: 'Acme' }).expect(201);
  const res = await ownerAgent.post('/api/v1/invoices').send({
    customerId: customer.body.customer.id,
    issueDate: '2026-06-01',
    dueDate: '2026-06-30',
    notes: null,
    paymentTerms: null,
    lines: [{ description: 'Work', quantityMilli: 1000, unitPriceCents: 10000, revenueAccountId: await accountId('4100'), taxRateBp: 0 }],
  });
  expect(res.status).toBe(201);
  return res.body.invoice.id as string;
}

describe('roles API', () => {
  it('lists the built-in presets, the catalogue, and custom roles with the requires-closure applied', async () => {
    const created = await createRole(ownerAgent, 'Invoice clerk', ['invoices.issue']);
    expect(created.status).toBe(201);
    // invoices.issue requires invoices.view, which requires customers.view.
    expect(created.body.role.permissions).toEqual(['customers.view', 'invoices.issue', 'invoices.view']);

    const res = await ownerAgent.get('/api/v1/organizations/roles');
    expect(res.body.builtin.map((b: { role: string }) => b.role)).toEqual(['OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER']);
    expect(res.body.catalogue.length).toBeGreaterThan(50);
    expect(res.body.custom).toEqual([expect.objectContaining({ name: 'Invoice clerk', memberCount: 0 })]);
  });

  it('refuses unknown keys, owner-only keys, empty roles and duplicate names', async () => {
    expect((await createRole(ownerAgent, 'Bad', ['invoices.fly'])).status).toBe(400);
    expect((await createRole(ownerAgent, 'Locker', ['periods.lock'])).status).toBe(422);
    expect((await createRole(ownerAgent, 'Empty', [])).status).toBe(400);
    await createRole(ownerAgent, 'Clerk', ['invoices.view']).then((r) => expect(r.status).toBe(201));
    expect((await createRole(ownerAgent, 'clerk', ['invoices.view'])).status).toBe(409);
  });

  it('is closed to roles without roles.manage', async () => {
    const acct = await createUserWithOrg({ label: 'acct' });
    await addMember(owner.orgId, acct.id, 'ACCOUNTANT');
    const agent = await loginAgent(app, acct);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: owner.orgId }).expect(200);
    expect((await createRole(agent, 'Mine', ['invoices.view'])).status).toBe(403);
  });
});

describe('an "Invoice clerk" can see and issue invoices — and nothing else', () => {
  it('works end to end, with the session reporting exactly its permissions', async () => {
    const role = await createRole(ownerAgent, 'Invoice clerk', ['invoices.view', 'invoices.issue']);
    const clerk = await createUserWithOrg({ label: 'clerk' });
    const agent = await memberWithRole(clerk, role.body.role.id as string);

    const check = await agent.get('/api/v1/auth/check');
    expect(check.body.role).toBe('CUSTOM');
    expect(check.body.roleName).toBe('Invoice clerk');
    expect(check.body.permissions).toEqual(['customers.view', 'invoices.issue', 'invoices.view']);

    const invoiceId = await draftInvoice();
    expect((await agent.get('/api/v1/invoices')).status).toBe(200);
    expect((await agent.post(`/api/v1/invoices/${invoiceId}/issue`).send({})).status).toBe(200);

    // Everything else is refused.
    expect((await agent.post(`/api/v1/invoices/${invoiceId}/void`).send({})).status).toBe(403);
    expect((await agent.get('/api/v1/journals')).status).toBe(403);
    expect((await agent.get('/api/v1/bills')).status).toBe(403);
    expect((await agent.get('/api/v1/reports/dashboard')).status).toBe(403);
    expect((await agent.post('/api/v1/customers').send({ name: 'X' })).status).toBe(403);
    // Shell reads stay open to any member.
    expect((await agent.get('/api/v1/settings')).status).toBe(200);
    expect((await agent.get('/api/v1/organizations')).status).toBe(200);
  });

  it('an edit to the role applies on the next request — no new token needed', async () => {
    const role = await createRole(ownerAgent, 'Clerk', ['invoices.view', 'invoices.issue']);
    const clerk = await createUserWithOrg({ label: 'clerk' });
    const agent = await memberWithRole(clerk, role.body.role.id as string);
    expect((await agent.get('/api/v1/invoices')).status).toBe(200);

    await ownerAgent
      .patch(`/api/v1/organizations/roles/${String(role.body.role.id)}`)
      .send({ name: 'Clerk', permissions: ['bills.view'] })
      .expect(200);

    // Same agent, same (unexpired) access token.
    expect((await agent.get('/api/v1/invoices')).status).toBe(403);
    expect((await agent.get('/api/v1/bills')).status).toBe(200);
  });

  it('a removed member is refused on the next request, not 15 minutes later', async () => {
    const viewer = await createUserWithOrg({ label: 'viewer' });
    await addMember(owner.orgId, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: owner.orgId }).expect(200);
    expect((await agent.get('/api/v1/invoices')).status).toBe(200);

    await ownerAgent.delete(`/api/v1/organizations/members/${viewer.id}`).expect(200);
    expect((await agent.get('/api/v1/invoices')).status).toBe(403);
  });
});

describe('no privilege escalation', () => {
  it('a member manager cannot hand out, or create, more than they hold', async () => {
    const lead = await createRole(ownerAgent, 'Team lead', ['members.manage', 'roles.manage', 'invoices.view']);
    const leadUser = await createUserWithOrg({ label: 'lead' });
    const agent = await memberWithRole(leadUser, lead.body.role.id as string);
    const someone = await createUserWithOrg({ label: 'someone' });
    await addMember(owner.orgId, someone.id, 'VIEWER');

    // VIEWER holds views the lead lacks (bills.view …), so even VIEWER is out of reach.
    expect((await agent.patch(`/api/v1/organizations/members/${someone.id}`).send({ role: 'ADMIN' })).status).toBe(403);
    expect((await agent.patch(`/api/v1/organizations/members/${someone.id}`).send({ role: 'VIEWER' })).status).toBe(403);
    expect((await agent.post('/api/v1/organizations/invitations').send({ email: 'x@example.com', role: 'ACCOUNTANT' })).status).toBe(403);
    expect((await createRole(agent, 'Bigger', ['invoices.void'])).status).toBe(403);
    // Within their own permissions it works.
    const small = await createRole(agent, 'Reader', ['invoices.view']);
    expect(small.status).toBe(201);
    expect(
      (await agent.post('/api/v1/organizations/invitations').send({ email: 'y@example.com', customRoleId: small.body.role.id })).status,
    ).toBe(201);
  });

  it('a manager cannot change the access of someone more powerful', async () => {
    const lead = await createRole(ownerAgent, 'Team lead', ['members.manage', 'invoices.view']);
    const leadUser = await createUserWithOrg({ label: 'lead' });
    const agent = await memberWithRole(leadUser, lead.body.role.id as string);
    const admin = await createUserWithOrg({ label: 'admin' });
    await addMember(owner.orgId, admin.id, 'ADMIN');

    expect((await agent.delete(`/api/v1/organizations/members/${admin.id}`)).status).toBe(403);
  });

  it('an ADMIN cannot add an owner-only permission to a role', async () => {
    const admin = await createUserWithOrg({ label: 'admin' });
    await addMember(owner.orgId, admin.id, 'ADMIN');
    const agent = await loginAgent(app, admin);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: owner.orgId }).expect(200);
    expect((await createRole(agent, 'Webhook boss', ['webhooks.secrets'])).status).toBe(422);
  });
});

describe('assigning and deleting roles', () => {
  it('a role in use cannot be deleted; an unused one can', async () => {
    const role = await createRole(ownerAgent, 'Clerk', ['invoices.view']);
    const clerk = await createUserWithOrg({ label: 'clerk' });
    await memberWithRole(clerk, role.body.role.id as string);

    const del = await ownerAgent.delete(`/api/v1/organizations/roles/${String(role.body.role.id)}`);
    expect(del.status).toBe(409);

    await ownerAgent.patch(`/api/v1/organizations/members/${clerk.id}`).send({ role: 'VIEWER' }).expect(200);
    expect((await ownerAgent.delete(`/api/v1/organizations/roles/${String(role.body.role.id)}`)).status).toBe(200);
  });

  it('an invitation into a custom role lands the member in it', async () => {
    const role = await createRole(ownerAgent, 'Clerk', ['invoices.view']);
    const invitee = await createUserWithOrg({ label: 'invitee' });
    await ownerAgent
      .post('/api/v1/organizations/invitations')
      .send({ email: invitee.email, customRoleId: role.body.role.id })
      .expect(201);
    const token = await latestEmailToken(invitee.email, 'invitation');

    const agent = await loginAgent(app, invitee);
    const accepted = await agent.post(`/api/v1/auth/invitations/${token}/accept`).expect(200);
    expect(accepted.body.roleName).toBe('Clerk');
    expect(accepted.body.permissions).toEqual(['customers.view', 'invoices.view']);
  });

  it('the database refuses a custom role pointing at another organization', async () => {
    const other = await createUserWithOrg({ label: 'other', orgName: 'Other Co' });
    const otherAgent = await loginAgent(app, other);
    const foreign = await createRole(otherAgent, 'Foreign', ['invoices.view']);
    const member = await createUserWithOrg({ label: 'member' });
    await addMember(owner.orgId, member.id, 'VIEWER');

    await expect(
      pool.query("UPDATE organization_members SET role = 'CUSTOM', custom_role_id = $3 WHERE org_id = $1 AND user_id = $2", [
        owner.orgId,
        member.id,
        foreign.body.role.id,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('cross-tenant isolation', () => {
  it("never lists, edits, deletes or assigns another organization's role", async () => {
    const role = await createRole(ownerAgent, 'Secret clerk', ['invoices.view']);
    const roleId = role.body.role.id as string;
    const carol = await createUserWithOrg({ label: 'carol', orgName: 'Carol Co' });
    const carolAgent = await loginAgent(app, carol);

    const list = await carolAgent.get('/api/v1/organizations/roles');
    expect(list.body.custom).toEqual([]);
    expect(list.text).not.toContain('Secret clerk');
    expect(
      (await carolAgent.patch(`/api/v1/organizations/roles/${roleId}`).send({ name: 'Mine', permissions: ['invoices.view'] }))
        .status,
    ).toBe(404);
    expect((await carolAgent.delete(`/api/v1/organizations/roles/${roleId}`)).status).toBe(404);

    const dave = await createUserWithOrg({ label: 'dave' });
    await addMember(carol.orgId, dave.id, 'VIEWER');
    expect(
      (await carolAgent.patch(`/api/v1/organizations/members/${dave.id}`).send({ customRoleId: roleId })).status,
    ).toBe(404);
    expect(
      (await carolAgent.post('/api/v1/organizations/invitations').send({ email: 'z@example.com', customRoleId: roleId })).status,
    ).toBe(404);
  });
});
