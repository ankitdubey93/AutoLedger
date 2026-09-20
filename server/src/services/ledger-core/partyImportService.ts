import type { PoolClient } from 'pg';
import { ApiError } from '../../utils/apiError.js';
import type { MigrationCommitPreview, MigrationImportRow } from '../../types/ledger-core.js';

/**
 * Customer/vendor import — the validate, preview and commit halves for the
 * CUSTOMERS and VENDORS kinds, delegated to by `migrationImportService.ts`
 * (Phase 24). Extends the Phase 9 staged importer rather than building a
 * second import pipeline — the staging, per-row fixes, preview and
 * all-or-nothing commit are all shared with chartImportService and
 * openingBalanceImportService.
 *
 * Commit matches an import row to an existing party by lowercased email
 * first, then by lowercased name. A match MERGES — filling only the columns
 * that are currently NULL on the existing row — never overwriting data
 * already in the system. No match INSERTS a new row.
 *
 * `customers` and `vendors` are two distinct tables with different column
 * sets (customers has no `payment_terms`), so this is two full code paths
 * rather than one parameterized by a table name — the only identifier this
 * file would otherwise need to interpolate (guardrails rule 4).
 */

type PartyKind = 'CUSTOMERS' | 'VENDORS';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Per-row validation. Every statement carries `org_id = $n` (rule 1); this
 * runs on the caller's already-open transaction client. A name or email
 * matching an existing row is NOT an error here — it is a merge, reported by
 * `preview` — so this only checks in-file shape: a required name, a
 * well-formed email, and no duplicate name/email within the file itself.
 */
export async function validateRows(
  _client: PoolClient,
  _orgId: string,
  _kind: PartyKind,
  rows: readonly MigrationImportRow[],
): Promise<{ rowId: string; errors: string[] }[]> {
  const nameCounts = new Map<string, number>();
  const emailCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.partyName !== null) {
      const key = row.partyName.toLowerCase();
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    if (row.partyEmail !== null) {
      const key = row.partyEmail.toLowerCase();
      emailCounts.set(key, (emailCounts.get(key) ?? 0) + 1);
    }
  }

  return rows.map((row) => {
    const errors: string[] = [];

    if (row.partyName === null) {
      errors.push('name is required');
    } else if ((nameCounts.get(row.partyName.toLowerCase()) ?? 0) > 1) {
      errors.push(`duplicate name "${row.partyName}" in this file`);
    }

    if (row.partyEmail !== null) {
      if (!EMAIL_PATTERN.test(row.partyEmail)) {
        errors.push(`"${row.partyEmail}" is not a valid email address`);
      } else if ((emailCounts.get(row.partyEmail.toLowerCase()) ?? 0) > 1) {
        errors.push(`duplicate email "${row.partyEmail}" in this file`);
      }
    }

    return { rowId: row.id, errors };
  });
}

function assertPartyKind(kind: string): asserts kind is PartyKind {
  if (kind !== 'CUSTOMERS' && kind !== 'VENDORS') {
    throw new Error(`partyImportService called for non-party kind "${kind}"`);
  }
}

interface ExistingParty {
  name: string;
  email: string | null;
}

async function existingCustomers(client: PoolClient, orgId: string): Promise<ExistingParty[]> {
  const { rows } = await client.query<ExistingParty>('SELECT name, email FROM customers WHERE org_id = $1', [orgId]);
  return rows;
}

async function existingVendors(client: PoolClient, orgId: string): Promise<ExistingParty[]> {
  const { rows } = await client.query<ExistingParty>('SELECT name, email FROM vendors WHERE org_id = $1', [orgId]);
  return rows;
}

