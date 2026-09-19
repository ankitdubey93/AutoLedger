import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { pool } from '../../db/connect.js';
import { runIntegrityChecks } from '../../db/integrity.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import * as cohortService from '../../services/unitecon/cohortService.js';
import * as pvmService from '../../services/unitecon/pvmService.js';

/**
 * Integration tier — Phase 18, the sandbox dataset.
 *
 * Loading the dataset is genuinely expensive (~30s): every write goes through
 * the real services, exactly as it would for a user clicking "Load sample
 * data". That is the point of the file, and it is not mocked here.
 *
 * So the file is organised around **how many loads it has to pay for**, not
 * around which endpoint each case touches:
 *
 *   - `with nothing loaded`  — never loads. The role gates and the empty-state
 *     responses never needed a dataset; they only needed an org.
 *   - `with org A's dataset loaded` — ONE load in `beforeAll`, shared by every
 *     assertion that only reads it back.
 *   - `unload and reload` — pays for its own load in `beforeEach`, because it
 *     destroys the marker it is testing.
 *
 * Previously every case reset and re-seeded, so the file paid for 14 loads and
 * took 5.1 minutes — by itself the slowest file in the repo. It now pays for 3.
 */

const app = createApp();
const BASE = '/api/v1/sandbox';

interface Actors {
  orgA: SeededUser;
  orgB: SeededUser;
  accountantA: SeededUser;
  adminA: SeededUser;
}

/** Two owners each in their own org, plus an ACCOUNTANT and an ADMIN of org A. */
async function seedActors(): Promise<Actors> {
  const orgA = await createUserWithOrg({ label: 'owner-a', orgName: 'Org Alpha' });
  const orgB = await createUserWithOrg({ label: 'owner-b', orgName: 'Org Bravo' });

  const accountantA = await createUserWithOrg({ label: 'acct-a', orgName: 'Org Acct Solo' });
  await addMember(orgA.orgId, accountantA.id, 'ACCOUNTANT');

  const adminA = await createUserWithOrg({ label: 'admin-a', orgName: 'Org Admin Solo' });
  await addMember(orgA.orgId, adminA.id, 'ADMIN');

  return { orgA, orgB, accountantA, adminA };
}

