import request from 'supertest';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Organization app selection — Phase 27. Integration tier, real PostgreSQL.
 *
 * Includes this module's mandatory cross-tenant isolation case (rule 15).
 */

const app = createApp();
const BASE = '/api/v1/organizations/apps';

interface AppEntry {
  slug: string;
  enabled: boolean;
  enabledAt: string | null;
}

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
});

afterAll(closePool);

function enabledSlugs(apps: AppEntry[]): string[] {
  return apps.filter((a) => a.enabled).map((a) => a.slug).sort();
}

function entry(apps: AppEntry[], slug: string): AppEntry {
  const found = apps.find((a) => a.slug === slug);
  if (found === undefined) throw new Error(`no ${slug} in response`);
  return found;
}

/** A member of org A in `role`, with org A as the active organization. */
async function memberOfA(role: 'ACCOUNTANT' | 'VIEWER') {
  const member = await createUserWithOrg({ label: role.toLowerCase(), orgName: `Org ${role}` });
  await addMember(orgA, member.id, role);
  const agent = await loginAgent(app, member);
  await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });
  return agent;
}

it('GET without a session → 401', async () => {
  const res = await request(app).get(BASE);
  expect(res.status).toBe(401);
});

it('fresh org: GET → 200, selectionCompletedAt null, count 3, every enabled false and enabledAt null', async () => {
  const agent = await loginAgent(app, userA);
  const res = await agent.get(BASE);

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.selectionCompletedAt).toBeNull();
  expect(res.body.count).toBe(3);
  for (const a of res.body.apps as AppEntry[]) {
    expect(a.enabled).toBe(false);
    expect(a.enabledAt).toBeNull();
  }
});

it("OWNER PUT ['ledger-core','ap-flow'] → 200; those two enabled, other one not, selection complete", async () => {
  const agent = await loginAgent(app, userA);
  const res = await agent.put(BASE).send({ appSlugs: ['ledger-core', 'ap-flow'] });

  expect(res.status).toBe(200);
  const apps = res.body.apps as AppEntry[];
  expect(enabledSlugs(apps)).toEqual(['ap-flow', 'ledger-core']);
  expect(Number.isNaN(Date.parse(entry(apps, 'ledger-core').enabledAt ?? ''))).toBe(false);
  expect(apps.filter((a) => !a.enabled)).toHaveLength(1);
  expect(Number.isNaN(Date.parse(res.body.selectionCompletedAt as string))).toBe(false);
});

it('PUT replaces the set, and an app that stays keeps its original enabledAt', async () => {
  const agent = await loginAgent(app, userA);
  const first = await agent.put(BASE).send({ appSlugs: ['ledger-core', 'ap-flow'] });
  const firstEnabledAt = entry(first.body.apps as AppEntry[], 'ledger-core').enabledAt;

  const second = await agent.put(BASE).send({ appSlugs: ['ledger-core'] });

  expect(second.status).toBe(200);
  const apps = second.body.apps as AppEntry[];
  expect(entry(apps, 'ap-flow').enabled).toBe(false);
  expect(entry(apps, 'ledger-core').enabledAt).toBe(firstEnabledAt);
});

it("PUT ['ap-flow'] → 422 'AP-Flow requires LedgerCore', previous set unchanged", async () => {
  const agent = await loginAgent(app, userA);
  await agent.put(BASE).send({ appSlugs: ['ledger-core', 'stock'] });

  const res = await agent.put(BASE).send({ appSlugs: ['ap-flow'] });
  expect(res.status).toBe(422);
  expect(res.body.error).toBe('AP-Flow requires LedgerCore');

  const after = await agent.get(BASE);
  expect(enabledSlugs(after.body.apps as AppEntry[])).toEqual(['ledger-core', 'stock']);
});

it("PUT { appSlugs: [] } → 400; PUT ['nope'] → 422 'Unknown app \"nope\"'", async () => {
  const agent = await loginAgent(app, userA);

  const empty = await agent.put(BASE).send({ appSlugs: [] });
  expect(empty.status).toBe(400);

  const unknown = await agent.put(BASE).send({ appSlugs: ['nope'] });
  expect(unknown.status).toBe(422);
  expect(unknown.body.error).toBe('Unknown app "nope"');
});

it('duplicate slugs → 200 and exactly one row', async () => {
  const agent = await loginAgent(app, userA);
  const res = await agent.put(BASE).send({ appSlugs: ['ledger-core', 'ledger-core'] });
  expect(res.status).toBe(200);

  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*) FROM organization_apps WHERE org_id = $1 AND app_slug = 'ledger-core'",
    [orgA],
  );
  expect(rows[0]?.count).toBe('1');
});

it('ACCOUNTANT PUT → 403; VIEWER GET → 200', async () => {
  const accountant = await memberOfA('ACCOUNTANT');
  const put = await accountant.put(BASE).send({ appSlugs: ['ledger-core'] });
  expect(put.status).toBe(403);

  const viewer = await memberOfA('VIEWER');
  const get = await viewer.get(BASE);
  expect(get.status).toBe(200);
});

it("cross-tenant: org A enables ['ledger-core','stock']; org B sees nothing of it", async () => {
  const agentA = await loginAgent(app, userA);
  await agentA.put(BASE).send({ appSlugs: ['ledger-core', 'stock'] });

  const agentB = await loginAgent(app, userB);
  const res = await agentB.get(BASE);

  expect(res.status).toBe(200);
  expect(res.body.selectionCompletedAt).toBeNull();
  expect(enabledSlugs(res.body.apps as AppEntry[])).toEqual([]);
});

it("cross-tenant: org B PUT with header X-Org-Id: <A> leaves org A's set untouched", async () => {
  const agentA = await loginAgent(app, userA);
  await agentA.put(BASE).send({ appSlugs: ['ledger-core', 'stock'] });

  const agentB = await loginAgent(app, userB);
  const put = await agentB.put(BASE).set('X-Org-Id', orgA).send({ appSlugs: ['ledger-core'] });
  expect(put.status).toBe(200);

  const a = await agentA.get(BASE);
  expect(enabledSlugs(a.body.apps as AppEntry[])).toEqual(['ledger-core', 'stock']);

  const b = await agentB.get(BASE);
  expect(enabledSlugs(b.body.apps as AppEntry[])).toEqual(['ledger-core']);
  expect(orgB).not.toBe(orgA);
});

it('audit: enabling writes INSERT rows and removing writes a DELETE row, app_slug platform', async () => {
  const agent = await loginAgent(app, userA);
  await agent.put(BASE).send({ appSlugs: ['ledger-core', 'stock'] });
  await agent.put(BASE).send({ appSlugs: ['ledger-core'] });

  const { rows } = await pool.query<{ operation: string; count: string }>(
    `SELECT operation, count(*) FROM audit_logs
      WHERE org_id = $1 AND table_name = 'organization_apps' AND app_slug = 'platform'
      GROUP BY operation`,
    [orgA],
  );
  const byOp = new Map(rows.map((r) => [r.operation, Number(r.count)]));
  expect(byOp.get('INSERT')).toBeGreaterThanOrEqual(1);
  expect(byOp.get('DELETE')).toBe(1);
});

it("onboarding link: after PUT, GET /api/v1/onboarding/platform → status 'COMPLETED'", async () => {
  const agent = await loginAgent(app, userA);
  await agent.put(BASE).send({ appSlugs: ['ledger-core'] });

  const res = await agent.get('/api/v1/onboarding/platform');
  expect(res.status).toBe(200);
  expect(res.body.onboarding.status).toBe('COMPLETED');
});
