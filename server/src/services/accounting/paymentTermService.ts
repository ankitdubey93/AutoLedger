import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { STANDARD_PAYMENT_TERMS, type PaymentTerm, type PaymentTermRule } from '../../types/accounting.js';
import { computeDueDate } from '../../utils/dueDate.js';

/**
 * Accounting payment terms — a selectable, org-owned catalogue an invoice or
 * bill's due date is derived from (Phase 24), instead of a due date typed by
 * hand and a free-text terms label.
 *
 * Every organization starts with the seven standard terms (`STANDARD_PAYMENT_TERMS`),
 * seeded at registration by `seedStandardPaymentTerms` and backfilled for
 * pre-existing organizations by migration 058. A standard term's code, name
 * and net_days are frozen — it may only be deactivated — so a document that
 * snapshotted its code and label at write time never sees it change out from
 * under it. Documents snapshot the term (`payment_terms_code`, `payment_terms`)
 * rather than referencing it with a FK: a posted document is immutable
 * (guardrails rule 6), so renaming or deactivating a term must never be able
 * to reach it.
 *
 * Every function takes `orgId` first and every statement carries an `org_id`
 * predicate (guardrails rule 1). `getPaymentTermByCode`, `seedStandardPaymentTerms`
 * and `resolveDueDate` take a `Queryable` because their callers are already
 * inside a transaction — they must never touch `pool` (guardrails rule 5).
 */

type Queryable = Pick<PoolClient, 'query'>;

const PG_UNIQUE_VIOLATION = '23505';
const PG_CHECK_VIOLATION = '23514';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function pgConstraint(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('constraint' in err)) return undefined;
  return typeof err.constraint === 'string' ? err.constraint : undefined;
}

const PAYMENT_TERM_COLUMNS = `id, code, name, net_days, rule, is_system, is_active, created_at, updated_at`;

