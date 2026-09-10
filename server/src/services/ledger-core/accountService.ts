import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import {
  isAccountType,
  type Account,
  type AccountNode,
  type AccountType,
} from '../../types/ledger-core.js';

/**
 * The chart of accounts — LedgerCore's Phase 3 foundation.
 *
 * Every function takes `orgId` first and every statement carries an `org_id`
 * predicate (guardrails rule 1). That `orgId` always originates from the
 * verified access token, never from a param, header or body.
 */

/** Both `pool` and a checked-out `PoolClient` satisfy this. */
type Queryable = Pick<PoolClient, 'query'>;

const PG_UNIQUE_VIOLATION = '23505';

/** Matches a driver error's SQLSTATE structurally, without an `any` cast. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && err.code === PG_UNIQUE_VIOLATION
  );
}

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  parent_id: string | null;
  is_postable: boolean;
  is_active: boolean;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

const ACCOUNT_COLUMNS = `id, code, name, type, parent_id, is_postable, is_active,
                         description, created_at, updated_at`;

function toAccount(row: AccountRow): Account {
  // Re-validate rather than cast: the column has a CHECK constraint, but a
  // widened enum in a later migration would otherwise reach the API as a lie.
  if (!isAccountType(row.type)) {
    throw new Error(`Unknown account type "${row.type}" on account ${row.id}`);
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    parentId: row.parent_id,
    isPostable: row.is_postable,
    isActive: row.is_active,
    description: row.description,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------- reads

export async function listAccounts(
  orgId: string,
  options: { includeInactive?: boolean } = {},
): Promise<Account[]> {
  const { rows } = await pool.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS}
       FROM accounts
      WHERE org_id = $1
        AND ($2 OR is_active)
      ORDER BY code ASC`,
    [orgId, options.includeInactive ?? false],
  );
  return rows.map(toAccount);
}

/**
 * The chart as a tree.
 *
 * Assembled in TypeScript from the flat list rather than with a second
 * recursive query: the whole chart is tens of rows, the flat read is already
 * indexed and ordered by code, and one pass over it is cheaper than a round
 * trip. The recursive CTE earns its place where it is genuinely needed — the
 * ancestor walk in `updateAccount`, which must run inside the write path.
 */
