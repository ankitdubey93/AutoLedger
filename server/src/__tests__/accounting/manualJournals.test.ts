import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, issueInvoice } from '../helpers/accountingFixtures.js';
import { firstDayOfNextMonth } from '../../utils/recurrence.js';

/**
 * Accounting — manual journals (Phase 44). Integration tier, real PostgreSQL.
 * Covers the draft/post/void FSM, the system-account refusals, the DB
 * triggers (bypassing the API), rollback on a closed period, the GL
 * register's reverse route, and repeating journals. The cross-tenant suite
 * is manualJournalIsolation.test.ts.
 */

const app = createApp();
const M = '/api/v1/manual-journals';
const JOURNALS = '/api/v1/journals';
const TRIAL_BALANCE = '/api/v1/reports/trial-balance';
const RECURRING = '/api/v1/recurring-schedules';
const ACCOUNTS = '/api/v1/accounts';
const ONBOARDING = '/api/v1/settings/onboarding';
const PERIODS = '/api/v1/fiscal-periods';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let orgA: string;
let agent: Agent;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

interface LineSpec {
  accountId: string | null;
  description?: string | null;
  debitCents?: number;
  creditCents?: number;
}

function lineBody(l: LineSpec) {
  return {
    accountId: l.accountId,
    description: l.description ?? null,
    debitCents: l.debitCents ?? 0,
    creditCents: l.creditCents ?? 0,
  };
}

/** The balanced pair: DR 6120 (Expense) / CR 2120 (Liability). */
async function pair(amountCents: number) {
  return [
    lineBody({ accountId: await accountId(orgA, '6120'), description: 'Rent expense', debitCents: amountCents }),
    lineBody({ accountId: await accountId(orgA, '2120'), description: 'Rent accrued', creditCents: amountCents }),
  ];
}

async function body(overrides: Record<string, unknown> = {}) {
  return { narration: 'Accrued rent', entryDate: '2026-03-15', lines: await pair(10000), ...overrides };
}

async function posted(overrides: Record<string, unknown> = {}) {
  const res = await agent.post(M).send({ ...(await body(overrides)), action: 'post' });
  if (res.status !== 201) throw new Error(`fixture: post failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.journal as Record<string, any>;
}

async function draft(overrides: Record<string, unknown> = {}) {
  const res = await agent.post(M).send({ ...(await body(overrides)), action: 'draft' });
  if (res.status !== 201) throw new Error(`fixture: draft failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.journal as Record<string, any>;
}

async function tbNet(code: string): Promise<number> {
  const res = await agent.get(TRIAL_BALANCE).query({ asOf: '2026-12-31' });
  const row = (res.body.rows as Array<{ code: string; netBalanceCents: number }>).find((r) => r.code === code);
  if (row === undefined) throw new Error(`no trial balance row for ${code}`);
  return row.netBalanceCents;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'mj-a', orgName: 'Manual Journal Org' });
  orgA = userA.orgId;
  agent = await loginAgent(app, userA);
});

afterAll(closePool);

describe('drafts', () => {
  it('POST action=draft with one unbalanced line -> 201, DRAFT, no journal entry', async () => {
    const res = await agent.post(M).send({
      narration: 'Half done',
      entryDate: '2026-03-15',
      lines: [lineBody({ accountId: await accountId(orgA, '6120'), debitCents: 10000 })],
      action: 'draft',
    });
    expect(res.status).toBe(201);
    expect(res.body.journal.status).toBe('DRAFT');
    expect(res.body.journal.journalEntryId).toBeNull();
  });

  it('POST action=draft with an empty line (no account, 0/0) -> 201', async () => {
    const res = await agent.post(M).send({
      narration: 'Blank row',
      entryDate: '2026-03-15',
      lines: [lineBody({ accountId: null })],
      action: 'draft',
    });
    expect(res.status).toBe(201);
    expect(res.body.journal.lines).toHaveLength(1);
  });

  it('PATCH on a draft replaces narration and lines', async () => {
    const d = await draft();
    const lines = [...(await pair(500)), ...(await pair(700))];
    const res = await agent.patch(`${M}/${d.id}`).send({ narration: 'Replaced', entryDate: '2026-03-16', lines });
    expect(res.status).toBe(200);
    expect(res.body.journal.narration).toBe('Replaced');
    expect(res.body.journal.lines).toHaveLength(4);
  });

  it('DELETE on a draft -> 204, then GET -> 404', async () => {
    const d = await draft();
    expect((await agent.delete(`${M}/${d.id}`)).status).toBe(204);
    expect((await agent.get(`${M}/${d.id}`)).status).toBe(404);
  });
});