interface PaymentTermRow {
  id: string;
  code: string;
  name: string;
  net_days: number;
  rule: PaymentTermRule;
  is_system: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function toPaymentTerm(row: PaymentTermRow): PaymentTerm {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    netDays: row.net_days,
    rule: row.rule,
    isSystem: row.is_system,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface CreatePaymentTermInput {
  code: string;
  name: string;
  netDays: number;
  rule: PaymentTermRule;
}

export interface UpdatePaymentTermInput {
  name?: string | undefined;
  netDays?: number | undefined;
  rule?: PaymentTermRule | undefined;
  isActive?: boolean | undefined;
}

export async function listPaymentTerms(
  orgId: string,
  options: { includeInactive: boolean },
): Promise<PaymentTerm[]> {
  const clauses = ['org_id = $1'];
  if (!options.includeInactive) clauses.push('is_active = true');

  const { rows } = await pool.query<PaymentTermRow>(
    `SELECT ${PAYMENT_TERM_COLUMNS} FROM payment_terms WHERE ${clauses.join(' AND ')} ORDER BY net_days ASC, code ASC`,
    [orgId],
  );
  return rows.map(toPaymentTerm);
}

export async function getPaymentTermByCode(q: Queryable, orgId: string, code: string): Promise<PaymentTerm> {
  const { rows } = await q.query<PaymentTermRow>(
    `SELECT ${PAYMENT_TERM_COLUMNS} FROM payment_terms WHERE org_id = $1 AND code = $2`,
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(422, `Payment term "${code}" does not exist in this organization`);
  return toPaymentTerm(row);
}

export async function createPaymentTerm(
  orgId: string,
  createdBy: string,
  input: CreatePaymentTermInput,
): Promise<PaymentTerm> {
  const code = input.code.toUpperCase();

  try {
    const { rows } = await withTransaction((client) =>
      client.query<PaymentTermRow>(
        `INSERT INTO payment_terms (org_id, created_by, code, name, net_days, rule)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${PAYMENT_TERM_COLUMNS}`,
        [orgId, createdBy, code, input.name, input.netDays, input.rule],
      ),
    );
    const row = rows[0];
    if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
    return toPaymentTerm(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) throw new ApiError(409, 'Payment term code already exists');
    if (pgErrorCode(err) === PG_CHECK_VIOLATION) {
      if (pgConstraint(err) === 'ck_payment_terms_rule_day') {
        throw new ApiError(422, 'Day of month must be between 1 and 31');
      }
      throw new ApiError(422, 'Payment term code must be 2–30 characters of A–Z, 0–9 or underscore');
    }
    throw err;
  }
}

export async function updatePaymentTerm(
  orgId: string,
  id: string,
  input: UpdatePaymentTermInput,
): Promise<PaymentTerm> {
  // Column names come from this frozen map, never from the request — rule 4
  // forbids interpolating an identifier a caller could influence.
  const COLUMNS = {
    name: 'name',
    netDays: 'net_days',
    rule: 'rule',
    isActive: 'is_active',
  } as const;

  return withTransaction(async (client) => {
    const { rows: existingRows } = await client.query<{ is_system: boolean }>(
      'SELECT is_system FROM payment_terms WHERE id = $1 AND org_id = $2',
      [id, orgId],
    );
    const existing = existingRows[0];
    if (existing === undefined) throw new ApiError(404, 'Payment term not found');
    if (existing.is_system && (input.name !== undefined || input.netDays !== undefined || input.rule !== undefined)) {
      throw new ApiError(409, 'A standard payment term cannot be renamed or re-dated — deactivate it and add your own');
    }

    const assignments: string[] = [];
    const values: unknown[] = [id, orgId];

    for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
      const value = input[key];
      if (value === undefined) continue;
      values.push(value);
      assignments.push(`${COLUMNS[key]} = $${String(values.length)}`);
    }

    if (assignments.length === 0) throw new ApiError(400, 'No fields to update');

    let rows: PaymentTermRow[];
    try {
      ({ rows } = await client.query<PaymentTermRow>(
        `UPDATE payment_terms SET ${assignments.join(', ')}
          WHERE id = $1 AND org_id = $2
          RETURNING ${PAYMENT_TERM_COLUMNS}`,
        values,
      ));
    } catch (err) {
      if (pgErrorCode(err) === PG_CHECK_VIOLATION && pgConstraint(err) === 'ck_payment_terms_rule_day') {
        throw new ApiError(422, 'Day of month must be between 1 and 31');
      }
      throw err;
    }

    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Payment term not found');
    return toPaymentTerm(row);
  });
}

/**
 * Seeds the seven standard terms for a newly registered organization, called
 * from `authService` on the same transaction client as registration
 * (guardrails rule 5). `ON CONFLICT DO NOTHING` mirrors migration 058's
 * backfill, so re-running this is always safe.
 */
export async function seedStandardPaymentTerms(q: Queryable, orgId: string): Promise<number> {
  const result = await q.query(
    `INSERT INTO payment_terms (org_id, code, name, net_days, is_system)
     SELECT $1, v.code, v.name, v.net_days, true
       FROM unnest($2::text[], $3::text[], $4::int[]) AS v(code, name, net_days)
     ON CONFLICT (org_id, code) DO NOTHING`,
    [
      orgId,
      STANDARD_PAYMENT_TERMS.map((t) => t.code),
      STANDARD_PAYMENT_TERMS.map((t) => t.name),
      STANDARD_PAYMENT_TERMS.map((t) => t.netDays),
    ],
  );
  return result.rowCount ?? 0;
}

/**
 * ISO date + netDays, pure UTC arithmetic. No Date-library, no local
 * timezone. `new Date(isoDate)` parses as UTC midnight, but its local-time
 * setters would then drift by the runtime's offset — every mutation here
 * stays on the UTC setters.
 */
export function addDaysIso(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface ResolvedDueDate {
  dueDate: string;
  paymentTermsCode: string | null;
  paymentTermsLabel: string | null;
}

/**
 * Resolves the due date for a new or edited invoice/bill. An explicit due
 * date always wins over a term — the term is a convenience for filling the
 * date in, never a constraint on it.
 */
export async function resolveDueDate(
  q: Queryable,
  orgId: string,
  documentDate: string,
  paymentTermsCode: string | null,
  explicitDueDate: string | undefined,
): Promise<ResolvedDueDate> {
  if (explicitDueDate !== undefined) {
    return { dueDate: explicitDueDate, paymentTermsCode, paymentTermsLabel: null };
  }
  if (paymentTermsCode === null) {
    throw new ApiError(422, 'Provide a due date or a payment term');
  }

  const term = await getPaymentTermByCode(q, orgId, paymentTermsCode);
  if (!term.isActive) throw new ApiError(422, `Payment term "${paymentTermsCode}" is inactive`);

  return {
    dueDate: computeDueDate(term.rule, term.netDays, documentDate),
    paymentTermsCode: term.code,
    paymentTermsLabel: term.name,
  };
}

const SIDE = {
  SALES: { party: 'customers', column: 's.default_sales_payment_term_id' },
  PURCHASE: { party: 'vendors', column: 's.default_purchase_payment_term_id' },
} as const;

/**
 * Phase 43a — the term code a document falls back to when it carries neither a
 * due date nor a term: the party's default, else the organization's. An
 * inactive default is skipped. Identifiers come from the frozen `SIDE` map.
 */
export async function resolveDefaultTermCodeOnClient(
  q: Queryable,
  orgId: string,
  side: 'SALES' | 'PURCHASE',
  partyId: string,
): Promise<string | null> {
  const { party, column } = SIDE[side];
  const { rows } = await q.query<{ code: string | null }>(
    `SELECT COALESCE(pt.code, ot.code) AS code
       FROM (SELECT 1) one
       LEFT JOIN ${party} p ON p.org_id = $1 AND p.id = $2
       LEFT JOIN payment_terms pt ON pt.org_id = $1 AND pt.id = p.default_payment_term_id AND pt.is_active
       LEFT JOIN ledger_settings s ON s.org_id = $1
       LEFT JOIN payment_terms ot ON ot.org_id = $1 AND ot.is_active AND ot.id = ${column}`,
    [orgId, partyId],
  );
  return rows[0]?.code ?? null;
}

/** Phase 43a — a party/organization default must be an active term of this org. */
export async function assertActiveTermOnClient(q: Queryable, orgId: string, termId: string): Promise<void> {
  const { rows } = await q.query(
    'SELECT 1 FROM payment_terms WHERE org_id = $1 AND id = $2 AND is_active',
    [orgId, termId],
  );
  if (rows[0] === undefined) throw new ApiError(422, 'Payment term not found or inactive');
}