export async function listAccountTree(orgId: string): Promise<AccountNode[]> {
  const accounts = await listAccounts(orgId, { includeInactive: true });

  const nodes = new Map<string, AccountNode>(
    accounts.map((account) => [account.id, { ...account, children: [] }]),
  );

  const roots: AccountNode[] = [];
  for (const account of accounts) {
    const node = nodes.get(account.id);
    if (node === undefined) continue;

    const parent = account.parentId === null ? undefined : nodes.get(account.parentId);
    if (parent === undefined) {
      // Either a genuine root, or a child whose parent is outside this org —
      // which the same-org check on write makes impossible. Surfacing it as a
      // root beats dropping the row silently.
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  return roots;
}

export async function getAccountById(orgId: string, id: string): Promise<Account> {
  const { rows } = await pool.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );

  const row = rows[0];
  // 404 and not 403: a 403 would confirm the id exists in some other
  // organization, which is itself a leak (docs/api.md).
  if (row === undefined) throw new ApiError(404, 'Account not found');
  return toAccount(row);
}

// --------------------------------------------------------------------- writes

/**
 * Confirms a proposed parent is usable: same organization, same type.
 *
 * The same-org check is the tenancy boundary — without it a caller could hang
 * their account off another tenant's tree and learn that the id exists.
 */
async function assertParentIsValid(
  q: Queryable,
  orgId: string,
  parentId: string,
  type: AccountType,
): Promise<void> {
  const { rows } = await q.query<{ type: string }>(
    'SELECT type FROM accounts WHERE id = $1 AND org_id = $2',
    [parentId, orgId],
  );

  const parent = rows[0];
  if (parent === undefined) throw new ApiError(422, 'Parent account not found');
  if (parent.type !== type) {
    throw new ApiError(422, 'Parent account must have the same type');
  }
}

/**
 * Creates one account on a caller-supplied, already-open transaction client.
 * Runs no BEGIN, no COMMIT and no ROLLBACK — mirrors journalService's
 * `createEntryOnClient`, so a chart import (Phase 9b) creates every account
 * and its journal entry inside one transaction (guardrails rule 5).
 */
export async function createAccountOnClient(
  client: PoolClient,
  orgId: string,
  createdBy: string,
  input: {
    code: string;
    name: string;
    type: AccountType;
    parentId: string | null;
    isPostable: boolean;
    description: string | null;
  },
): Promise<Account> {
  if (input.parentId !== null) {
    await assertParentIsValid(client, orgId, input.parentId, input.type);
  }

  try {
    const { rows } = await client.query<AccountRow>(
      `INSERT INTO accounts (org_id, code, name, type, parent_id, is_postable, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${ACCOUNT_COLUMNS}`,
      [
        orgId,
        input.code,
        input.name,
        input.type,
        input.parentId,
        input.isPostable,
        input.description,
        createdBy,
      ],
    );

    const row = rows[0];
    if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
    return toAccount(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, 'Account code already exists');
    throw err;
  }
}

export async function createAccount(
  orgId: string,
  createdBy: string,
  input: {
    code: string;
    name: string;
    type: AccountType;
    parentId: string | null;
    isPostable: boolean;
    description: string | null;
  },
): Promise<Account> {
  return withTransaction((client) => createAccountOnClient(client, orgId, createdBy, input));
}

/**
 * Walks up from `parentId` and reports whether `id` is among its ancestors.
 *
 * This is the cycle check, and it has to be a recursive query rather than a
 * constraint: a CHECK sees one row, and a cycle is a property of a path. Both
 * halves of the CTE carry `org_id = $2` — dropping it from the recursive term
 * would let the walk traverse into another tenant's tree.
 */
async function wouldCreateCycle(
  orgId: string,
  id: string,
  parentId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id FROM accounts WHERE id = $1 AND org_id = $2
       UNION ALL
       SELECT a.id, a.parent_id
         FROM accounts a
         JOIN ancestors an ON a.id = an.parent_id AND a.org_id = $2
     )
     SELECT 1 FROM ancestors WHERE id = $3 LIMIT 1`,
    [parentId, orgId, id],
  );
  return rows.length > 0;
}

/**
 * `code` and `type` are deliberately not updatable.
 *
 * Reports depend on the code ranges (docs/schema.md), and re-typing an account
 * that already has postings would silently restate every prior period. Retire
 * the account with `isActive: false` and create a replacement instead.
 */
export async function updateAccount(
  orgId: string,
  id: string,
  // `| undefined` on each is required by `exactOptionalPropertyTypes`: zod
  // infers an optional key as `string | undefined`, and under that flag
  // `name?: string` means "absent or a string, never explicitly undefined" —
  // a genuinely different type. Widening here is the honest fix; the loop
  // below skips `undefined` values, so an explicit undefined behaves as absent.
  input: {
    name?: string | undefined;
    description?: string | null | undefined;
    isActive?: boolean | undefined;
    parentId?: string | null | undefined;
  },
): Promise<Account> {
  const existing = await getAccountById(orgId, id);

  if (input.parentId !== undefined && input.parentId !== null) {
    if (input.parentId === id) throw new ApiError(422, 'Re-parenting would create a cycle');
    await assertParentIsValid(pool, orgId, input.parentId, existing.type);
    if (await wouldCreateCycle(orgId, id, input.parentId)) {
      throw new ApiError(422, 'Re-parenting would create a cycle');
    }
  }

  // Column names come from this frozen map, never from the request — rule 4
  // forbids interpolating an identifier a caller could influence.
  const COLUMNS = {
    name: 'name',
    description: 'description',
    isActive: 'is_active',
    parentId: 'parent_id',
  } as const;

  const assignments: string[] = [];
  const values: unknown[] = [id, orgId];

  for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
    const value = input[key];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${COLUMNS[key]} = $${String(values.length)}`);
  }

  if (assignments.length === 0) throw new ApiError(400, 'No fields to update');

  const { rows } = await withTransaction((client) =>
    client.query<AccountRow>(
      `UPDATE accounts SET ${assignments.join(', ')}
        WHERE id = $1 AND org_id = $2
        RETURNING ${ACCOUNT_COLUMNS}`,
      values,
    ),
  );

  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Account not found');
  return toAccount(row);
}