describe('post-time rules', () => {
  it('POST /:id/post on an unbalanced draft -> 422 and the draft stays DRAFT', async () => {
    const d = await draft({
      lines: [
        lineBody({ accountId: await accountId(orgA, '6120'), debitCents: 10000 }),
        lineBody({ accountId: await accountId(orgA, '2120'), creditCents: 5000 }),
      ],
    });
    const res = await agent.post(`${M}/${d.id}/post`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Journal is unbalanced: debits 10000, credits 5000');
    expect((await agent.get(`${M}/${d.id}`)).body.journal.status).toBe('DRAFT');
  });

  it('POST /:id/post with a line missing an account -> 422 naming line 2', async () => {
    const d = await draft({
      lines: [lineBody({ accountId: await accountId(orgA, '6120'), debitCents: 10000 }), lineBody({ accountId: null, creditCents: 10000 })],
    });
    const res = await agent.post(`${M}/${d.id}/post`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Line 2 has no account');
  });

  it('POST action=post balanced -> POSTED; the GL entry carries manualJournalId and line descriptions', async () => {
    const j = await posted();
    expect(j.status).toBe('POSTED');
    expect(j.journalEntryId).toBeTruthy();

    const entry = (await agent.get(`${JOURNALS}/${j.journalEntryId}`)).body.entry;
    expect(entry.manualJournalId).toBe(j.id);
    expect(entry.lines.map((l: { description: string | null }) => l.description).sort()).toEqual([
      'Rent accrued',
      'Rent expense',
    ]);
  });

  it("narration 'Accrual [Month]' dated 2026-03-15 posts as 'Accrual March'", async () => {
    const j = await posted({ narration: 'Accrual [Month]', entryDate: '2026-03-15' });
    expect(j.narration).toBe('Accrual March');
    expect(j.narrationTemplate).toBe('Accrual [Month]');
  });

  it('PATCH and DELETE on a POSTED journal -> 409', async () => {
    const j = await posted();
    const patch = await agent.patch(`${M}/${j.id}`).send(await body());
    expect(patch.status).toBe(409);
    expect((await agent.delete(`${M}/${j.id}`)).status).toBe(409);
  });
});

describe('void', () => {
  it('POST /:id/void -> VOIDED with a reversal; the trial balance nets to zero', async () => {
    const j = await posted();
    expect(await tbNet('6120')).toBe(10000);

    const res = await agent.post(`${M}/${j.id}/void`).send({});
    expect(res.status).toBe(200);
    expect(res.body.journal.status).toBe('VOIDED');
    expect(res.body.journal.voidJournalEntryId).toBeTruthy();
    expect(await tbNet('6120')).toBe(0);
    expect(await tbNet('2120')).toBe(0);
  });

  it('void twice -> 409', async () => {
    const j = await posted();
    expect((await agent.post(`${M}/${j.id}/void`).send({})).status).toBe(200);
    expect((await agent.post(`${M}/${j.id}/void`).send({})).status).toBe(409);
  });

  it('voiding a draft -> 409', async () => {
    const d = await draft();
    expect((await agent.post(`${M}/${d.id}/void`).send({})).status).toBe(409);
  });
});

describe('system accounts are refused', () => {
  it('1110 (bank) -> 422 with the BANK message', async () => {
    const res = await agent.post(M).send({
      ...(await body({
        lines: [
          lineBody({ accountId: await accountId(orgA, '1110'), debitCents: 100 }),
          lineBody({ accountId: await accountId(orgA, '4100'), creditCents: 100 }),
        ],
      })),
      action: 'post',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(
      'Account 1110 is a bank account — record money in or out of it through Banking (a bank-line journal or a payment), not a manual journal',
    );
  });

  it('an account flagged CREDIT_CARD -> 422 with the CREDIT_CARD message', async () => {
    const created = await agent.post(ACCOUNTS).send({
      code: '2250',
      name: 'Company Card',
      type: 'Liability',
      bankAccountKind: 'CREDIT_CARD',
    });
    expect(created.status).toBe(201);
    const res = await agent.post(M).send({
      ...(await body({
        lines: [
          lineBody({ accountId: await accountId(orgA, '6120'), debitCents: 100 }),
          lineBody({ accountId: created.body.account.id, creditCents: 100 }),
        ],
      })),
      action: 'post',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(
      'Account 2250 is a credit card account — record money in or out of it through Banking (a bank-line journal or a payment), not a manual journal',
    );
  });

  it('1120 (receivable) -> 422 with the unchanged receivable message', async () => {
    const res = await agent.post(M).send({
      ...(await body({
        lines: [
          lineBody({ accountId: await accountId(orgA, '1120'), debitCents: 100 }),
          lineBody({ accountId: await accountId(orgA, '4100'), creditCents: 100 }),
        ],
      })),
      action: 'post',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(
      'Account 1120 is the receivable control account — post to it through an invoice or a payment, not a journal entry',
    );
  });
});

describe('closed periods roll back', () => {
  it('posting into a locked period -> 422 and the draft stays DRAFT', async () => {
    await agent.post(ONBOARDING).send({
      organizationName: 'Acme Books',
      baseCurrency: 'USD',
      fiscalYearStartMonth: 1,
      booksStartDate: '2026-01-01',
    });
    const gen = await agent.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });
    const march = (gen.body.periods as Array<{ id: string; startsOn: string }>).find((p) =>
      p.startsOn.startsWith('2026-03'),
    );
    if (march === undefined) throw new Error('fixture: no March period');
    const d = await draft({ entryDate: '2026-03-10' });
    await agent.post(`${PERIODS}/${march.id}/close`);

    const res = await agent.post(`${M}/${d.id}/post`).send({});
    expect(res.status).toBe(422);
    expect((await agent.get(`${M}/${d.id}`)).body.journal.status).toBe('DRAFT');
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM journal_entries WHERE org_id = $1',
      [orgA],
    );
    expect(rows[0]?.n).toBe('0');
  });
});

describe('database triggers (bypassing the API)', () => {
  it('UPDATE on a POSTED manual_journals row -> 0A000', async () => {
    const j = await posted();
    await expect(
      pool.query("UPDATE manual_journals SET narration = 'x' WHERE id = $1 AND org_id = $2", [j.id, orgA]),
    ).rejects.toMatchObject({ code: '0A000' });
  });

  it('INSERT into manual_journal_lines of a POSTED journal -> 0A000', async () => {
    const j = await posted();
    await expect(
      pool.query(
        `INSERT INTO manual_journal_lines (org_id, manual_journal_id, line_number) VALUES ($1, $2, 99)`,
        [orgA, j.id],
      ),
    ).rejects.toMatchObject({ code: '0A000' });
  });
});

describe('listing', () => {
  it('?status=draft returns only drafts; counts.all excludes TEMPLATE rows', async () => {
    await draft();
    await posted();
    const tpl = await agent.post(`${M}/repeating`).send({
      ...(await body()),
      name: 'Tpl',
      frequency: 'MONTHLY',
      startDate: today(),
    });
    expect(tpl.status).toBe(201);

    const res = await agent.get(M).query({ status: 'draft' });
    expect(res.status).toBe(200);
    expect(res.body.journals).toHaveLength(1);
    expect(res.body.journals[0].status).toBe('DRAFT');
    expect(res.body.counts).toMatchObject({ all: 2, draft: 1, posted: 1, voided: 0 });
  });
});

describe('the GL register routes', () => {
  it("POST /journals/:entryId/reverse on a manual journal's entry voids the journal", async () => {
    const j = await posted();
    const res = await agent.post(`${JOURNALS}/${j.journalEntryId}/reverse`).send({});
    expect(res.status).toBe(201);
    expect((await agent.get(`${M}/${j.id}`)).body.journal.status).toBe('VOIDED');
  });

  it("POST /journals/:invoiceEntryId/reverse on an issued invoice's entry -> 409", async () => {
    const customerId = await createCustomer(agent, 'Reverse Guard Customer');
    const invoice = await issueInvoice(agent, orgA, customerId, 5000, '2026-06-01', '2026-06-30');
    const { rows } = await pool.query<{ journal_entry_id: string }>(
      'SELECT journal_entry_id FROM invoices WHERE id = $1 AND org_id = $2',
      [invoice.id, orgA],
    );
    const entryId = rows[0]?.journal_entry_id;
    expect(entryId).toBeTruthy();

    const res = await agent.post(`${JOURNALS}/${entryId}/reverse`).send({});
    expect(res.status).toBe(409);
  });

  it('POST /journals (legacy shorthand) -> 201 and a POSTED manual journal exists for the entry', async () => {
    const res = await agent.post(JOURNALS).send({
      entryDate: '2026-03-15',
      description: 'Legacy',
      lines: [
        { accountId: await accountId(orgA, '6120'), debitCents: 300, creditCents: 0 },
        { accountId: await accountId(orgA, '2120'), debitCents: 0, creditCents: 300 },
      ],
    });
    expect(res.status).toBe(201);
    const { rows } = await pool.query<{ status: string; origin: string }>(
      'SELECT status, origin FROM manual_journals WHERE org_id = $1 AND journal_entry_id = $2',
      [orgA, res.body.entry.id],
    );
    expect(rows).toEqual([{ status: 'POSTED', origin: 'MANUAL' }]);
  });
});

describe('repeating journals', () => {
  async function createRepeating(overrides: Record<string, unknown> = {}) {
    return agent.post(`${M}/repeating`).send({
      ...(await body({ narration: 'Rent [Month]', entryDate: today() })),
      name: 'Monthly rent',
      frequency: 'MONTHLY',
      intervalCount: 1,
      startDate: today(),
      endDate: null,
      autoReverse: true,
      ...overrides,
    });
  }

  it('POST /repeating -> 201, TEMPLATE journal linked to the schedule', async () => {
    const res = await createRepeating();
    expect(res.status).toBe(201);
    expect(res.body.journal.status).toBe('TEMPLATE');
    expect(res.body.schedule.sourceManualJournalId).toBe(res.body.journal.id);
  });

  it('running the schedule posts a RECURRING manual journal and its reversal, which stays POSTED', async () => {
    const created = await createRepeating();
    const scheduleId = created.body.schedule.id as string;

    const run = await agent.post(`${RECURRING}/${scheduleId}/run`).send({});
    expect(run.status).toBeLessThan(300);

    const list = await agent.get(M).query({ status: 'posted' });
    const generated = (list.body.journals as Array<Record<string, any>>).filter((j) => j.origin === 'RECURRING');
    expect(generated).toHaveLength(1);
    expect(generated[0]?.recurringScheduleId).toBe(scheduleId);
    expect(generated[0]?.status).toBe('POSTED');

    const detail = await agent.get(`${RECURRING}/${scheduleId}`);
    const reversalId = detail.body.schedule.runs[0].reversalEntryId as string;
    const reversal = await agent.get(`${JOURNALS}/${reversalId}`);
    expect(reversal.body.entry.entryDate).toBe(firstDayOfNextMonth(today()));
  });

  it('PATCH on the TEMPLATE: unbalanced -> 422; balanced -> 200 and the next run uses the new lines', async () => {
    const created = await createRepeating({ autoReverse: false });
    const templateId = created.body.journal.id as string;
    const scheduleId = created.body.schedule.id as string;

    const bad = await agent.patch(`${M}/${templateId}`).send(
      await body({
        entryDate: today(),
        lines: [lineBody({ accountId: await accountId(orgA, '6120'), debitCents: 100 })],
      }),
    );
    expect(bad.status).toBe(422);

    const good = await agent.patch(`${M}/${templateId}`).send(await body({ entryDate: today(), lines: await pair(2468) }));
    expect(good.status).toBe(200);

    await agent.post(`${RECURRING}/${scheduleId}/run`).send({});
    const list = await agent.get(M).query({ status: 'posted' });
    const generated = (list.body.journals as Array<Record<string, any>>).find((j) => j.origin === 'RECURRING');
    expect(generated?.totalDebitCents).toBe(2468);
  });

  it('POST /repeating with a bank account line -> 422 and nothing is created', async () => {
    const res = await createRepeating({
      lines: [
        lineBody({ accountId: await accountId(orgA, '1110'), debitCents: 100 }),
        lineBody({ accountId: await accountId(orgA, '4100'), creditCents: 100 }),
      ],
    });
    expect(res.status).toBe(422);
    const { rows } = await pool.query<{ s: string; m: string }>(
      `SELECT (SELECT count(*) FROM recurring_schedules WHERE org_id = $1)::text AS s,
              (SELECT count(*) FROM manual_journals WHERE org_id = $1)::text AS m`,
      [orgA],
    );
    expect(rows[0]).toEqual({ s: '0', m: '0' });
  });
});

