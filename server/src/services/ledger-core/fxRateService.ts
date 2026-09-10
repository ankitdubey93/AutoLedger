import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { isCurrencyCode, ONE_RATE } from '../../utils/fxRate.js';
import {
  isFxRateSource,
  type FxRate,
  type FxRateSource,
  type ResolvedRate,
} from '../../types/ledger-core.js';

/**
 * LedgerCore exchange rates.
 *
 * Every function takes `orgId` first and every statement carries an `org_id`
 * predicate (guardrails rule 1). `resolveRateOnClient`/`requireRateOnClient`
 * take a caller-supplied `client` (or `pool`) so a document service can
 * resolve a rate on its own transaction (guardrails rule 5).
 */

type Queryable = Pick<PoolClient, 'query'>;

const PG_CHECK_VIOLATION = '23514';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface FxRateRow {
  id: string;
  from_code: string;
  to_code: string;
  rate_date: string;
  rate: string;
  source: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

const FX_RATE_COLUMNS = `id, from_code, to_code, rate_date, rate::text AS rate, source,
                          created_by, created_at, updated_at`;

function toFxRate(row: FxRateRow): FxRate {
  if (!isFxRateSource(row.source)) {
    throw new Error(`Unknown fx rate source "${row.source}" on rate ${row.id}`);
  }
  return {
    id: row.id,
    fromCode: row.from_code,
    toCode: row.to_code,
    rateDate: row.rate_date,
    rate: row.rate,
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface ListRatesOptions {
  page: number;
  limit: number;
  fromCode: string | null;
  from: string | null; // rate_date >=
  to: string | null; // rate_date <=
}

export async function listRates(
  orgId: string,
  options: ListRatesOptions,
): Promise<{ rates: FxRate[]; totalCount: number }> {
  const clauses = ['org_id = $1'];
  const values: unknown[] = [orgId];

  if (options.fromCode !== null) {
    values.push(options.fromCode);
    clauses.push(`from_code = $${String(values.length)}`);
  }
  if (options.from !== null) {
    values.push(options.from);
    clauses.push(`rate_date >= $${String(values.length)}::date`);
  }
  if (options.to !== null) {
    values.push(options.to);
    clauses.push(`rate_date <= $${String(values.length)}::date`);
  }

  const where = clauses.join(' AND ');

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM fx_rates WHERE ${where}`,
    values,
  );
  const totalCount = Number.parseInt(countRows[0]?.count ?? '0', 10);

  const offset = (options.page - 1) * options.limit;
  const { rows } = await pool.query<FxRateRow>(
    `SELECT ${FX_RATE_COLUMNS} FROM fx_rates
      WHERE ${where}
      ORDER BY rate_date DESC, from_code ASC, id DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, options.limit, offset],
  );

  return { rates: rows.map(toFxRate), totalCount };
}

export async function upsertRate(
  orgId: string,
  createdBy: string,
  input: { fromCode: string; toCode: string; rateDate: string; rate: string; source: FxRateSource },
): Promise<FxRate> {
  if (!isCurrencyCode(input.fromCode) || !isCurrencyCode(input.toCode)) {
    throw new ApiError(400, 'fromCode and toCode must be 3-letter ISO currency codes');
  }
  if (input.fromCode === input.toCode) {
    throw new ApiError(422, 'A currency cannot have a rate against itself');
  }

  try {
    // Re-posting the same pair and date overwrites, never a 409 — a
    // corrected rate is normal operations, not a posted financial document
    // (guardrails rule 6 does not apply to reference data).
    const { rows } = await withTransaction((client) =>
      client.query<FxRateRow>(
        `INSERT INTO fx_rates (org_id, from_code, to_code, rate_date, rate, source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (org_id, from_code, to_code, rate_date)
         DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, updated_at = now()
         RETURNING ${FX_RATE_COLUMNS}`,
        [orgId, input.fromCode, input.toCode, input.rateDate, input.rate, input.source, createdBy],
      ),
    );

    const row = rows[0];
    if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
    return toFxRate(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_CHECK_VIOLATION) {
      throw new ApiError(422, 'Rate must be a positive number no greater than 1,000,000');
    }
    throw err;
  }
}

export async function deleteRate(orgId: string, id: string): Promise<void> {
  // Deleting a rate cannot corrupt history: every document and ledger line
  // stores the rate it used at write time, not a pointer to this row.
  const { rowCount } = await withTransaction((client) =>
    client.query('DELETE FROM fx_rates WHERE id = $1 AND org_id = $2', [id, orgId]),
  );
  if (rowCount === 0) throw new ApiError(404, 'Exchange rate not found');
}

/** null when no rate exists on or before `onDate`. Identity when the codes match. */
export async function resolveRateOnClient(
  client: Queryable,
  orgId: string,
  fromCode: string,
  toCode: string,
  onDate: string,
): Promise<ResolvedRate | null> {
  if (fromCode === toCode) {
    return { fromCode, toCode, rate: ONE_RATE, rateDate: onDate, identity: true };
  }

  // rate_date <= $4, never = $4 — a rate feed has weekend and holiday gaps,
  // and an exact-date match is a bug waiting for a Saturday.
  const { rows } = await client.query<{ rate: string; rate_date: string }>(
    `SELECT rate::text AS rate, rate_date
       FROM fx_rates
      WHERE org_id = $1 AND from_code = $2 AND to_code = $3 AND rate_date <= $4::date
      ORDER BY rate_date DESC
      LIMIT 1`,
    [orgId, fromCode, toCode, onDate],
  );

  const row = rows[0];
  if (row === undefined) return null;

  return { fromCode, toCode, rate: row.rate, rateDate: row.rate_date, identity: false };
}

/** resolveRateOnClient, but throws ApiError(422, ...) instead of returning null. */
export async function requireRateOnClient(
  client: Queryable,
  orgId: string,
  fromCode: string,
  toCode: string,
  onDate: string,
): Promise<ResolvedRate> {
  const resolved = await resolveRateOnClient(client, orgId, fromCode, toCode, onDate);
  if (resolved === null) {
    throw new ApiError(422, `No exchange rate for ${fromCode} to ${toCode} on or before ${onDate}`);
  }
  return resolved;
}
