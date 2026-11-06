import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { regionToday } from '../../services/accounting/regionService.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId } from '../helpers/accountingFixtures.js';

/**
 * The region foundation (Phase 49a). Integration tier, real PostgreSQL.
 *
 * The central claims: a GENERIC organization sees no change at all; activation
 * is idempotent, additive and refuses a non-AUD organization with postings;
 * "today" follows the organization's zone only when it is Australian; and one
 * organization's switch never reaches another.
 */

const app = createApp();
const SETTINGS = '/api/v1/settings';
const GST = { registered: true, basis: 'CASH', basCycle: 'QUARTERLY', basMethod: 'SIMPLER' } as const;
const ACTIVATE = { gst: GST, timezone: 'Australia/Sydney' };

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let agentA: Agent;
let agentB: Agent;

async function accountName(orgId: string, code: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM accounts WHERE org_id = $1 AND code = $2', [orgId, code]);
  return rows[0]?.name;
}

async function postAnEntry(agent: Agent, orgId: string): Promise<void> {
  const res = await agent.post('/api/v1/manual-journals').send({
    entryDate: '2026-07-15',
    narration: 'First entry',
    action: 'post',
    lines: [
      { accountId: await accountId(orgId, '6130'), debitCents: 1000, creditCents: 0 },
      { accountId: await accountId(orgId, '3100'), debitCents: 0, creditCents: 1000 },
    ],
  });
  if (res.status !== 201) throw new Error(`fixture: journal failed ${res.status} ${res.text}`);
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'a' });
  userB = await createUserWithOrg({ label: 'b' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
});

afterAll(async () => {
  await closePool();
});

describe('a generic organization', () => {
  it('reads as GENERIC with no GST settings and its default chart untouched', async () => {
    const res = await agentA.get(SETTINGS);
    expect(res.status).toBe(200);
    expect(res.body.settings.region).toBe('GENERIC');
    expect(res.body.settings.gst).toBeNull();
    expect(await accountName(userA.orgId, '2140')).toBe('GST/VAT Output Payable');
    expect(await accountName(userA.orgId, '2150')).toBeUndefined();
  });

  it('keeps UTC for "today", even with a timezone set for its quotes', async () => {
    const onboard = await agentA.post(`${SETTINGS}/onboarding`).send({
      organizationName: 'Northwind',
      legalName: null,
      baseCurrency: 'USD',
      fiscalYearStartMonth: 1,
      booksStartDate: '2026-01-01',
      industry: null,
      timezone: 'Australia/Sydney',
      cashAccountId: null,
    });
    expect(onboard.status).toBe(200);
    expect(await regionToday(userA.orgId, new Date('2026-06-30T14:30:00Z'))).toBe('2026-06-30');
  });

  it('cannot edit GST settings', async () => {
    const res = await agentA.patch(`${SETTINGS}/gst`).send({ basis: 'ACCRUAL' });
    expect(res.status).toBe(403);
  });
});