// ----------------------------------------------------------------- the seed

interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
  /** Parent's `code`, resolved to an id at insert time. `null` for a root. */
  parent: string | null;
  postable: boolean;
}

/**
 * The default chart every organization starts with — docs/schema.md.
 *
 * Codes are load-bearing, not cosmetic: the P&L derives gross profit from the
 * 5xxx range, and the ranges in docs/schema.md are what reports rely on.
 *
 * Four groups are here to pay debt forward rather than because Phase 3 needs
 * them. Adding an account to this list later means writing another backfill for
 * every organization created in between, so the accounts later phases are known
 * to need are seeded now:
 *   - 1180 / 2140  tax      — AP-Flow splits input tax out of an invoice (11)
 *   - 4910 / 6810 / 6820 FX — realized and unrealized gain/loss (8)
 *   - 3400 opening balance equity — the import plug (9b)
 */
export const DEFAULT_CHART: readonly SeedAccount[] = [
  // Assets 1000–1999
  { code: '1000', name: 'Assets', type: 'Asset', parent: null, postable: false },
  { code: '1100', name: 'Current Assets', type: 'Asset', parent: '1000', postable: false },
  { code: '1110', name: 'Operating Cash', type: 'Asset', parent: '1100', postable: true },
  { code: '1120', name: 'Accounts Receivable', type: 'Asset', parent: '1100', postable: true },
  { code: '1130', name: 'Prepaid Expenses', type: 'Asset', parent: '1100', postable: true },
  { code: '1140', name: 'Inventory', type: 'Asset', parent: '1100', postable: true },
  { code: '1180', name: 'GST/VAT Input Credit', type: 'Asset', parent: '1100', postable: true },
  { code: '1400', name: 'Non-Current Assets', type: 'Asset', parent: '1000', postable: false },
  { code: '1500', name: 'Fixed Assets / Equipment', type: 'Asset', parent: '1400', postable: true },
  { code: '1590', name: 'Accumulated Depreciation', type: 'Asset', parent: '1400', postable: true },

  // Liabilities 2000–2999
  { code: '2000', name: 'Liabilities', type: 'Liability', parent: null, postable: false },
  { code: '2010', name: 'Current Liabilities', type: 'Liability', parent: '2000', postable: false },
  { code: '2100', name: 'Accounts Payable', type: 'Liability', parent: '2010', postable: true },
  { code: '2120', name: 'Accrued Liabilities', type: 'Liability', parent: '2010', postable: true },
  { code: '2140', name: 'GST/VAT Output Payable', type: 'Liability', parent: '2010', postable: true },
  { code: '2160', name: 'Payroll Liabilities', type: 'Liability', parent: '2010', postable: true },
  { code: '2500', name: 'Non-Current Liabilities', type: 'Liability', parent: '2000', postable: false },
  { code: '2510', name: 'Notes Payable', type: 'Liability', parent: '2500', postable: true },

  // Equity 3000–3999
  { code: '3000', name: 'Equity', type: 'Equity', parent: null, postable: false },
  { code: '3100', name: "Common Stock / Owner's Capital", type: 'Equity', parent: '3000', postable: true },
  { code: '3200', name: 'Retained Earnings', type: 'Equity', parent: '3000', postable: true },
  { code: '3300', name: "Owner's Draw", type: 'Equity', parent: '3000', postable: true },
  { code: '3400', name: 'Opening Balance Equity', type: 'Equity', parent: '3000', postable: true },

  // Revenue 4000–4999
  { code: '4000', name: 'Revenue', type: 'Revenue', parent: null, postable: false },
  { code: '4100', name: 'Product Revenue', type: 'Revenue', parent: '4000', postable: true },
  { code: '4200', name: 'Service Revenue', type: 'Revenue', parent: '4000', postable: true },
  { code: '4800', name: 'Sales Returns & Allowances', type: 'Revenue', parent: '4000', postable: true },
  { code: '4910', name: 'Realized FX Gain', type: 'Revenue', parent: '4000', postable: true },

  // Cost of sales 5000–5999 — Expense, separated by range and parent, not type
  { code: '5000', name: 'Cost of Goods Sold', type: 'Expense', parent: null, postable: false },
  { code: '5100', name: 'Direct Materials', type: 'Expense', parent: '5000', postable: true },
  { code: '5200', name: 'Direct Labor', type: 'Expense', parent: '5000', postable: true },
  { code: '5300', name: 'Freight & Duty', type: 'Expense', parent: '5000', postable: true },

  // Operating expenses 6000–6999
  { code: '6000', name: 'Operating Expenses', type: 'Expense', parent: null, postable: false },
  { code: '6100', name: 'Salaries & Wages', type: 'Expense', parent: '6000', postable: true },
  { code: '6110', name: 'Rent & Utilities', type: 'Expense', parent: '6000', postable: true },
  { code: '6120', name: 'Software & IT Infrastructure', type: 'Expense', parent: '6000', postable: true },
  { code: '6130', name: 'Office Supplies', type: 'Expense', parent: '6000', postable: true },
  { code: '6140', name: 'Kitchen & Breakroom', type: 'Expense', parent: '6000', postable: true },
  { code: '6200', name: 'Professional Fees', type: 'Expense', parent: '6000', postable: true },
  { code: '6300', name: 'Travel & Entertainment', type: 'Expense', parent: '6000', postable: true },
  { code: '6400', name: 'Marketing & Advertising', type: 'Expense', parent: '6000', postable: true },
  { code: '6500', name: 'Depreciation Expense', type: 'Expense', parent: '6000', postable: true },
  { code: '6600', name: 'Bank Fees', type: 'Expense', parent: '6000', postable: true },
  { code: '6810', name: 'Realized FX Loss', type: 'Expense', parent: '6000', postable: true },
  { code: '6820', name: 'Unrealized FX Gain/Loss', type: 'Expense', parent: '6000', postable: true },
];

