import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { beginTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { cents, parseCents, sumCents } from '../../utils/money.js';
import { convertToBase } from '../../utils/fxRate.js';
import { emitEvent } from '../outboxService.js';
import * as journalService from './journalService.js';
import * as fxRateService from './fxRateService.js';
import { allocatedCentsSubquery, resolveControlAccount } from './paymentService.js';
import type {
  FxExposureDocument,
  FxExposureReport,
  FxRevaluation,
  FxRevaluationLine,
} from '../../types/ledger-core.js';

/**
 * LedgerCore period-end unrealized FX revaluation (Phase 8).
 *
 * `computeExposure` is a read-only preview — it writes nothing and posts
 * nothing. `runRevaluation` re-computes the same exposure on its own
 * transaction client (never trusting a figure the caller passed in), posts
 * one entry restating open foreign-currency AR/AP at the as-of rate through
 * `6820 Unrealized FX Gain/Loss`, and immediately posts an automatic
 * next-day reversal — so a later REALIZED settlement always compares its
 * rate against the document's original frozen rate, never a revalued
 * carrying amount. See docs/ledger-core.md § 3 and
 * study/architecture/realized-and-unrealized-fx.md.
 */

type Queryable = Pick<PoolClient, 'query'>;

const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

/** 'YYYY-MM-DD' -> the next calendar day. Date.UTC-anchored, never a local-timezone Date parse. */
function nextDay(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Not a YYYY-MM-DD date: "${iso}"`);
  }
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

interface ExposureDocRow {
  id: string;
  document_number: string | null;
  counterparty_name: string;
  currency_code: string;
  document_rate: string;
  outstanding_cents: string;
}

async function loadOpenInvoices(
  client: Queryable,
  orgId: string,
  baseCurrency: string,
  asOfDate: string,
): Promise<ExposureDocRow[]> {
  const { rows } = await client.query<ExposureDocRow>(
    `SELECT * FROM (
       SELECT i.id, i.invoice_number AS document_number, c.name AS counterparty_name,
              i.currency_code, i.fx_rate::text AS document_rate,
              (i.total_cents - ${allocatedCentsSubquery('i', 'invoice_id')}::bigint) AS outstanding_cents
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
        WHERE i.org_id = $1
          AND i.status = 'ISSUED'
          AND i.currency_code <> $2
          AND i.issue_date <= $3::date
     ) sub
     WHERE outstanding_cents > 0`,
    [orgId, baseCurrency, asOfDate],
  );
  return rows;
}

async function loadOpenBills(
  client: Queryable,
  orgId: string,
  baseCurrency: string,
  asOfDate: string,
): Promise<ExposureDocRow[]> {
  const { rows } = await client.query<ExposureDocRow>(
    `SELECT * FROM (
       SELECT b.id, b.vendor_reference AS document_number, v.name AS counterparty_name,
              b.currency_code, b.fx_rate::text AS document_rate,
              (b.total_cents - ${allocatedCentsSubquery('b', 'bill_id')}::bigint) AS outstanding_cents
         FROM bills b
         JOIN vendors v ON v.id = b.vendor_id AND v.org_id = b.org_id
        WHERE b.org_id = $1
          AND b.status = 'POSTED'
          AND b.currency_code <> $2
          AND b.bill_date <= $3::date
     ) sub
     WHERE outstanding_cents > 0`,
    [orgId, baseCurrency, asOfDate],
  );
  return rows;
}

interface LoadedExposure {
  invoices: FxExposureDocument[];
  bills: FxExposureDocument[];
  baseCurrency: string;
}

/**
 * The shared computation `computeExposure` (on `pool`) and `runRevaluation`
 * (on its own transaction `client`) both call — resolving each distinct
 * currency's revaluation rate once, not once per document.
 */
async function loadExposure(client: Queryable, orgId: string, asOfDate: string): Promise<LoadedExposure> {
  const { rows: orgRows } = await client.query<{ base_currency: string }>(
    'SELECT base_currency FROM organizations WHERE id = $1',
    [orgId],
  );
  const baseCurrency = orgRows[0]?.base_currency.trim();
  if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');

  const [invoiceRows, billRows] = await Promise.all([
    loadOpenInvoices(client, orgId, baseCurrency, asOfDate),
    loadOpenBills(client, orgId, baseCurrency, asOfDate),
  ]);

  const distinctCurrencies = [...new Set([...invoiceRows, ...billRows].map((r) => r.currency_code.trim()))];
  const ratesByCurrency = new Map<string, string>();
  for (const currencyCode of distinctCurrencies) {
    const resolved = await fxRateService.requireRateOnClient(client, orgId, currencyCode, baseCurrency, asOfDate);
    ratesByCurrency.set(currencyCode, resolved.rate);
  }

  function toExposureDoc(row: ExposureDocRow, documentType: 'INVOICE' | 'BILL'): FxExposureDocument {
    const currencyCode = row.currency_code.trim();
    const revaluationRate = ratesByCurrency.get(currencyCode);
    if (revaluationRate === undefined) throw new Error(`No resolved rate for currency ${currencyCode}`);
    const outstandingCents = parseCents(row.outstanding_cents);
    const carryingBaseCents = convertToBase(cents(outstandingCents), row.document_rate);
    const revaluedBaseCents = convertToBase(cents(outstandingCents), revaluationRate);
    return {
      documentType,
      documentId: row.id,
      documentNumber: row.document_number,
      counterpartyName: row.counterparty_name,
      currencyCode,
      outstandingCents,
      documentRate: row.document_rate,
      revaluationRate,
      carryingBaseCents,
      revaluedBaseCents,
      deltaCents: revaluedBaseCents - carryingBaseCents,
    };
  }

  return {
    invoices: invoiceRows.map((r) => toExposureDoc(r, 'INVOICE')),
    bills: billRows.map((r) => toExposureDoc(r, 'BILL')),
    baseCurrency,
  };
}

export async function computeExposure(orgId: string, asOfDate: string): Promise<FxExposureReport> {
  const { invoices, bills, baseCurrency } = await loadExposure(pool, orgId, asOfDate);
  const documents = [...invoices, ...bills];

  const byCurrencyMap = new Map<
    string,
    { outstandingCents: number; carryingBaseCents: number; revaluedBaseCents: number; deltaCents: number }
  >();
  for (const doc of documents) {
    const existing = byCurrencyMap.get(doc.currencyCode) ?? {
      outstandingCents: 0,
      carryingBaseCents: 0,
      revaluedBaseCents: 0,
      deltaCents: 0,
    };
    byCurrencyMap.set(doc.currencyCode, {
      outstandingCents: existing.outstandingCents + doc.outstandingCents,
      carryingBaseCents: existing.carryingBaseCents + doc.carryingBaseCents,
      revaluedBaseCents: existing.revaluedBaseCents + doc.revaluedBaseCents,
      deltaCents: existing.deltaCents + doc.deltaCents,
    });
  }
  const byCurrency = [...byCurrencyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currencyCode, totals]) => ({ currencyCode, ...totals }));

  const { rows: existingRows } = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM fx_revaluations WHERE org_id = $1 AND as_of_date = $2) AS exists',
    [orgId, asOfDate],
  );

  return {
    asOfDate,
    baseCurrency,
    documents,
    byCurrency,
    totalDeltaCents: documents.reduce((sum, d) => sum + d.deltaCents, 0),
    alreadyRevalued: existingRows[0]?.exists ?? false,
  };
}

/** ledger_settings.unrealized_fx_account_id, falling back to chart code 6820. */
async function resolveUnrealizedFxAccount(client: PoolClient, orgId: string): Promise<string> {
  const { rows } = await client.query<{ account_id: string | null }>(
    'SELECT unrealized_fx_account_id AS account_id FROM ledger_settings WHERE org_id = $1',
    [orgId],
  );
  const configuredId = rows[0]?.account_id ?? null;
  if (configuredId !== null) return configuredId;

  const { rows: fallbackRows } = await client.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, '6820'],
  );
  const fallbackId = fallbackRows[0]?.id;
  if (fallbackId === undefined) {
    throw new ApiError(422, 'No unrealized FX account is configured. Set one in settings.');
  }
  return fallbackId;
}

export async function runRevaluation(orgId: string, createdBy: string, asOfDate: string): Promise<FxRevaluation> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { invoices, bills } = await loadExposure(client, orgId, asOfDate);
    const documents = [...invoices, ...bills];
    if (documents.length === 0) {
      throw new ApiError(422, 'There is no open foreign-currency balance to revalue on this date');
    }

    const arDelta = sumCents(invoices.map((d) => cents(d.deltaCents)));
    const apDelta = sumCents(bills.map((d) => cents(d.deltaCents)));

    // Every line built below is already a base-currency amount (the AR/AP
    // deltas and the 6820 plug), so currencyCode/fxRate are left unset —
    // journalService.createEntryOnClient defaults an unset line to the org's
    // base currency at ONE_RATE, the same as every pre-Phase-8 posting.
    const glLines: { accountId: string; debitCents: number; creditCents: number }[] = [];

    if (arDelta !== 0) {
      const ar = await resolveControlAccount(client, orgId, 'RECEIVE');
      glLines.push(
        arDelta > 0
          ? { accountId: ar.id, debitCents: arDelta, creditCents: 0 }
          : { accountId: ar.id, debitCents: 0, creditCents: -arDelta },
      );
    }
    if (apDelta !== 0) {
      const ap = await resolveControlAccount(client, orgId, 'PAY');
      glLines.push(
        apDelta > 0
          ? { accountId: ap.id, debitCents: 0, creditCents: apDelta }
          : { accountId: ap.id, debitCents: -apDelta, creditCents: 0 },
      );
    }

    // The plug: same technique as the realized-FX settlement in
    // paymentService.createPaymentOnClient, one account instead of two —
    // 6820 covers both directions, unlike the realized 4910/6810 pair.
    const baseDebitTotal = sumCents(glLines.map((l) => cents(l.debitCents)));
    const baseCreditTotal = sumCents(glLines.map((l) => cents(l.creditCents)));
    const imbalance = baseDebitTotal - baseCreditTotal;
    if (imbalance > 0) {
      const unrealizedAccountId = await resolveUnrealizedFxAccount(client, orgId);
      glLines.push({ accountId: unrealizedAccountId, debitCents: 0, creditCents: imbalance });
    } else if (imbalance < 0) {
      const unrealizedAccountId = await resolveUnrealizedFxAccount(client, orgId);
      glLines.push({ accountId: unrealizedAccountId, debitCents: -imbalance, creditCents: 0 });
    }

    if (glLines.length < 2) {
      // Every document's rate happened to match its own frozen rate exactly
      // (no net effect at all) — nothing to post.
      throw new ApiError(422, 'There is no open foreign-currency balance to revalue on this date');
    }

    const { rows: idRows } = await client.query<{ id: string }>('SELECT gen_random_uuid() AS id');
    const revaluationId = idRows[0]?.id;
    if (revaluationId === undefined) throw new Error('gen_random_uuid() produced no row');

    const journalEntryId = await journalService.createEntryOnClient(client, orgId, createdBy, {
      entryDate: asOfDate,
      description: `Unrealized FX revaluation — ${asOfDate}`,
      sourceType: 'fx_revaluation',
      sourceId: revaluationId,
      lines: glLines,
    });

    // The reversal is what keeps realized FX honest at settlement: it always
    // compares the settlement rate against the document's ORIGINAL frozen
    // rate, never against a revalued carrying amount.
    const reversalJournalEntryId = await journalService.reverseEntryOnClient(
      client,
      orgId,
      createdBy,
      journalEntryId,
      nextDay(asOfDate),
    );

    const totalDeltaCents = documents.reduce((sum, d) => sum + d.deltaCents, 0);

    await client.query(
      `INSERT INTO fx_revaluations
         (id, org_id, as_of_date, journal_entry_id, reversal_journal_entry_id, total_delta_cents, line_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [revaluationId, orgId, asOfDate, journalEntryId, reversalJournalEntryId, totalDeltaCents, documents.length, createdBy],
    );

    await client.query(
      `INSERT INTO fx_revaluation_lines
         (org_id, revaluation_id, invoice_id, bill_id, currency_code, outstanding_cents,
          document_rate, revaluation_rate, carrying_base_cents, revalued_base_cents, delta_cents)
       SELECT $1, $2, v.invoice_id, v.bill_id, v.currency_code, v.outstanding_cents,
              v.document_rate, v.revaluation_rate, v.carrying_base_cents, v.revalued_base_cents, v.delta_cents
         FROM unnest(
                $3::uuid[], $4::uuid[], $5::text[], $6::bigint[],
                $7::numeric[], $8::numeric[], $9::bigint[], $10::bigint[], $11::bigint[]
              ) AS v(invoice_id, bill_id, currency_code, outstanding_cents,
                      document_rate, revaluation_rate, carrying_base_cents, revalued_base_cents, delta_cents)`,
      [
        orgId,
        revaluationId,
        documents.map((d) => (d.documentType === 'INVOICE' ? d.documentId : null)),
        documents.map((d) => (d.documentType === 'BILL' ? d.documentId : null)),
        documents.map((d) => d.currencyCode),
        documents.map((d) => d.outstandingCents),
        documents.map((d) => d.documentRate),
        documents.map((d) => d.revaluationRate),
        documents.map((d) => d.carryingBaseCents),
        documents.map((d) => d.revaluedBaseCents),
        documents.map((d) => d.deltaCents),
      ],
    );

    await emitEvent(client, orgId, 'ledger-core', 'fx.revaluation_posted', {
      revaluationId,
      asOfDate,
      totalDeltaCents,
      lineCount: documents.length,
      journalEntryId,
      reversalJournalEntryId,
    });

    await client.query('COMMIT');
    return await getRevaluationById(orgId, revaluationId);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'A revaluation already exists for this date');
    }
    throw err;
  } finally {
    client.release();
  }
}