describe('activating Australia', () => {
  it('moves the organization to AUD, adds the accounts and renames default ones', async () => {
    const res = await agentA.post(`${SETTINGS}/region/australia`).send(ACTIVATE);
    expect(res.status).toBe(200);
    expect(res.body.settings.region).toBe('AU');
    expect(res.body.settings.baseCurrency).toBe('AUD');
    expect(res.body.settings.timezone).toBe('Australia/Sydney');
    expect(res.body.settings.gst).toEqual(GST);
    expect(await accountName(userA.orgId, '2150')).toBe('ATO Clearing');
    expect(await accountName(userA.orgId, '2162')).toBe('PAYG Withholding Payable');
    expect(await accountName(userA.orgId, '1180')).toBe('GST Paid');
    expect(await accountName(userA.orgId, '2140')).toBe('GST Collected');
  });

  it('is idempotent and leaves a name the organization chose alone', async () => {
    await pool.query(`UPDATE accounts SET name = 'Our GST' WHERE org_id = $1 AND code = '2140'`, [userA.orgId]);
    await agentA.post(`${SETTINGS}/region/australia`).send(ACTIVATE);
    const before = await pool.query('SELECT count(*)::int AS n FROM accounts WHERE org_id = $1', [userA.orgId]);
    const again = await agentA.post(`${SETTINGS}/region/australia`).send(ACTIVATE);
    expect(again.status).toBe(200);
    const after = await pool.query('SELECT count(*)::int AS n FROM accounts WHERE org_id = $1', [userA.orgId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(await accountName(userA.orgId, '2140')).toBe('Our GST');
  });

  it('refuses a non-AUD organization that already has postings, changing nothing', async () => {
    await postAnEntry(agentA, userA.orgId);
    const res = await agentA.post(`${SETTINGS}/region/australia`).send(ACTIVATE);
    expect(res.status).toBe(409);
    const settings = await agentA.get(SETTINGS);
    expect(settings.body.settings.region).toBe('GENERIC');
    expect(settings.body.settings.baseCurrency).toBe('USD');
    expect(await accountName(userA.orgId, '2150')).toBeUndefined();
  });

  it('accepts an AUD organization that already has postings', async () => {
    await pool.query(`UPDATE organizations SET base_currency = 'AUD' WHERE id = $1`, [userA.orgId]);
    await postAnEntry(agentA, userA.orgId);
    const res = await agentA.post(`${SETTINGS}/region/australia`).send(ACTIVATE);
    expect(res.status).toBe(200);
    expect(res.body.settings.region).toBe('AU');
  });

  it('refuses a timezone outside Australia', async () => {
    const res = await agentA.post(`${SETTINGS}/region/australia`).send({ gst: GST, timezone: 'Europe/London' });
    expect(res.status).toBe(400);
  });

  it('follows the organization zone for "today", so a new quarter starts on time', async () => {
    await agentA.post(`${SETTINGS}/region/australia`).send(ACTIVATE);
    // 00:30 on 1 July in Sydney is still 30 June in UTC.
    expect(await regionToday(userA.orgId, new Date('2026-06-30T14:30:00Z'))).toBe('2026-07-01');
  });

  it('never reaches another organization', async () => {
    await agentA.post(`${SETTINGS}/region/australia`).send(ACTIVATE);
    const other = await agentB.get(SETTINGS);
    expect(other.body.settings.region).toBe('GENERIC');
    expect(other.body.settings.gst).toBeNull();
    expect(await accountName(userB.orgId, '2150')).toBeUndefined();
    expect((await agentB.patch(`${SETTINGS}/gst`).send({ basis: 'ACCRUAL' })).status).toBe(403);
  });
});

describe('the setup wizard', () => {
  const wizard = {
    organizationName: 'Harbour Bakery',
    legalName: null,
    fiscalYearStartMonth: 7,
    fiscalYearStartDay: 1,
    booksStartDate: '2026-07-01',
    industry: null,
    cashAccountId: null,
  };

  it('activates Australia in one transaction with onboarding', async () => {
    const res = await agentA.post(`${SETTINGS}/onboarding`).send({
      ...wizard,
      baseCurrency: 'AUD',
      timezone: 'Australia/Perth',
      australia: { gst: { ...GST, basis: 'ACCRUAL' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.settings.region).toBe('AU');
    expect(res.body.settings.timezone).toBe('Australia/Perth');
    expect(res.body.settings.gst.basis).toBe('ACCRUAL');
    expect(res.body.settings.onboardedAt).not.toBeNull();
    expect(res.body.settings.currentFiscalYear.startDate.slice(5)).toBe('07-01');
  });

  it('refuses Australia with another currency or zone', async () => {
    const usd = await agentA.post(`${SETTINGS}/onboarding`).send({
      ...wizard, baseCurrency: 'USD', timezone: 'Australia/Perth', australia: { gst: GST },
    });
    expect(usd.status).toBe(400);
    const zone = await agentA.post(`${SETTINGS}/onboarding`).send({
      ...wizard, baseCurrency: 'AUD', timezone: 'UTC', australia: { gst: GST },
    });
    expect(zone.status).toBe(400);
  });

  it('stays generic when the country step did not choose Australia', async () => {
    const res = await agentA.post(`${SETTINGS}/onboarding`).send({ ...wizard, baseCurrency: 'AUD', timezone: 'UTC' });
    expect(res.status).toBe(200);
    expect(res.body.settings.region).toBe('GENERIC');
  });
});

describe('leaving and editing', () => {
  it('updates GST settings and returns to generic', async () => {
    await agentA.post(`${SETTINGS}/region/australia`).send(ACTIVATE);
    const patched = await agentA.patch(`${SETTINGS}/gst`).send({ basis: 'ACCRUAL', basCycle: 'MONTHLY' });
    expect(patched.status).toBe(200);
    expect(patched.body.settings.gst).toEqual({ ...GST, basis: 'ACCRUAL', basCycle: 'MONTHLY' });
    const moved = await agentA.patch(`${SETTINGS}/gst`).send({ timezone: 'Australia/Perth' });
    expect(moved.body.settings.timezone).toBe('Australia/Perth');

    const left = await agentA.post(`${SETTINGS}/region/generic`).send({});
    expect(left.status).toBe(200);
    expect(left.body.settings.region).toBe('GENERIC');
    expect(left.body.settings.gst).toBeNull();
    expect(await accountName(userA.orgId, '2150')).toBe('ATO Clearing');
  });
});
