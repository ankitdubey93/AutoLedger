import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { normalizeForMatching } from '../../utils/matchScore.js';
import type { Vendor } from '../../types/ledger-core.js';

/**
 * LedgerCore vendors — the parties bills are entered against.
 *
 * Every function takes `orgId` first and every statement carries an `org_id`
 * predicate (guardrails rule 1). That `orgId` always originates from the
 * verified access token, never from a param, header or body.
 *
 * There is no delete route: a vendor is retired with `isActive: false`,
 * matching `customers` — once a bill can reference one, deleting the row out
 * from under a posted document is not an option.
 */

interface VendorRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billing_address: string | null;
  tax_number: string | null;
  payment_terms: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const VENDOR_COLUMNS = `id, name, email, phone, billing_address, tax_number, payment_terms, notes,
                         is_active, created_at, updated_at`;

function toVendor(row: VendorRow): Vendor {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    billingAddress: row.billing_address,
    taxNumber: row.tax_number,
    paymentTerms: row.payment_terms,
    notes: row.notes,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface CreateVendorInput {
  name: string;
  email: string | null;
  phone: string | null;
  billingAddress: string | null;
  taxNumber: string | null;
  paymentTerms: string | null;
  notes: string | null;
}

export interface UpdateVendorInput {
  name?: string | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  billingAddress?: string | null | undefined;
  taxNumber?: string | null | undefined;
  paymentTerms?: string | null | undefined;
  notes?: string | null | undefined;
  isActive?: boolean | undefined;
}

export interface ListVendorsOptions {
  q: string | null;
  includeInactive: boolean;
}

export async function listVendors(orgId: string, options: ListVendorsOptions): Promise<Vendor[]> {
  const clauses = ['org_id = $1'];
  const values: unknown[] = [orgId];

  if (!options.includeInactive) {
    clauses.push('is_active = true');
  }
  if (options.q !== null) {
    values.push(options.q);
    clauses.push(`name ILIKE '%' || $${String(values.length)} || '%'`);
  }

  const { rows } = await pool.query<VendorRow>(
    `SELECT ${VENDOR_COLUMNS} FROM vendors WHERE ${clauses.join(' AND ')} ORDER BY name ASC, id ASC`,
    values,
  );
  return rows.map(toVendor);
}

export async function getVendorById(orgId: string, id: string): Promise<Vendor> {
  const { rows } = await pool.query<VendorRow>(
    `SELECT ${VENDOR_COLUMNS} FROM vendors WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );

  const row = rows[0];
  // 404 rather than 403: a 403 would confirm the id exists in another tenant.
  if (row === undefined) throw new ApiError(404, 'Vendor not found');
  return toVendor(row);
}

export async function createVendor(
  orgId: string,
  createdBy: string,
  input: CreateVendorInput,
): Promise<Vendor> {
  const { rows } = await withTransaction((client) =>
    client.query<VendorRow>(
      `INSERT INTO vendors (org_id, created_by, name, email, phone, billing_address, tax_number, payment_terms, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${VENDOR_COLUMNS}`,
      [
        orgId,
        createdBy,
        input.name,
        input.email === null ? null : input.email.toLowerCase(),
        input.phone,
        input.billingAddress,
        input.taxNumber,
        input.paymentTerms,
        input.notes,
      ],
    ),
  );

  const row = rows[0];
  if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
  return toVendor(row);
}

export async function updateVendor(
  orgId: string,
  id: string,
  input: UpdateVendorInput,
): Promise<Vendor> {
  // Column names come from this frozen map, never from the request — rule 4
  // forbids interpolating an identifier a caller could influence.
  const COLUMNS = {
    name: 'name',
    email: 'email',
    phone: 'phone',
    billingAddress: 'billing_address',
    taxNumber: 'tax_number',
    paymentTerms: 'payment_terms',
    notes: 'notes',
    isActive: 'is_active',
  } as const;

  const assignments: string[] = [];
  const values: unknown[] = [id, orgId];

  for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
    const value = input[key];
    if (value === undefined) continue;
    const stored = key === 'email' && typeof value === 'string' ? value.toLowerCase() : value;
    values.push(stored);
    assignments.push(`${COLUMNS[key]} = $${String(values.length)}`);
  }

  if (assignments.length === 0) throw new ApiError(400, 'No fields to update');

  const { rows } = await withTransaction((client) =>
    client.query<VendorRow>(
      `UPDATE vendors SET ${assignments.join(', ')}
        WHERE id = $1 AND org_id = $2
        RETURNING ${VENDOR_COLUMNS}`,
      values,
    ),
  );

  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Vendor not found');
  return toVendor(row);
}

/**
 * Phase 19 — AP-Flow's captured-bill posting needs a vendor id from an
 * extracted name, with no reviewer in the loop to pick one. Returns the id
 * of this org's active vendor whose name normalizes equal to `name`,
 * creating one if none exists.
 *
 * `vendors.name` has no UNIQUE constraint (unlike `ap_flow_vendor_account_map
 * .vendor_key`), so two concurrent captures for a brand-new vendor name
 * could otherwise both pass the SELECT and both INSERT. A transaction-scoped
 * advisory lock keyed on (org, normalized name) serializes exactly that
 * race — `pg_advisory_xact_lock` blocks a second caller with the same key
 * until this transaction commits or rolls back, and releases automatically
 * either way.
 */
export async function findOrCreateVendorByNameOnClient(
  client: PoolClient,
  orgId: string,
  createdBy: string,
  name: string,
): Promise<string> {
  const trimmed = name.trim();
  if (trimmed === '') throw new ApiError(422, 'A vendor name is required');
  const normalized = normalizeForMatching(trimmed);

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1 || \':\' || $2))', [orgId, normalized]);

  const { rows } = await client.query<{ id: string; name: string }>(
    'SELECT id, name FROM vendors WHERE org_id = $1 AND is_active = true ORDER BY created_at ASC, id ASC',
    [orgId],
  );
  const existing = rows.find((row) => normalizeForMatching(row.name) === normalized);
  if (existing !== undefined) return existing.id;

  const { rows: inserted } = await client.query<{ id: string }>(
    `INSERT INTO vendors (org_id, created_by, name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [orgId, createdBy, trimmed.slice(0, 200)],
  );
  const id = inserted[0]?.id;
  if (id === undefined) throw new Error('INSERT ... RETURNING produced no row');
  return id;
}
