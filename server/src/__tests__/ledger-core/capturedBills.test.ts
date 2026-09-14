import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { beginTransaction } from '../../db/transaction.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { createCapturedBillOnClient, approveBillOnClient } from '../../services/ledger-core/billService.js';
import { findOrCreateVendorByNameOnClient, createVendor } from '../../services/ledger-core/vendorService.js';

/**
 * Phase 19's LedgerCore additions AP-Flow's postingService.ts calls on its
 * own transaction: `createCapturedBillOnClient`, `approveBillOnClient`, and
 * `findOrCreateVendorByNameOnClient`. Real PostgreSQL, each test opening its
 * own client transaction and rolling it back in `afterAll`/inline as needed
 * — these are `*OnClient` functions and take no BEGIN/COMMIT of their own.
 */

let userA: SeededUser;
let orgA: string;
let userB: SeededUser;
let orgB: string;

async function accountIdByCode(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`fixture: no account ${code} for org ${orgId}`);
  return id;
}

describe('LedgerCore captured-bill posting (Phase 19)', () => {
  beforeEach(async () => {
    await resetTables();
    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;
    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    orgB = userB.orgId;
  });

  afterAll(closePool);

  it('createCapturedBillOnClient stores explicit per-line net and tax', async () => {
    const vendor = await createVendor(orgA, userA.id, {
      name: 'Fixture Vendor',
      email: null,
      phone: null,
      billingAddress: null,
      taxNumber: null,
      paymentTerms: null,
      notes: null,
    });
    const account = await accountIdByCode(orgA, '6130');

    const client = await pool.connect();
    try {
      await beginTransaction(client);
      const billId = await createCapturedBillOnClient(client, orgA, userA.id, {
        vendorId: vendor.id,
        vendorReference: 'CAP-1',
        billDate: '2026-08-15',
        dueDate: '2026-09-14',
        currencyCode: 'USD',
        notes: null,
        lines: [
          { description: 'Line one', netCents: 500, taxCents: 40, expenseAccountId: account },
          { description: 'Line two', netCents: 700, taxCents: 56, expenseAccountId: account },
        ],
      });
      await client.query('COMMIT');

      const { rows: billRows } = await pool.query<{
        subtotal_cents: string;
        tax_cents: string;
        total_cents: string;
      }>('SELECT subtotal_cents, tax_cents, total_cents FROM bills WHERE org_id = $1 AND id = $2', [orgA, billId]);
      expect(billRows[0]?.subtotal_cents).toBe('1200');
      expect(billRows[0]?.tax_cents).toBe('96');
      expect(billRows[0]?.total_cents).toBe('1296');

      const { rows: lineRows } = await pool.query<{ net_cents: string; tax_cents: string }>(
        'SELECT net_cents, tax_cents FROM bill_lines WHERE org_id = $1 AND bill_id = $2 ORDER BY line_number',
        [orgA, billId],
      );
      expect(lineRows).toEqual([
        { net_cents: '500', tax_cents: '40' },
        { net_cents: '700', tax_cents: '56' },
      ]);
    } finally {
      client.release();
    }
  });

  it('a ROLLBACK after approveBillOnClient leaves no bill and no journal entry', async () => {
    const vendor = await createVendor(orgA, userA.id, {
      name: 'Rollback Vendor',
      email: null,
      phone: null,
      billingAddress: null,
      taxNumber: null,
      paymentTerms: null,
      notes: null,
    });
    const account = await accountIdByCode(orgA, '6130');

    const client = await pool.connect();
    try {
      await beginTransaction(client);
      const billId = await createCapturedBillOnClient(client, orgA, userA.id, {
        vendorId: vendor.id,
        vendorReference: 'ROLLBACK-1',
        billDate: '2026-08-15',
        dueDate: '2026-09-14',
        currencyCode: 'USD',
        notes: null,
        lines: [{ description: 'Line one', netCents: 1000, taxCents: 0, expenseAccountId: account }],
      });
      await approveBillOnClient(client, orgA, userA.id, billId, null);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const { rows: billRows } = await pool.query('SELECT id FROM bills WHERE org_id = $1', [orgA]);
    expect(billRows).toHaveLength(0);
    const { rows: entryRows } = await pool.query('SELECT id FROM journal_entries WHERE org_id = $1', [orgA]);
    expect(entryRows).toHaveLength(0);
  });

  it('findOrCreateVendorByNameOnClient never matches another organization\'s vendor', async () => {
    await createVendor(orgB, userB.id, {
      name: 'Globex',
      email: null,
      phone: null,
      billingAddress: null,
      taxNumber: null,
      paymentTerms: null,
      notes: null,
    });

    const client = await pool.connect();
    let vendorId: string;
    try {
      await beginTransaction(client);
      vendorId = await findOrCreateVendorByNameOnClient(client, orgA, userA.id, 'globex');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const { rows: orgAVendors } = await pool.query('SELECT id FROM vendors WHERE org_id = $1', [orgA]);
    expect(orgAVendors).toHaveLength(1);
    expect(orgAVendors[0]?.id).toBe(vendorId);

    const { rows: orgBVendors } = await pool.query<{ name: string }>('SELECT name FROM vendors WHERE org_id = $1', [
      orgB,
    ]);
    expect(orgBVendors).toHaveLength(1);
    expect(orgBVendors[0]?.name).toBe('Globex');
  });

  it('findOrCreateVendorByNameOnClient ignores inactive vendors', async () => {
    const inactive = await createVendor(orgA, userA.id, {
      name: 'Initech',
      email: null,
      phone: null,
      billingAddress: null,
      taxNumber: null,
      paymentTerms: null,
      notes: null,
    });
    await pool.query('UPDATE vendors SET is_active = false WHERE org_id = $1 AND id = $2', [orgA, inactive.id]);

    const client = await pool.connect();
    let vendorId: string;
    try {
      await beginTransaction(client);
      vendorId = await findOrCreateVendorByNameOnClient(client, orgA, userA.id, 'Initech');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    expect(vendorId).not.toBe(inactive.id);
    const { rows } = await pool.query('SELECT id FROM vendors WHERE org_id = $1', [orgA]);
    expect(rows).toHaveLength(2);
  });
});
