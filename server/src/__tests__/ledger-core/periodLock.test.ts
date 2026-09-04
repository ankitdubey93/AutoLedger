import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — the closed-period posting guard (Phase 4, Slice B).
 * Integration tier, real PostgreSQL.
 *
 * Proves the invariant at both layers, like 004's balance trigger: the
 * service check in journalService (via fiscalPeriodService.assertPeriodOpenOnClient)
 * and 016's database trigger independently. Includes this module's own
 * cross-tenant isolation case (rule 15).
 */

const app = createApp();
const JOURNALS = '/api/v1/ledger-core/journals';
const PERIODS = '/api/v1/ledger-core/fiscal-periods';
const ONBOARDING = '/api/v1/ledger-core/settings/onboarding';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const INVOICES = '/api/v1/ledger-core/invoices';

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;
let orgB: string;

type Agent = Awaited<ReturnType<typeof loginAgent>>;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

async function onboard(agent: Agent, overrides: Record<string, unknown> = {}) {
  const res = await agent.post(ONBOARDING).send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
    ...overrides,
  });
  if (res.status !== 200) throw new Error(`fixture: onboarding failed ${res.status} ${res.text}`);
  return res;
}

async function journalPayload(orgId: string, entryDate: string) {
  return {
    entryDate,
    description: 'Test entry',
    lines: [
      { accountId: await accountId(orgId, '1110'), debitCents: 10000, creditCents: 0 },
      { accountId: await accountId(orgId, '4100'), debitCents: 0, creditCents: 10000 },
    ],
  };
}

/** Generates 12 periods for a Jan-1 fiscal year and returns id-by-month-prefix. */
async function generatePeriods(agent: Agent): Promise<Map<string, string>> {
  await onboard(agent);
  const res = await agent.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });
  const byMonth = new Map<string, string>();
  for (const period of res.body.periods) {
    byMonth.set((period.startsOn as string).slice(0, 7), period.id as string);
  }
  return byMonth;
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  orgA = userA.orgId;

  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Charlie' });
  orgB = userC.orgId;
});

afterAll(async () => {
  await closePool();
});

describe('service path', () => {
  it('refuses a posting dated inside a closed period', async () => {
    const agent = await loginAgent(app, userA);
    const periods = await generatePeriods(agent);
    const januaryId = periods.get('2026-01')!;
    await agent.post(`${PERIODS}/${januaryId}/close`);

    const res = await agent.post(JOURNALS).send(await journalPayload(orgA, '2026-01-15'));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(
      'The fiscal period covering 2026-01-15 is closed; reopen it or post to an open period',
    );
  });

  it('refuses a posting dated inside a locked period', async () => {
    const agent = await loginAgent(app, userA);
    const periods = await generatePeriods(agent);
    const februaryId = periods.get('2026-02')!;
    await agent.post(`${PERIODS}/${februaryId}/close`);
    await agent.post(`${PERIODS}/${februaryId}/lock`);

    const res = await agent.post(JOURNALS).send(await journalPayload(orgA, '2026-02-10'));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('is locked');
  });

  it('allows a posting dated inside an open period, and again after reopening', async () => {
    const agent = await loginAgent(app, userA);
    const periods = await generatePeriods(agent);
    const januaryId = periods.get('2026-01')!;

    const marchRes = await agent.post(JOURNALS).send(await journalPayload(orgA, '2026-03-10'));
    expect(marchRes.status).toBe(201);

    await agent.post(`${PERIODS}/${januaryId}/close`);
    const closedRes = await agent.post(JOURNALS).send(await journalPayload(orgA, '2026-01-15'));
    expect(closedRes.status).toBe(422);

    await agent.post(`${PERIODS}/${januaryId}/reopen`);
    const reopenedRes = await agent.post(JOURNALS).send(await journalPayload(orgA, '2026-01-15'));
    expect(reopenedRes.status).toBe(201);
  });

  it('allows a posting when no periods have ever been generated', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);

    const res = await agent.post(JOURNALS).send(await journalPayload(orgA, '2026-01-15'));

    expect(res.status).toBe(201);
  });
});