async function switchTo(agent: Awaited<ReturnType<typeof loginAgent>>, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

describe('sandbox API', () => {
  afterAll(closePool);

  // ------------------------------------------------------- no dataset needed
  describe('with nothing loaded', () => {
    let actors: Actors;

    beforeEach(async () => {
      await resetTables();
      actors = await seedActors();
    });

    it('GET /sandbox reports loaded: false before load', async () => {
      const agent = await loginAgent(app, actors.orgA);
      const res = await agent.get(BASE);
      expect(res.status).toBe(200);
      expect(res.body.sandbox).toEqual({ loaded: false, dataset: null });
    });

    it('DELETE /sandbox with nothing loaded returns 409', async () => {
      const agent = await loginAgent(app, actors.orgA);
      const res = await agent.delete(BASE);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/no sample data/i);
    });

    it('POST /sandbox/load as ACCOUNTANT (of org A) returns 403', async () => {
      const agent = await switchTo(await loginAgent(app, actors.accountantA), actors.orgA.orgId);
      const res = await agent.post(`${BASE}/load`);
      expect(res.status).toBe(403);
    });

    it('POST /sandbox/load as ADMIN (of org A) returns 403', async () => {
      const agent = await switchTo(await loginAgent(app, actors.adminA), actors.orgA.orgId);
      const res = await agent.post(`${BASE}/load`);
      expect(res.status).toBe(403);
    });

    it('DELETE /sandbox as ACCOUNTANT (of org A) returns 403', async () => {
      const agent = await switchTo(await loginAgent(app, actors.accountantA), actors.orgA.orgId);
      const res = await agent.delete(BASE);
      expect(res.status).toBe(403);
    });
  });

  // ------------------------------------- ONE load, shared by read-only cases
  describe("with org A's dataset loaded", () => {
    let actors: Actors;
    let loadBody: {
      dataset: {
        datasetVersion: string;
        anchorMonth: string;
        counts: Record<string, number>;
      };
    };

    beforeAll(async () => {
      await resetTables();
      actors = await seedActors();
      const agent = await loginAgent(app, actors.orgA);
      const res = await agent.post(`${BASE}/load`);
      expect(res.status).toBe(201);
      loadBody = res.body;
    }, 180_000);

    it('the load returned 201 with real counts, and GET reports loaded: true', async () => {
      expect(loadBody.dataset.datasetVersion).toBe('1.0.0');
      expect(loadBody.dataset.counts.customers).toBeGreaterThan(0);
      expect(loadBody.dataset.counts.invoices).toBeGreaterThan(0);
      expect(loadBody.dataset.counts.forecastPlans).toBe(1);
      expect(loadBody.dataset.counts.fpaModels).toBe(1);
      expect(loadBody.dataset.counts.corpusDocuments).toBe(1);

      const agent = await loginAgent(app, actors.orgA);
      const status = await agent.get(BASE);
      expect(status.body.sandbox.loaded).toBe(true);
      expect(status.body.sandbox.dataset.datasetVersion).toBe('1.0.0');
    });

    it('the seeded trial balance balances and runIntegrityChecks passes', async () => {
      const { rows } = await pool.query<{ debit: string; credit: string }>(
        `SELECT COALESCE(SUM(base_debit_cents), 0)::text AS debit,
                COALESCE(SUM(base_credit_cents), 0)::text AS credit
           FROM ledger_lines WHERE org_id = $1`,
        [actors.orgA.orgId],
      );
      const row = rows[0];
      expect(row).toBeDefined();
      expect(row?.debit).toBe(row?.credit);

      const report = await runIntegrityChecks();
      expect(report.passed).toBe(true);
    });

    it('a second POST /sandbox/load returns 409', async () => {
      const agent = await loginAgent(app, actors.orgA);
      const second = await agent.post(`${BASE}/load`);
      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/already loaded/i);
    });

    // ---------------------------------------------------- data-realism guards
    // A regression in the fixtures could silently empty the demo without
    // failing any of the count assertions above, which only check shape.

    it('the seeded dataset produces real analytics: cohort decay, FX exclusion, and both close-run outcomes', async () => {
      const anchorMonth = loadBody.dataset.anchorMonth;

      // Cohorts: a window starting near the earliest customer's acquisition
      // month must show at least one cohort whose retention drops below
      // 100% — proving real churn, not a flat, meaningless matrix.
      const [anchorYear, anchorMonthNum] = anchorMonth.split('-').map(Number);
      const earlyFrom = `${String((anchorYear ?? 2026) - 2).padStart(4, '0')}-${String(anchorMonthNum ?? 1).padStart(2, '0')}-01`;
      const cohorts = await cohortService.cohortMatrix(actors.orgA.orgId, earlyFrom, anchorMonth);
      expect(cohorts.matrix.rows.length).toBeGreaterThanOrEqual(3);
      const anyChurned = cohorts.matrix.rows.some((row) =>
        row.cells.some((cell) => cell.retentionBps < 10000),
      );
      expect(anyChurned).toBe(true);

      // PVM: the two FX customers must be reported as excluded, never
      // silently folded into the base-currency decomposition.
      const pvm = await pvmService.pvmReport(
        actors.orgA.orgId,
        { from: anchorMonth, to: anchorMonth },
        { from: earlyFrom, to: earlyFrom },
      );
      expect(pvm.excludedForeignCurrencyInvoices).toBeGreaterThan(0);

      // BoardDeck: both the READY and BLOCKED outcomes must exist among the
      // seeded close runs, or the demo only ever shows one state.
      const { rows: runRows } = await pool.query<{ status: string }>(
        'SELECT status FROM boarddeck_close_runs WHERE org_id = $1',
        [actors.orgA.orgId],
      );
      const statuses = runRows.map((r) => r.status);
      expect(statuses).toContain('READY');
      expect(statuses).toContain('BLOCKED');

      // Bank reconciliation: both a real auto-match and a real leftover for
      // the approval queue must exist.
      const { rows: bankStatusRows } = await pool.query<{ status: string; count: string }>(
        'SELECT status, count(*)::text AS count FROM bank_transactions WHERE org_id = $1 GROUP BY status',
        [actors.orgA.orgId],
      );
      const bankStatuses = new Set(bankStatusRows.map((r) => r.status));
      expect(bankStatuses.has('MATCHED')).toBe(true);
      expect(bankStatuses.has('UNMATCHED')).toBe(true);
    });

    // ------------------------------------------------- cross-tenant isolation

    it('a forged orgId in query, header, and body is ignored on GET /sandbox', async () => {
      const agentA = await loginAgent(app, actors.orgA);

      const honest = await agentA.get(BASE);
      const forged = await agentA
        .get(BASE)
        .query({ orgId: actors.orgB.orgId })
        .set('X-Org-Id', actors.orgB.orgId)
        .send({ orgId: actors.orgB.orgId });

      expect(forged.status).toBe(200);
      // Byte-identical: none of those three inputs is even consulted — orgId
      // comes only from the verified access token (guardrails rule 1).
      expect(forged.body).toEqual(honest.body);
    });

    it("org B sees loaded: false after org A loads, and none of org A's seeded rows", async () => {
      const agentB = await loginAgent(app, actors.orgB);
      const statusB = await agentB.get(BASE);
      expect(statusB.body.sandbox).toEqual({ loaded: false, dataset: null });

      for (const table of ['customers', 'invoices', 'bank_transactions']) {
        const { rows } = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table} WHERE org_id = $1`,
          [actors.orgB.orgId],
        );
        expect(rows[0]?.count).toBe('0');
      }
    });

    /**
     * MUST STAY LAST IN THIS BLOCK.
     *
     * It is the only case here that writes: it loads org B's own dataset. The
     * case above asserts org B has *nothing* loaded, so it has to run first.
     * Keeping this one last is what lets the whole block share a single seed
     * instead of paying for a second one — but it does mean the order is
     * load-bearing, so do not move it or add cases after it.
     */
    it("org B loading its own sandbox does not affect org A's already-loaded dataset", async () => {
      const countsA = loadBody.dataset.counts;

      const agentB = await loginAgent(app, actors.orgB);
      const loadB = await agentB.post(`${BASE}/load`);
      expect(loadB.status).toBe(201);

      const agentA = await loginAgent(app, actors.orgA);
      const statusA = await agentA.get(BASE);
      expect(statusA.body.sandbox.dataset.counts).toEqual(countsA);
    }, 180_000);
  });

  // ------------------------------------------ destroys the marker it tests on
  describe('unload and reload', () => {
    let actors: Actors;

    beforeEach(async () => {
      await resetTables();
      actors = await seedActors();
      const agent = await loginAgent(app, actors.orgA);
      expect((await agent.post(`${BASE}/load`)).status).toBe(201);
    }, 180_000);

    it('DELETE removes the marker, and a reload afterwards is refused with a clear reason', async () => {
      const agent = await loginAgent(app, actors.orgA);

      // Unload clears the marker only — the seeded records stay, because
      // posted documents are immutable. So a reload would otherwise try to
      // seed on top of them.
      expect((await agent.delete(BASE)).status).toBe(200);
      expect((await agent.get(BASE)).body.sandbox).toEqual({ loaded: false, dataset: null });

      const reload = await agent.post(`${BASE}/load`);
      expect(reload.status).toBe(409);
      // The real reason, not a leaked `Account code already exists` from
      // whichever service happened to notice first.
      expect(reload.body.error).toMatch(/already contains sample data/i);

      // And critically: the failed attempt must not leave a marker behind
      // saying "loaded" with all-zero counts — a marker that lies.
      const status = await agent.get(BASE);
      expect(status.body.sandbox).toEqual({ loaded: false, dataset: null });
    });
  });
});
