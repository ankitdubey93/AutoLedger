import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import type { Customer } from '../../types/ledger-core.js';

/**
 * LedgerCore customers — the parties sales invoices are issued to.
 *
 * Every function takes `orgId` first and every statement carries an `org_id`
 * predicate (guardrails rule 1). That `orgId` always originates from the
 * verified access token, never from a param, header or body.
 *
 * There is no delete route: a customer is retired with `isActive: false`,
 * matching `accounts` — once an invoice can reference one, deleting the row
 * out from under a posted document is not an option.
 */

interface CustomerRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billing_address: string | null;
  tax_number: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const CUSTOMER_COLUMNS = `id, name, email, phone, billing_address, tax_number, notes,
                           is_active, created_at, updated_at`;

function toCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    billingAddress: row.billing_address,
    taxNumber: row.tax_number,
    notes: row.notes,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface CreateCustomerInput {
  name: string;
  email: string | null;
  phone: string | null;
  billingAddress: string | null;
  taxNumber: string | null;
  notes: string | null;
}

export interface UpdateCustomerInput {
  name?: string | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  billingAddress?: string | null | undefined;
  taxNumber?: string | null | undefined;
  notes?: string | null | undefined;
  isActive?: boolean | undefined;
}

export async function listCustomers(
  orgId: string,
  options: { q: string | null; includeInactive: boolean },
): Promise<Customer[]> {
  const clauses = ['org_id = $1'];
  const values: unknown[] = [orgId];

  if (!options.includeInactive) {
    clauses.push('is_active = true');
  }
  if (options.q !== null) {
    values.push(options.q);
    clauses.push(`name ILIKE '%' || $${String(values.length)} || '%'`);
  }

  const { rows } = await pool.query<CustomerRow>(
    `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE ${clauses.join(' AND ')} ORDER BY name ASC, id ASC`,
    values,
  );
  return rows.map(toCustomer);
}

export async function getCustomerById(orgId: string, id: string): Promise<Customer> {
  const { rows } = await pool.query<CustomerRow>(
    `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );

  const row = rows[0];
  // 404 rather than 403: a 403 would confirm the id exists in another tenant.
  if (row === undefined) throw new ApiError(404, 'Customer not found');
  return toCustomer(row);
}

export async function createCustomer(
  orgId: string,
  createdBy: string,
  input: CreateCustomerInput,
): Promise<Customer> {
  const { rows } = await pool.query<CustomerRow>(
    `INSERT INTO customers (org_id, created_by, name, email, phone, billing_address, tax_number, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${CUSTOMER_COLUMNS}`,
    [
      orgId,
      createdBy,
      input.name,
      input.email === null ? null : input.email.toLowerCase(),
      input.phone,
      input.billingAddress,
      input.taxNumber,
      input.notes,
    ],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
  return toCustomer(row);
}

export async function updateCustomer(
  orgId: string,
  id: string,
  input: UpdateCustomerInput,
): Promise<Customer> {
  // Column names come from this frozen map, never from the request — rule 4
  // forbids interpolating an identifier a caller could influence.
  const COLUMNS = {
    name: 'name',
    email: 'email',
    phone: 'phone',
    billingAddress: 'billing_address',
    taxNumber: 'tax_number',
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

  const { rows } = await pool.query<CustomerRow>(
    `UPDATE customers SET ${assignments.join(', ')}
      WHERE id = $1 AND org_id = $2
      RETURNING ${CUSTOMER_COLUMNS}`,
    values,
  );

  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Customer not found');
  return toCustomer(row);
}