interface RevaluationRow {
  id: string;
  as_of_date: string;
  journal_entry_id: string;
  reversal_journal_entry_id: string;
  total_delta_cents: string;
  line_count: number;
  created_by: string;
  created_at: Date;
}

interface RevaluationLineRow {
  id: string;
  invoice_id: string | null;
  bill_id: string | null;
  document_number: string | null;
  counterparty_name: string;
  currency_code: string;
  outstanding_cents: string;
  document_rate: string;
  revaluation_rate: string;
  carrying_base_cents: string;
  revalued_base_cents: string;
  delta_cents: string;
}

async function loadRevaluationLines(orgId: string, revaluationId: string): Promise<FxRevaluationLine[]> {
  const { rows } = await pool.query<RevaluationLineRow>(
    `SELECT l.id, l.invoice_id, l.bill_id,
            COALESCE(i.invoice_number, b.vendor_reference) AS document_number,
            COALESCE(c.name, v.name) AS counterparty_name,
            l.currency_code, l.outstanding_cents, l.document_rate::text AS document_rate,
            l.revaluation_rate::text AS revaluation_rate, l.carrying_base_cents, l.revalued_base_cents, l.delta_cents
       FROM fx_revaluation_lines l
       LEFT JOIN invoices i ON i.id = l.invoice_id AND i.org_id = l.org_id
       LEFT JOIN bills b ON b.id = l.bill_id AND b.org_id = l.org_id
       LEFT JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
       LEFT JOIN vendors v ON v.id = b.vendor_id AND v.org_id = b.org_id
      WHERE l.org_id = $1 AND l.revaluation_id = $2
      ORDER BY l.created_at ASC, l.id ASC`,
    [orgId, revaluationId],
  );

  return rows.map((row) => ({
    id: row.id,
    documentType: row.invoice_id !== null ? 'INVOICE' : 'BILL',
    invoiceId: row.invoice_id,
    billId: row.bill_id,
    documentNumber: row.document_number,
    counterpartyName: row.counterparty_name,
    currencyCode: row.currency_code.trim(),
    outstandingCents: parseCents(row.outstanding_cents),
    documentRate: row.document_rate,
    revaluationRate: row.revaluation_rate,
    carryingBaseCents: parseCents(row.carrying_base_cents),
    revaluedBaseCents: parseCents(row.revalued_base_cents),
    deltaCents: parseCents(row.delta_cents),
  }));
}