describe('trigger path — bypassing the service entirely', () => {
  it('rejects a raw INSERT into journal_entries dated in a closed period', async () => {
    const agent = await loginAgent(app, userA);
    const periods = await generatePeriods(agent);
    const januaryId = periods.get('2026-01')!;
    await agent.post(`${PERIODS}/${januaryId}/close`);

    let code: string | undefined;
    let message = '';
    try {
      await pool.query(
        `INSERT INTO journal_entries (org_id, created_by, entry_date, description)
         VALUES ($1, $2, '2026-01-15', 'raw sql')`,
        [orgA, userA.id],
      );
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err) {
        code = typeof err.code === 'string' ? err.code : undefined;
      }
      message = err instanceof Error ? err.message : String(err);
    }

    expect(code).toBe('P0001');
    expect(message).toContain('postings into a closed period');
  });

  it('rejects a raw INSERT into ledger_lines attached to an entry whose period has since closed', async () => {
    const agent = await loginAgent(app, userA);
    const periods = await generatePeriods(agent);
    const marchId = periods.get('2026-03')!;

    const posted = await agent.post(JOURNALS).send(await journalPayload(orgA, '2026-03-10'));
    expect(posted.status).toBe(201);
    const entryId = posted.body.entry.id as string;

    await agent.post(`${PERIODS}/${marchId}/close`);

    const cashAccount = await accountId(orgA, '1110');
    let code: string | undefined;
    try {
      await pool.query(
        `INSERT INTO ledger_lines
           (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
            currency_code, fx_rate, base_debit_cents, base_credit_cents)
         VALUES ($1, $2, $3, 100, 0, 'USD', 1, 100, 0)`,
        [orgA, entryId, cashAccount],
      );
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err) {
        code = typeof err.code === 'string' ? err.code : undefined;
      }
    }

    expect(code).toBe('P0001');
  });
});

describe('reversal and cross-document posting are blocked too', () => {
  it('refuses to reverse an entry whose period has since closed', async () => {
    const agent = await loginAgent(app, userA);
    const periods = await generatePeriods(agent);
    const marchId = periods.get('2026-03')!;

    const posted = await agent.post(JOURNALS).send(await journalPayload(orgA, '2026-03-10'));
    const entryId = posted.body.entry.id as string;

    await agent.post(`${PERIODS}/${marchId}/close`);

    const res = await agent.post(`${JOURNALS}/${entryId}/reverse`).send({});
    expect(res.status).toBe(422);
  });

  it('refuses to issue an invoice whose issue date falls in a closed period', async () => {
    const agent = await loginAgent(app, userA);
    const periods = await generatePeriods(agent);
    const januaryId = periods.get('2026-01')!;

    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Northwind Traders' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');

    const invoiceRes = await agent.post(INVOICES).send({
      customerId,
      issueDate: '2026-01-20',
      dueDate: '2026-02-20',
      notes: null,
      paymentTerms: null,
      lines: [
        {
          description: 'Consulting hours',
          quantityMilli: 1000,
          unitPriceCents: 10000,
          revenueAccountId,
          taxRateBp: 0,
        },
      ],
    });
    expect(invoiceRes.status).toBe(201);
    const invoiceId = invoiceRes.body.invoice.id as string;

    await agent.post(`${PERIODS}/${januaryId}/close`);

    const res = await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('is closed');
  });
});

describe('cross-tenant isolation', () => {
  it("a closed period in one organization never blocks another organization's postings", async () => {
    const agentA = await loginAgent(app, userA);
    const periodsA = await generatePeriods(agentA);
    const januaryIdA = periodsA.get('2026-01')!;
    await agentA.post(`${PERIODS}/${januaryIdA}/close`);

    const agentB = await loginAgent(app, userC);
    await onboard(agentB);

    const res = await agentB.post(JOURNALS).send(await journalPayload(orgB, '2026-01-15'));

    expect(res.status).toBe(201);
  });
});