export async function preview(client: PoolClient, orgId: string, importId: string): Promise<MigrationCommitPreview> {
  const { rows: importRows } = await client.query<{ kind: string; status: string; error_count: number }>(
    'SELECT kind, status, error_count FROM migration_imports WHERE id = $1 AND org_id = $2',
    [importId, orgId],
  );
  const imp = importRows[0];
  if (imp === undefined) throw new ApiError(404, 'Migration import not found');
  assertPartyKind(imp.kind);

  const { rows: rowRows } = await client.query<{ party_name: string | null; party_email: string | null }>(
    `SELECT party_name, party_email FROM migration_import_rows
      WHERE org_id = $1 AND import_id = $2 AND status = 'VALID'`,
    [orgId, importId],
  );

  const existing = imp.kind === 'CUSTOMERS' ? await existingCustomers(client, orgId) : await existingVendors(client, orgId);
  const existingNames = new Set(existing.map((r) => r.name.toLowerCase()));
  const existingEmails = new Set(existing.filter((r) => r.email !== null).map((r) => (r.email as string).toLowerCase()));

  let partiesToCreate = 0;
  let partiesToMerge = 0;
  for (const row of rowRows) {
    const matchesEmail = row.party_email !== null && existingEmails.has(row.party_email.toLowerCase());
    const matchesName = row.party_name !== null && existingNames.has(row.party_name.toLowerCase());
    if (matchesEmail || matchesName) partiesToMerge += 1;
    else partiesToCreate += 1;
  }

  return {
    kind: imp.kind,
    canCommit: imp.error_count === 0 && imp.status === 'VALIDATED',
    blockingErrorCount: imp.error_count,
    accountsToCreate: 0,
    accountsToMerge: 0,
    totalDebitCents: 0,
    totalCreditCents: 0,
    plugCents: 0,
    plugAccountCode: '',
    entryDate: null,
    partiesToCreate,
    partiesToMerge,
  };
}

interface PartyRowRow {
  party_name: string | null;
  party_email: string | null;
  party_phone: string | null;
  party_address: string | null;
  party_tax_number: string | null;
  party_payment_terms: string | null;
  party_notes: string | null;
}

interface ExistingCustomerRow {
  id: string;
  email: string | null;
  phone: string | null;
  billing_address: string | null;
  tax_number: string | null;
  notes: string | null;
}

interface ExistingVendorRow extends ExistingCustomerRow {
  payment_terms: string | null;
}

/** Match by lowercased email first, then by lowercased name. Every statement carries `org_id` (rule 1). */
async function findExistingCustomer(
  client: PoolClient,
  orgId: string,
  name: string | null,
  emailLower: string | null,
): Promise<ExistingCustomerRow | null> {
  if (emailLower !== null) {
    const { rows } = await client.query<ExistingCustomerRow>(
      'SELECT id, email, phone, billing_address, tax_number, notes FROM customers WHERE org_id = $1 AND LOWER(email) = $2',
      [orgId, emailLower],
    );
    if (rows[0] !== undefined) return rows[0];
  }
  if (name !== null) {
    const { rows } = await client.query<ExistingCustomerRow>(
      'SELECT id, email, phone, billing_address, tax_number, notes FROM customers WHERE org_id = $1 AND LOWER(name) = $2',
      [orgId, name.toLowerCase()],
    );
    if (rows[0] !== undefined) return rows[0];
  }
  return null;
}

async function findExistingVendor(
  client: PoolClient,
  orgId: string,
  name: string | null,
  emailLower: string | null,
): Promise<ExistingVendorRow | null> {
  if (emailLower !== null) {
    const { rows } = await client.query<ExistingVendorRow>(
      `SELECT id, email, phone, billing_address, tax_number, payment_terms, notes
         FROM vendors WHERE org_id = $1 AND LOWER(email) = $2`,
      [orgId, emailLower],
    );
    if (rows[0] !== undefined) return rows[0];
  }
  if (name !== null) {
    const { rows } = await client.query<ExistingVendorRow>(
      `SELECT id, email, phone, billing_address, tax_number, payment_terms, notes
         FROM vendors WHERE org_id = $1 AND LOWER(name) = $2`,
      [orgId, name.toLowerCase()],
    );
    if (rows[0] !== undefined) return rows[0];
  }
  return null;
}

/**
 * `customers` has no `payment_terms` column — an imported term is appended to
 * `notes` on its own line rather than dropped silently.
 */
function notesWithTerms(notes: string | null, paymentTerms: string | null): string | null {
  if (paymentTerms === null) return notes;
  const line = `Payment terms: ${paymentTerms}`;
  if (notes === null) return line;
  return `${notes}\n${line}`;
}

async function insertCustomer(client: PoolClient, orgId: string, createdBy: string, row: PartyRowRow): Promise<void> {
  await client.query(
    `INSERT INTO customers (org_id, created_by, name, email, phone, billing_address, tax_number, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      orgId,
      createdBy,
      row.party_name,
      row.party_email === null ? null : row.party_email.toLowerCase(),
      row.party_phone,
      row.party_address,
      row.party_tax_number,
      notesWithTerms(row.party_notes, row.party_payment_terms),
    ],
  );
}

async function insertVendor(client: PoolClient, orgId: string, createdBy: string, row: PartyRowRow): Promise<void> {
  await client.query(
    `INSERT INTO vendors (org_id, created_by, name, email, phone, billing_address, tax_number, payment_terms, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      orgId,
      createdBy,
      row.party_name,
      row.party_email === null ? null : row.party_email.toLowerCase(),
      row.party_phone,
      row.party_address,
      row.party_tax_number,
      row.party_payment_terms,
      row.party_notes,
    ],
  );
}