/** Groups the chart by tree depth, so parents always exist before their children. */
function chartByDepth(): SeedAccount[][] {
  const byCode = new Map(DEFAULT_CHART.map((a) => [a.code, a]));
  const levels: SeedAccount[][] = [];

  for (const account of DEFAULT_CHART) {
    let depth = 0;
    let cursor = account.parent;
    while (cursor !== null) {
      depth += 1;
      cursor = byCode.get(cursor)?.parent ?? null;
    }
    (levels[depth] ??= []).push(account);
  }

  return levels;
}

/**
 * Seeds the default chart for one organization.
 *
 * Takes a `Queryable` **first**, not `orgId`, because it runs inside the
 * transaction `authService.register` already owns — passing `pool` there would
 * escape the transaction and leave a chart behind after a rollback (rule 5).
 *
 * One statement per tree depth rather than one per account: a parent's id is
 * resolved by a correlated subquery against rows the previous level committed,
 * and a statement cannot see rows it is inserting itself. Three round trips for
 * 44 accounts instead of 44.
 *
 * Idempotent via `ON CONFLICT DO NOTHING`, which is what lets the same routine
 * serve both registration and the backfill for pre-existing organizations.
 *
 * @returns how many accounts were actually inserted.
 */
export async function seedDefaultChart(q: Queryable, orgId: string): Promise<number> {
  let inserted = 0;

  for (const level of chartByDepth()) {
    const { rowCount } = await q.query(
      `INSERT INTO accounts (org_id, code, name, type, is_postable, parent_id)
       SELECT $1,
              v.code,
              v.name,
              v.type,
              v.is_postable,
              (SELECT p.id FROM accounts p WHERE p.org_id = $1 AND p.code = v.parent_code)
         FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::text[])
              AS v(code, name, type, is_postable, parent_code)
       ON CONFLICT (org_id, code) DO NOTHING`,
      [
        orgId,
        level.map((a) => a.code),
        level.map((a) => a.name),
        level.map((a) => a.type),
        level.map((a) => a.postable),
        level.map((a) => a.parent),
      ],
    );
    inserted += rowCount ?? 0;
  }

  return inserted;
}