function toRevaluation(row: RevaluationRow, lines: FxRevaluationLine[]): FxRevaluation {
  return {
    id: row.id,
    asOfDate: row.as_of_date,
    journalEntryId: row.journal_entry_id,
    reversalJournalEntryId: row.reversal_journal_entry_id,
    totalDeltaCents: parseCents(row.total_delta_cents),
    lineCount: row.line_count,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    lines,
  };
}

export async function getRevaluationById(orgId: string, id: string): Promise<FxRevaluation> {
  const { rows } = await pool.query<RevaluationRow>(
    `SELECT id, as_of_date, journal_entry_id, reversal_journal_entry_id, total_delta_cents,
            line_count, created_by, created_at
       FROM fx_revaluations WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'FX revaluation not found');

  const lines = await loadRevaluationLines(orgId, row.id);
  return toRevaluation(row, lines);
}

export async function listRevaluations(
  orgId: string,
  options: { page: number; limit: number },
): Promise<{ revaluations: FxRevaluation[]; totalCount: number }> {
  const { rows: countRows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM fx_revaluations WHERE org_id = $1',
    [orgId],
  );
  const totalCount = Number.parseInt(countRows[0]?.count ?? '0', 10);

  const offset = (options.page - 1) * options.limit;
  const { rows } = await pool.query<RevaluationRow>(
    `SELECT id, as_of_date, journal_entry_id, reversal_journal_entry_id, total_delta_cents,
            line_count, created_by, created_at
       FROM fx_revaluations
      WHERE org_id = $1
      ORDER BY as_of_date DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [orgId, options.limit, offset],
  );

  const revaluations = await Promise.all(
    rows.map(async (row) => toRevaluation(row, await loadRevaluationLines(orgId, row.id))),
  );

  return { revaluations, totalCount };
}
