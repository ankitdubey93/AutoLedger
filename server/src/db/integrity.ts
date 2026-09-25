import { pool } from './connect.js';
import { parseCents } from '../utils/money.js';

/**
 * Phase 5's standalone integrity checker — the script an auditor is shown.
 * See docs/roadmap.md's "Audit trail & CDC (Phase 5)" entry and
 * docs/accounting.md's "Audit trail & internal controls" section.
 *
 * Every query below is **deliberately not scoped by `org_id`** — the single
 * sanctioned exception to guardrails rule 1 in this codebase. The point of
 * this checker is to prove an invariant across the *whole* database, which a
 * per-tenant query cannot do. It lives here, in `src/db/`, rather than in
 * `src/services/`, precisely so no request-serving service can import an
 * unscoped query by accident — nothing under `src/services/` or
 * `src/controllers/` may import from this file. Every offender this file
 * reports still carries its own `org_id`, so a failure remains traceable to
 * one tenant even though the query that found it was not scoped to one.
 *
 * This module only computes the report; `scripts/verifyIntegrity.ts` is
 * where the process actually exits, so importing this file (e.g. from a
 * test) never terminates the test runner.
 */

export interface IntegrityCheck {
  name:
    | 'debits_equal_credits'
    | 'every_entry_balances'
    | 'no_orphaned_ledger_lines'
    | 'bank_line_journal_entries_exist'
    | 'stock_balances_match_movements'
    | 'stock_movements_reconcile_with_gl'
    | 'inventory_accounts_reconcile_with_gl';
  description: string;
  passed: boolean;
  /** Up to 20 offending rows, for the operator to go look at. Empty when passed. */
  offenders: { orgId: string | null; subject: string; detail: string }[];
}

export interface IntegrityReport {
  checkedAt: string;
  passed: boolean;
  checks: IntegrityCheck[];
}

/**
 * Total debits must equal total credits across every `ledger_lines` row in
 * the database. Integer `BigInt` comparison, never a float or an epsilon
 * (guardrails rule 3) — the two totals are either exactly equal or they are
 * not.
 *
 * Base currency, not native (Phase 8): the reporting currency is each
 * organization's base currency, and a line's native amount may be in any
 * currency — summing native amounts across currencies is meaningless. Base
 * currency is what balances; see migration 023 and
 * study/postgresql/multi-currency-and-functional-currency.md.
 */
async function checkDebitsEqualCredits(): Promise<IntegrityCheck> {
  const { rows } = await pool.query<{ total_debits: string; total_credits: string }>(
    `SELECT COALESCE(SUM(base_debit_cents), 0)::text AS total_debits,
            COALESCE(SUM(base_credit_cents), 0)::text AS total_credits
       FROM ledger_lines`,
  );
  const row = rows[0];
  const totalDebits = row === undefined ? 0n : BigInt(parseCents(row.total_debits));
  const totalCredits = row === undefined ? 0n : BigInt(parseCents(row.total_credits));
  const passed = totalDebits === totalCredits;

  return {
    name: 'debits_equal_credits',
    description: 'Total base-currency debits must equal total base-currency credits across the entire ledger.',
    passed,
    offenders: passed
      ? []
      : [
          {
            orgId: null,
            subject: 'ledger_lines',
            detail: `total debits ${totalDebits.toString()} != total credits ${totalCredits.toString()} (difference ${(totalDebits - totalCredits).toString()})`,
          },
        ],
  };
}

/**
 * Every individual journal entry must balance on its own — the same
 * invariant migration 004/023's deferred constraint trigger enforces at
 * `COMMIT` time, re-verified here from scratch against whatever is actually
 * in the table.
 *
 * Base currency, not native (Phase 8) — see checkDebitsEqualCredits above.
 * An entry mixing currencies (a realized-FX settlement) legitimately fails
 * a native-sum check while still balancing in base currency, which is the
 * only sum this check is entitled to assert on.
 */
