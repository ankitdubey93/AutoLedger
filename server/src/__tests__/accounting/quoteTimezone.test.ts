import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, type Agent } from '../helpers/accountingFixtures.js';

/**
 * Phase 42 slice B — quote dates follow the organization's timezone
 * (`ledger_settings.timezone`). Integration tier, real PostgreSQL, fixed clock.
 *
 * At 2026-10-10T12:00Z it is already 2026-10-11 02:00 in Pacific/Kiritimati
 * (UTC+14) and still 2026-10-10 01:00 in Pacific/Pago_Pago (UTC-11).
 */

const app = createApp();
const QUOTES = '/api/v1/quotes';
const SETTINGS = '/api/v1/settings';
const SEND_TIME = '2026-10-10T00:30:00Z'; // Oct 10 in Kiritimati, Oct 9 in Pago Pago: sending is legal in both
const CHECK_TIME = '2026-10-10T12:00:00Z';

let userA: SeededUser;
let userB: SeededUser;
let agentA: Agent;
let agentB: Agent;
let quoteA: string;
let quoteB: string;

/** Onboarding creates the org's `ledger_settings` row, where the timezone lives. */
async function onboard(agent: Agent, timezone: string): Promise<void> {
  const res = await agent.post(`${SETTINGS}/onboarding`).send({
    organizationName: 'Org',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
    timezone,
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`fixture: onboarding failed ${res.status} ${res.text}`);
}

async function sentQuote(agent: Agent, user: SeededUser, partyId: string): Promise<string> {
  const create = await agent.post(QUOTES).send({
    partyId,
    quoteDate: '2026-10-09',
    validUntil: '2026-10-10',
    lines: [
      {
        description: 'Work',
        quantityMilli: 1000,
        unitPriceCents: 10000,
        accountId: await accountId(user.orgId, '4100'),
        taxRateBp: 0,
      },
    ],
  });
  if (create.status !== 201) throw new Error(`fixture: quote create failed ${create.status} ${create.text}`);
  const id = create.body.quote.id as string;
  const send = await agent.post(`${QUOTES}/${id}/send`).send({ delivery: 'MANUAL' });
  if (send.status !== 200) throw new Error(`fixture: quote send failed ${send.status} ${send.text}`);
  return id;
}

beforeEach(async () => {
  await resetTables();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(SEND_TIME));
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  const customerA = await createCustomer(agentA, 'Acme Fitouts', 'buyer@acme.test');
  const customerB = await createCustomer(agentB, 'Bravo Buyer', 'buyer@bravo.test');
  await onboard(agentA, 'Pacific/Kiritimati');
  await onboard(agentB, 'Pacific/Pago_Pago');
  quoteA = await sentQuote(agentA, userA, customerA);
  quoteB = await sentQuote(agentB, userB, customerB);
  // Jump to midday UTC; the 15-minute access tokens have expired, so sign in again.
  vi.setSystemTime(new Date(CHECK_TIME));
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(closePool);

describe('quote dates in the organization timezone', () => {
  it('a quote valid until 2026-10-10 reads EXPIRED in Kiritimati and SENT in Pago Pago', async () => {
    const a = (await agentA.get(`${QUOTES}/${quoteA}`)).body.quote;
    const b = (await agentB.get(`${QUOTES}/${quoteB}`)).body.quote;
    expect(a).toMatchObject({ status: 'SENT', effectiveStatus: 'EXPIRED' });
    expect(b).toMatchObject({ status: 'SENT', effectiveStatus: 'SENT' });
  });

  it('accepting in Kiritimati is 409; in Pago Pago it succeeds', async () => {
    const a = await agentA.post(`${QUOTES}/${quoteA}/accept`).send({ signerName: 'Jane Doe' });
    expect(a.status).toBe(409);
    const b = await agentB.post(`${QUOTES}/${quoteB}/accept`).send({ signerName: 'Jane Doe' });
    expect(b.status).toBe(200);
  });

  it('the sweep expires the Kiritimati quote only', async () => {
    const { expireQuotesForOrg } = await import('../../services/accounting/quoteService.js');
    expect(await expireQuotesForOrg(userA.orgId)).toBe(1);
    expect(await expireQuotesForOrg(userB.orgId)).toBe(0);
  });

  it('PATCH /settings with timezone "Not/AZone" → 400 Unknown time zone', async () => {
    const res = await agentA.patch(SETTINGS).send({ timezone: 'Not/AZone' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Unknown time zone');
  });
});