/** Merges only columns that are currently NULL on the existing row — an import never overwrites what is already there. */
async function mergeCustomer(
  client: PoolClient,
  orgId: string,
  existing: ExistingCustomerRow,
  row: PartyRowRow,
): Promise<void> {
  const nextEmail = existing.email ?? (row.party_email === null ? null : row.party_email.toLowerCase());
  const nextPhone = existing.phone ?? row.party_phone;
  const nextAddress = existing.billing_address ?? row.party_address;
  const nextTaxNumber = existing.tax_number ?? row.party_tax_number;
  const nextNotes = existing.notes ?? notesWithTerms(null, row.party_payment_terms);

  await client.query(
    `UPDATE customers SET email = $1, phone = $2, billing_address = $3, tax_number = $4, notes = $5
      WHERE id = $6 AND org_id = $7`,
    [nextEmail, nextPhone, nextAddress, nextTaxNumber, nextNotes, existing.id, orgId],
  );
}

async function mergeVendor(client: PoolClient, orgId: string, existing: ExistingVendorRow, row: PartyRowRow): Promise<void> {
  const nextEmail = existing.email ?? (row.party_email === null ? null : row.party_email.toLowerCase());
  const nextPhone = existing.phone ?? row.party_phone;
  const nextAddress = existing.billing_address ?? row.party_address;
  const nextTaxNumber = existing.tax_number ?? row.party_tax_number;
  const nextPaymentTerms = existing.payment_terms ?? row.party_payment_terms;
  const nextNotes = existing.notes ?? row.party_notes;

  await client.query(
    `UPDATE vendors SET email = $1, phone = $2, billing_address = $3, tax_number = $4, payment_terms = $5, notes = $6
      WHERE id = $7 AND org_id = $8`,
    [nextEmail, nextPhone, nextAddress, nextTaxNumber, nextPaymentTerms, nextNotes, existing.id, orgId],
  );
}

/**
 * All-or-nothing. Runs on the caller's transaction — no BEGIN/COMMIT here.
 * `migrationImportService.commit` guarantees the import is VALIDATED before
 * calling this, so every remaining row here is VALID or EXCLUDED.
 */
export async function commitOnClient(
  client: PoolClient,
  orgId: string,
  importId: string,
): Promise<{ created: number; merged: number }> {
  const { rows: importRows } = await client.query<{ kind: string; created_by: string }>(
    'SELECT kind, created_by FROM migration_imports WHERE id = $1 AND org_id = $2',
    [importId, orgId],
  );
  const imp = importRows[0];
  if (imp === undefined) throw new ApiError(404, 'Migration import not found');
  assertPartyKind(imp.kind);
  const createdBy = imp.created_by;

  const { rows: rowRows } = await client.query<PartyRowRow>(
    `SELECT party_name, party_email, party_phone, party_address, party_tax_number, party_payment_terms, party_notes
       FROM migration_import_rows
      WHERE org_id = $1 AND import_id = $2 AND status = 'VALID'
      ORDER BY row_number ASC`,
    [orgId, importId],
  );

  let created = 0;
  let merged = 0;

  for (const row of rowRows) {
    const emailLower = row.party_email === null ? null : row.party_email.toLowerCase();

    if (imp.kind === 'CUSTOMERS') {
      const existing = await findExistingCustomer(client, orgId, row.party_name, emailLower);
      if (existing !== null) {
        await mergeCustomer(client, orgId, existing, row);
        merged += 1;
      } else {
        await insertCustomer(client, orgId, createdBy, row);
        created += 1;
      }
    } else {
      const existing = await findExistingVendor(client, orgId, row.party_name, emailLower);
      if (existing !== null) {
        await mergeVendor(client, orgId, existing, row);
        merged += 1;
      } else {
        await insertVendor(client, orgId, createdBy, row);
        created += 1;
      }
    }
  }

  await client.query(
    "UPDATE migration_imports SET status = 'COMMITTED', committed_at = now() WHERE id = $1 AND org_id = $2",
    [importId, orgId],
  );

  return { created, merged };
}