async function checkEveryEntryBalances(): Promise<IntegrityCheck> {
  const { rows } = await pool.query<{
    org_id: string;
    journal_entry_id: string;
    total_debits: string;
    total_credits: string;
  }>(
    `SELECT e.org_id, l.journal_entry_id,
            SUM(l.base_debit_cents)::text AS total_debits,
            SUM(l.base_credit_cents)::text AS total_credits
       FROM ledger_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id
      GROUP BY e.org_id, l.journal_entry_id
     HAVING SUM(l.base_debit_cents) <> SUM(l.base_credit_cents)
      LIMIT 20`,
  );

  return {
    name: 'every_entry_balances',
    description: 'Every journal entry must have equal base-currency debits and credits across its own lines.',
    passed: rows.length === 0,
    offenders: rows.map((r) => ({
      orgId: r.org_id,
      subject: `journal_entries/${r.journal_entry_id}`,
      detail: `debits ${r.total_debits} != credits ${r.total_credits}`,
    })),
  };
}

/**
 * No ledger line may be orphaned: either its parent entry does not exist, or
 * (a worse form of the same problem) its parent exists in a *different*
 * organization than the line itself claims. One query covers both, since a
 * tenant mismatch is a tenant leak and deserves at least as much attention
 * as a missing parent.
 */
async function checkNoOrphanedLedgerLines(): Promise<IntegrityCheck> {
  const { rows } = await pool.query<{
    id: string;
    org_id: string;
    journal_entry_id: string;
    missing_parent: boolean;
    tenant_mismatch: boolean;
  }>(
    `SELECT l.id, l.org_id, l.journal_entry_id,
            (e.id IS NULL) AS missing_parent,
            (e.id IS NOT NULL AND e.org_id <> l.org_id) AS tenant_mismatch
       FROM ledger_lines l
       LEFT JOIN journal_entries e ON e.id = l.journal_entry_id
      WHERE e.id IS NULL OR e.org_id <> l.org_id
      LIMIT 20`,
  );

  return {
    name: 'no_orphaned_ledger_lines',
    description: 'Every ledger line must belong to a journal entry in the same organization.',
    passed: rows.length === 0,
    offenders: rows.map((r) => ({
      orgId: r.org_id,
      subject: `ledger_lines/${r.id}`,
      detail: r.missing_parent
        ? `journal_entry_id ${r.journal_entry_id} does not exist`
        : `journal_entry_id ${r.journal_entry_id} belongs to a different organization`,
    })),
  };
}

/**
 * Phase 6.1 — a bank line settled by posting a journal entry directly
 * (`matched_journal_entry_id`, migration 057) must name a real entry in its
 * own organization. `fk_bank_txn_journal_entry` (057) already guarantees
 * this at write time, ON DELETE RESTRICT — this check re-verifies it from
 * scratch against whatever is actually in the table, the same posture
 * checkNoOrphanedLedgerLines takes for ledger_lines.
 */
async function checkBankLineJournalEntriesExist(): Promise<IntegrityCheck> {
  const { rows } = await pool.query<{ id: string; org_id: string; matched_journal_entry_id: string }>(
    `SELECT bt.id, bt.org_id, bt.matched_journal_entry_id
       FROM bank_transactions bt
       LEFT JOIN journal_entries e
         ON e.id = bt.matched_journal_entry_id AND e.org_id = bt.org_id
      WHERE bt.matched_journal_entry_id IS NOT NULL AND e.id IS NULL
      LIMIT 20`,
  );

  return {
    name: 'bank_line_journal_entries_exist',
    description: 'Every bank line settled by a posted journal entry must name a real entry in its own organization.',
    passed: rows.length === 0,
    offenders: rows.map((r) => ({
      orgId: r.org_id,
      subject: `bank_transactions/${r.id}`,
      detail: `matched_journal_entry_id ${r.matched_journal_entry_id} does not exist in this organization`,
    })),
  };
}

/**
 * Phase 28 — Inventory's `stock_balances` is a derived cache
 * (movementService.ts writes it in the same transaction as each movement);
 * this re-derives it from scratch by summing `stock_movements` and compares.
 *
 * `FULL JOIN` needs a hashable/mergeable join condition, and Postgres
 * refuses `IS NOT DISTINCT FROM` there — so a NULL `lot_id` (a QUANTITY or
 * SERIAL item's balance) is folded to a sentinel nil UUID with `COALESCE`
 * on both sides instead, which `=` can join on normally.
 */
