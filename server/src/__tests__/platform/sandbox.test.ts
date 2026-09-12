import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { pool } from '../../db/connect.js';
import { runIntegrityChecks } from '../../db/integrity.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import * as cohortService from '../../services/unitecon/cohortService.js';
import * as pvmService from '../../services/unitecon/pvmService.js';

/**
 * Integration tier — Phase 18, the sandbox dataset. This suite actually
 * loads the full 24-month dataset at least once (a real end-to-end proof,
 * not a mock), so it is one of the slower files in this repo by design —
 * every write goes through the real services, same as it would for a user
 * clicking "Load sample data".
 */

const app = createApp();
const BASE = '/api/v1/sandbox';

async function switchTo(agent: Awaited<ReturnType<typeof loginAgent>>, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

describe('sandbox API', () => {
  let orgA: SeededUser;
  let orgB: SeededUser;
  let accountantA: SeededUser;
  let adminA: SeededUser;

  beforeEach(async () => {
    await resetTables();
    orgA = await createUserWithOrg({ label: 'owner-a', orgName: 'Org Alpha' });
    orgB = await createUserWithOrg({ label: 'owner-b', orgName: 'Org Bravo' });

    accountantA = await createUserWithOrg({ label: 'acct-a', orgName: 'Org Acct Solo' });
    await addMember(orgA.orgId, accountantA.id, 'ACCOUNTANT');

    adminA = await createUserWithOrg({ label: 'admin-a', orgName: 'Org Admin Solo' });
    await addMember(orgA.orgId, adminA.id, 'ADMIN');
  });

  afterAll(closePool);

  it('GET /sandbox reports loaded: false before load', async () => {
    const agent = await loginAgent(app, orgA);
    const res = await agent.get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.sandbox).toEqual({ loaded: false, dataset: null });
  });

  it(
    'POST /sandbox/load seeds the dataset and returns 201 with counts, and GET reports loaded: true after',
    async () => {
      const agent = await loginAgent(app, orgA);
      const res = await agent.post(`${BASE}/load`);

      expect(res.status).toBe(201);
      expect(res.body.dataset.datasetVersion).toBe('1.0.0');
      expect(res.body.dataset.counts.customers).toBeGreaterThan(0);
      expect(res.body.dataset.counts.invoices).toBeGreaterThan(0);
      expect(res.body.dataset.counts.forecastPlans).toBe(1);
      expect(res.body.dataset.counts.fpaModels).toBe(1);
      expect(res.body.dataset.counts.corpusDocuments).toBe(1);

      const status = await agent.get(BASE);
      expect(status.body.sandbox.loaded).toBe(true);
      expect(status.body.sandbox.dataset.datasetVersion).toBe('1.0.0');
    },
    120_000,
  );

  it(
    'the seeded trial balance balances and runIntegrityChecks passes',
    async () => {
      const agent = await loginAgent(app, orgA);
      const loadRes = await agent.post(`${BASE}/load`);
      expect(loadRes.status).toBe(201);

      const { rows } = await pool.query<{ debit: string; credit: string }>(
        `SELECT COALESCE(SUM(base_debit_cents), 0)::text AS debit,
                COALESCE(SUM(base_credit_cents), 0)::text AS credit
           FROM ledger_lines WHERE org_id = $1`,
        [orgA.orgId],
      );
      const row = rows[0];
      expect(row).toBeDefined();
      expect(row?.debit).toBe(row?.credit);

      const report = await runIntegrityChecks();
      expect(report.passed).toBe(true);
    },
    120_000,
  );

  it(
    'a second POST /sandbox/load returns 409',
    async () => {
      const agent = await loginAgent(app, orgA);
      const first = await agent.post(`${BASE}/load`);
      expect(first.status).toBe(201);

      const second = await agent.post(`${BASE}/load`);
      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/already loaded/i);
    },
    120_000,
  );

  it(
    'refuses a reload after unload with a clear reason, and leaves no marker claiming success',
    async () => {
      const agent = await loginAgent(app, orgA);
      expect((await agent.post(`${BASE}/load`)).status).toBe(201);

      // Unload clears the marker only — the seeded records stay, because
      // posted documents are immutable. So a reload would otherwise try to
      // seed on top of them.
      expect((await agent.delete(BASE)).status).toBe(200);

      const reload = await agent.post(`${BASE}/load`);
      expect(reload.status).toBe(409);
      // The real reason, not a leaked `Account code already exists` from
      // whichever service happened to notice first.
      expect(reload.body.error).toMatch(/already contains sample data/i);

      // And critically: the failed attempt must not leave a marker behind
      // saying "loaded" with all-zero counts — a marker that lies.
      const status = await agent.get(BASE);
      expect(status.body.sandbox).toEqual({ loaded: false, dataset: null });
    },
    180_000,
  );

  it('DELETE /sandbox with nothing loaded returns 409', async () => {
    const agent = await loginAgent(app, orgA);
    const res = await agent.delete(BASE);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no sample data/i);
  });

  it(
    'DELETE /sandbox after a load removes the marker and GET reports loaded: false again',
    async () => {
      const agent = await loginAgent(app, orgA);
      const loadRes = await agent.post(`${BASE}/load`);
      expect(loadRes.status).toBe(201);

      const deleteRes = await agent.delete(BASE);
      expect(deleteRes.status).toBe(200);

      const status = await agent.get(BASE);
      expect(status.body.sandbox).toEqual({ loaded: false, dataset: null });
    },
    120_000,
  );

  it('POST /sandbox/load as ACCOUNTANT (of org A) returns 403', async () => {
    const agent = await switchTo(await loginAgent(app, accountantA), orgA.orgId);
    const res = await agent.post(`${BASE}/load`);
    expect(res.status).toBe(403);
  });

  it('POST /sandbox/load as ADMIN (of org A) returns 403', async () => {
    const agent = await switchTo(await loginAgent(app, adminA), orgA.orgId);
    const res = await agent.post(`${BASE}/load`);
    expect(res.status).toBe(403);
  });

  it('DELETE /sandbox as ACCOUNTANT (of org A) returns 403', async () => {
    const agent = await switchTo(await loginAgent(app, accountantA), orgA.orgId);
    const res = await agent.delete(BASE);
    expect(res.status).toBe(403);
  });

  // ------------------------------------------------------- data-realism guards
  // A regression in the fixtures could silently empty the demo without
  // failing any of the tests above (they only check counts, not shape). One
  // load, several assertions, to keep the suite from paying for the
  // expensive seed more than once per case.

  it(
    'the seeded dataset produces real analytics: cohort decay, FX exclusion, and both close-run outcomes',
    async () => {
      const agent = await loginAgent(app, orgA);
      const loadRes = await agent.post(`${BASE}/load`);
      expect(loadRes.status).toBe(201);
      const anchorMonth = loadRes.body.dataset.anchorMonth as string;

      // Cohorts: a window starting near the earliest customer's acquisition
      // month must show at least one cohort whose retention drops below
      // 100% — proving real churn, not a flat, meaningless matrix.
      const [anchorYear, anchorMonthNum] = anchorMonth.split('-').map(Number);
      const earlyFrom = `${String((anchorYear ?? 2026) - 2).padStart(4, '0')}-${String(anchorMonthNum ?? 1).padStart(2, '0')}-01`;
      const cohorts = await cohortService.cohortMatrix(orgA.orgId, earlyFrom, anchorMonth);
      expect(cohorts.matrix.rows.length).toBeGreaterThanOrEqual(3);
      const anyChurned = cohorts.matrix.rows.some((row) =>
        row.cells.some((cell) => cell.retentionBps < 10000),
      );
      expect(anyChurned).toBe(true);

      // PVM: the two FX customers must be reported as excluded, never
      // silently folded into the base-currency decomposition.
      const pvm = await pvmService.pvmReport(
        orgA.orgId,
        { from: anchorMonth, to: anchorMonth },
        { from: earlyFrom, to: earlyFrom },
      );
      expect(pvm.excludedForeignCurrencyInvoices).toBeGreaterThan(0);

      // BoardDeck: both the READY and BLOCKED outcomes must exist among the
      // seeded close runs, or the demo only ever shows one state.
      const { rows: runRows } = await pool.query<{ status: string }>(
        'SELECT status FROM boarddeck_close_runs WHERE org_id = $1',
        [orgA.orgId],
      );
      const statuses = runRows.map((r) => r.status);
      expect(statuses).toContain('READY');
      expect(statuses).toContain('BLOCKED');

      // Bank reconciliation: both a real auto-match and a real leftover for
      // the approval queue must exist.
      const { rows: bankStatusRows } = await pool.query<{ status: string; count: string }>(
        'SELECT status, count(*)::text AS count FROM bank_transactions WHERE org_id = $1 GROUP BY status',
        [orgA.orgId],
      );
      const bankStatuses = new Set(bankStatusRows.map((r) => r.status));
      expect(bankStatuses.has('MATCHED')).toBe(true);
      expect(bankStatuses.has('UNMATCHED')).toBe(true);
    },
    120_000,
  );

  // ------------------------------------------------------- cross-tenant isolation

  it(
    'org B sees loaded: false after org A loads, and none of org A\'s seeded rows',
    async () => {
      const agentA = await loginAgent(app, orgA);
      const loadRes = await agentA.post(`${BASE}/load`);
      expect(loadRes.status).toBe(201);

      const agentB = await loginAgent(app, orgB);
      const statusB = await agentB.get(BASE);
      expect(statusB.body.sandbox).toEqual({ loaded: false, dataset: null });

      const { rows: customerRows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM customers WHERE org_id = $1',
        [orgB.orgId],
      );
      expect(customerRows[0]?.count).toBe('0');

      const { rows: invoiceRows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM invoices WHERE org_id = $1',
        [orgB.orgId],
      );
      expect(invoiceRows[0]?.count).toBe('0');

      const { rows: bankRows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM bank_transactions WHERE org_id = $1',
        [orgB.orgId],
      );
      expect(bankRows[0]?.count).toBe('0');
    },
    120_000,
  );

  it(
    'a forged orgId in query, header, and body is ignored on GET /sandbox',
    async () => {
      const agentA = await loginAgent(app, orgA);
      const loadRes = await agentA.post(`${BASE}/load`);
      expect(loadRes.status).toBe(201);

      const honest = await agentA.get(BASE);
      const forged = await agentA
        .get(BASE)
        .query({ orgId: orgB.orgId })
        .set('X-Org-Id', orgB.orgId)
        .send({ orgId: orgB.orgId });

      expect(forged.status).toBe(200);
      // Byte-identical: none of those three inputs is even consulted — orgId
      // comes only from the verified access token (guardrails rule 1).
      expect(forged.body).toEqual(honest.body);
    },
    120_000,
  );

  it(
    'org B loading its own sandbox does not affect org A\'s already-loaded dataset',
    async () => {
      const agentA = await loginAgent(app, orgA);
      const loadA = await agentA.post(`${BASE}/load`);
      expect(loadA.status).toBe(201);
      const countsA = loadA.body.dataset.counts;

      const agentB = await loginAgent(app, orgB);
      const loadB = await agentB.post(`${BASE}/load`);
      expect(loadB.status).toBe(201);

      const statusA = await agentA.get(BASE);
      expect(statusA.body.sandbox.dataset.counts).toEqual(countsA);
    },
    180_000,
  );
});
