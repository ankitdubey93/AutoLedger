import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { isValidAbn } from '../../utils/abn.js';
import { loadGstEvents } from './gstEventService.js';

/**
 * Phase 49h — amounts paid to flagged contractors in a financial year. Always
 * on a cash basis, whatever the organization's GST basis: the report is of
 * payments made. It reads the shared GST event stream, so a part-paid bill
 * counts for what was paid, and a debit note reduces it.
 */
export interface TparRow {
  vendorId: string;
  name: string;
  abn: string | null;
  address: string | null;
  grossPaidCents: number;
  gstCents: number;
  problems: string[];
}

export interface TparReport {
  financialYear: number;
  from: string;
  to: string;
  dueDate: string;
  rows: TparRow[];
  totalGrossCents: number;
  totalGstCents: number;
  /** Lines with no GST code, from before the organization became Australian. They are left out. */
  uncodedLineCount: number;
  lodgment: { lodgedOn: string; atoReference: string | null } | null;
}

interface VendorRow {
  id: string;
  name: string;
  tax_number: string | null;
  billing_address: string | null;
}

function bounds(financialYear: number): { from: string; to: string; dueDate: string } {
  return {
    from: `${String(financialYear - 1)}-07-01`,
    to: `${String(financialYear)}-06-30`,
    dueDate: `${String(financialYear)}-08-28`,
  };
}

function problemsFor(vendor: VendorRow): string[] {
  const problems: string[] = [];
  if (vendor.tax_number === null) problems.push('No ABN');
  else if (!isValidAbn(vendor.tax_number)) problems.push('ABN is not valid');
  if (vendor.billing_address === null || vendor.billing_address.trim() === '') problems.push('No address');
  return problems;
}

export async function tparReport(orgId: string, financialYear: number): Promise<TparReport> {
  const { from, to, dueDate } = bounds(financialYear);

  const { rows: lodged } = await pool.query<{ lodged_on: string; ato_reference: string | null; rows: TparRow[] }>(
    `SELECT to_char(lodged_on, 'YYYY-MM-DD') AS lodged_on, ato_reference, rows
       FROM tpar_returns WHERE org_id = $1 AND financial_year = $2`,
    [orgId, financialYear],
  );
  const stored = lodged[0];
  if (stored !== undefined) {
    return {
      financialYear,
      from,
      to,
      dueDate,
      rows: stored.rows,
      totalGrossCents: stored.rows.reduce((s, r) => s + r.grossPaidCents, 0),
      totalGstCents: stored.rows.reduce((s, r) => s + r.gstCents, 0),
      uncodedLineCount: 0,
      lodgment: { lodgedOn: stored.lodged_on, atoReference: stored.ato_reference },
    };
  }

  const { rows: vendors } = await pool.query<VendorRow>(
    'SELECT id, name, tax_number, billing_address FROM vendors WHERE org_id = $1 AND tpar_reportable ORDER BY name, id',
    [orgId],
  );
  const { events, uncodedLineCount } = await loadGstEvents(orgId, from, to, 'CASH');
  const totals = new Map<string, { gross: number; gst: number }>();
  for (const e of events) {
    if ((e.sourceKind !== 'BILL' && e.sourceKind !== 'DEBIT_NOTE') || e.partyId === null) continue;
    const t = totals.get(e.partyId) ?? { gross: 0, gst: 0 };
    t.gross += e.netCents + e.taxCents;
    t.gst += e.taxCents;
    totals.set(e.partyId, t);
  }

  const rows: TparRow[] = vendors.flatMap((vendor) => {
    const t = totals.get(vendor.id);
    if (t === undefined || t.gross === 0) return [];
    return [
      {
        vendorId: vendor.id,
        name: vendor.name,
        abn: vendor.tax_number,
        address: vendor.billing_address,
        grossPaidCents: t.gross,
        gstCents: t.gst,
        problems: problemsFor(vendor),
      },
    ];
  });

  return {
    financialYear,
    from,
    to,
    dueDate,
    rows,
    totalGrossCents: rows.reduce((s, r) => s + r.grossPaidCents, 0),
    totalGstCents: rows.reduce((s, r) => s + r.gstCents, 0),
    uncodedLineCount,
    lodgment: null,
  };
}

/** Stores the report as lodged. It is refused while a row is missing what the ATO asks for. */
export async function recordTparLodgment(
  orgId: string,
  userId: string,
  financialYear: number,
  input: { lodgedOn: string; atoReference: string | null },
): Promise<TparReport> {
  const report = await tparReport(orgId, financialYear);
  if (report.lodgment !== null) throw new ApiError(409, 'This year is already recorded as lodged');
  if (input.lodgedOn <= report.to) throw new ApiError(422, 'A TPAR is lodged after the financial year ends');
  const incomplete = report.rows.filter((r) => r.problems.length > 0);
  if (incomplete.length > 0) {
    throw new ApiError(422, `Fix these contractors first: ${incomplete.map((r) => `${r.name} (${r.problems.join(', ')})`).join('; ')}`);
  }
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO tpar_returns (org_id, financial_year, lodged_on, ato_reference, rows, lodged_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [orgId, financialYear, input.lodgedOn, input.atoReference, JSON.stringify(report.rows), userId],
    );
  });
  return tparReport(orgId, financialYear);
}