async function checkStockBalancesMatchMovements(): Promise<IntegrityCheck> {
  const { rows } = await pool.query<{
    org_id: string;
    item_id: string;
    balance_qty: string;
    movement_qty: string;
    balance_val: string;
    movement_val: string;
  }>(
    `WITH m AS (
       SELECT org_id, item_id, location_id,
              COALESCE(lot_id, '00000000-0000-0000-0000-000000000000'::uuid) AS lot_key,
              SUM(quantity_milli) AS qty, SUM(value_cents) AS val
         FROM stock_movements GROUP BY 1, 2, 3, 4
     ), b AS (
       SELECT org_id, item_id, location_id,
              COALESCE(lot_id, '00000000-0000-0000-0000-000000000000'::uuid) AS lot_key,
              quantity_milli AS qty, value_cents AS val
         FROM stock_balances
     )
     SELECT COALESCE(b.org_id, m.org_id) AS org_id, COALESCE(b.item_id, m.item_id)::text AS item_id,
            COALESCE(b.qty, 0)::text AS balance_qty, COALESCE(m.qty, 0)::text AS movement_qty,
            COALESCE(b.val, 0)::text AS balance_val, COALESCE(m.val, 0)::text AS movement_val
       FROM b FULL JOIN m
         ON m.org_id = b.org_id AND m.item_id = b.item_id AND m.location_id = b.location_id AND m.lot_key = b.lot_key
      WHERE COALESCE(b.qty, 0) <> COALESCE(m.qty, 0) OR COALESCE(b.val, 0) <> COALESCE(m.val, 0)
      LIMIT 20`,
  );

  return {
    name: 'stock_balances_match_movements',
    description: 'Every stock balance equals the sum of its movements (quantity and value)',
    passed: rows.length === 0,
    offenders: rows.map((r) => ({
      orgId: r.org_id,
      subject: `item ${r.item_id}`,
      detail: `balance ${r.balance_qty}/${r.balance_val} ≠ movements ${r.movement_qty}/${r.movement_val}`,
    })),
  };
}

/**
 * Phase 32 — the stock ledger and the general ledger agree, document by
 * document. For every (source, inventory account) a set of GL-linked stock
 * movements posted to, the sum of the movements' value must equal the net
 * debit on that account across the journal entries of the same source —
 * INCLUDING the reversing entries of those entries. A reversal copies the
 * original's `source_type` but not its `source_id`, so it is joined back
 * through `reverses_entry_id`.
 *
 * Scope, stated openly: this reconciles each DOCUMENT with its movements, not
 * the whole inventory account with total stock value. A manual journal
 * straight to the inventory account, or stock that pre-dates its product link,
 * can still make the account differ from Inventory's valuation — see check 7,
 * `inventory_accounts_reconcile_with_gl`, below for the whole-account version.
 */
async function checkStockMovementsReconcileWithGl(): Promise<IntegrityCheck> {
  const { rows } = await pool.query<{
    org_id: string;
    source_type: string;
    source_id: string;
    gl_account_id: string;
    movement_val: string;
    gl_val: string;
  }>(
    `WITH m AS (
       SELECT org_id, source_type, source_id, gl_account_id, SUM(value_cents) AS movement_val
         FROM stock_movements
        WHERE gl_account_id IS NOT NULL AND source_id IS NOT NULL
        GROUP BY org_id, source_type, source_id, gl_account_id
     ), e AS (
       SELECT id, org_id, source_type, source_id FROM journal_entries WHERE source_id IS NOT NULL
       UNION ALL
       SELECT r.id, r.org_id, o.source_type, o.source_id
         FROM journal_entries r
         JOIN journal_entries o ON o.id = r.reverses_entry_id AND o.org_id = r.org_id
        WHERE o.source_id IS NOT NULL
     ), g AS (
       SELECT e.org_id, e.source_type, e.source_id, l.account_id,
              SUM(l.base_debit_cents - l.base_credit_cents) AS gl_val
         FROM e JOIN ledger_lines l ON l.journal_entry_id = e.id AND l.org_id = e.org_id
        GROUP BY e.org_id, e.source_type, e.source_id, l.account_id
     )
     SELECT m.org_id, m.source_type, m.source_id, m.gl_account_id,
            m.movement_val::text, COALESCE(g.gl_val, 0)::text AS gl_val
       FROM m
       LEFT JOIN g ON g.org_id = m.org_id AND g.source_type = m.source_type
                  AND g.source_id = m.source_id AND g.account_id = m.gl_account_id
      WHERE m.movement_val <> COALESCE(g.gl_val, 0)
      LIMIT 20`,
  );

  return {
    name: 'stock_movements_reconcile_with_gl',
    description: 'Every GL-linked stock movement set equals its journal entries on the inventory account, reversals included',
    passed: rows.length === 0,
    offenders: rows.map((r) => ({
      orgId: r.org_id,
      subject: `${r.source_type} ${r.source_id}`,
      detail: `stock movements ${r.movement_val} ≠ GL ${r.gl_val} on account ${r.gl_account_id}`,
    })),
  };
}

/**
 * Phase 35a — the whole-account version of check 6: an inventory control
 * account's GL balance (Core model §2 of plans/phase-35a) must equal the
 * stock subledger posted to it — `SUM(stock_movements.value_cents)` where
 * `gl_account_id` is that account, across every source, not just one
 * document at a time. `ctrl` is every account that is either linked to by a
 * GL-tagged movement, is an INVENTORY product's own override account, or is
 * the org's resolved default inventory account for its defaulted products.
 *
 * An org created before 35a with a manual journal straight to its inventory
 * account, or a product mapping changed before the reclass machinery
 * existed, will fail this check until an OWNER runs the true-up (or "Move to
 * current accounts") — that is the intended remediation path, not a bug in
 * this check.
 */
async function checkInventoryAccountsReconcileWithGl(): Promise<IntegrityCheck> {
  const { rows } = await pool.query<{
    org_id: string;
    account_id: string;
    subledger: string;
    gl: string;
  }>(
    `WITH ctrl AS (
       SELECT DISTINCT org_id, gl_account_id AS account_id FROM stock_movements WHERE gl_account_id IS NOT NULL
       UNION
       SELECT org_id, asset_account_id FROM items WHERE item_type = 'INVENTORY' AND asset_account_id IS NOT NULL
       UNION
       SELECT d.org_id, COALESCE(s.inventory_account_id, a.id)
         FROM (SELECT DISTINCT org_id FROM items WHERE item_type = 'INVENTORY' AND asset_account_id IS NULL) d
         LEFT JOIN ledger_settings s ON s.org_id = d.org_id
         LEFT JOIN accounts a ON a.org_id = d.org_id AND a.code = '1140' AND a.type = 'Asset' AND a.is_postable
        WHERE COALESCE(s.inventory_account_id, a.id) IS NOT NULL
     ), m AS (
       SELECT org_id, gl_account_id AS account_id, SUM(value_cents) AS v FROM stock_movements
        WHERE gl_account_id IS NOT NULL GROUP BY 1, 2
     ), g AS (
       SELECT l.org_id, l.account_id, SUM(l.base_debit_cents - l.base_credit_cents) AS v
         FROM ledger_lines l JOIN ctrl c ON c.org_id = l.org_id AND c.account_id = l.account_id GROUP BY 1, 2
     )
     SELECT c.org_id, c.account_id::text, COALESCE(m.v, 0)::text AS subledger, COALESCE(g.v, 0)::text AS gl
       FROM ctrl c
       LEFT JOIN m ON m.org_id = c.org_id AND m.account_id = c.account_id
       LEFT JOIN g ON g.org_id = c.org_id AND g.account_id = c.account_id
      WHERE COALESCE(m.v, 0) <> COALESCE(g.v, 0)
      LIMIT 20`,
  );

  return {
    name: 'inventory_accounts_reconcile_with_gl',
    description: "Every inventory control account's GL balance equals the stock subledger posted to it",
    passed: rows.length === 0,
    offenders: rows.map((r) => ({
      orgId: r.org_id,
      subject: `account ${r.account_id}`,
      detail: `stock subledger ${r.subledger} ≠ GL ${r.gl}`,
    })),
  };
}

export async function runIntegrityChecks(): Promise<IntegrityReport> {
  const checks = await Promise.all([
    checkDebitsEqualCredits(),
    checkEveryEntryBalances(),
    checkNoOrphanedLedgerLines(),
    checkBankLineJournalEntriesExist(),
    checkStockBalancesMatchMovements(),
    checkStockMovementsReconcileWithGl(),
    checkInventoryAccountsReconcileWithGl(),
  ]);

  return {
    checkedAt: new Date().toISOString(),
    passed: checks.every((c) => c.passed),
    checks,
  };
}
