import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { canTransitionQuote, QUOTE_STATUSES, type QuoteStatus } from '../../types/accounting.js';

/**
 * Phase 41 — what migration 089 enforces in the database itself, written as
 * raw SQL so no service check can mask a missing constraint: the party XOR,
 * the frozen sent quote, insert-only evidence, convert-once, the direction
 * of a back-link, tenant-local FKs — and that the trigger's transition list
 * matches QUOTE_TRANSITIONS exactly (rule 10), pair by pair.
 */

let userA: SeededUser;
let userB: SeededUser;

const HASH = 'a'.repeat(64);

async function customerIn(orgId: string, name = 'Acme'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO customers (org_id, name) VALUES ($1, $2) RETURNING id',
    [orgId, name],
  );
  return rows[0]!.id;
}

async function vendorIn(orgId: string, name = 'Supplier'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO vendors (org_id, name) VALUES ($1, $2) RETURNING id',
    [orgId, name],
  );
  return rows[0]!.id;
}

async function accountIn(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  return rows[0]!.id;
}

/**
 * Inserts a quote directly in `status`, with every column any status's
 * completeness CHECK could need — INSERT is not guarded by the trigger, so
 * this is how a test starts from any state.
 */
async function rawQuote(
  orgId: string,
  createdBy: string,
  status: QuoteStatus,
  party: { customerId?: string; vendorId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const customerId = party.customerId ?? (party.vendorId === undefined ? await customerIn(orgId) : null);
  const direction = customerId === null ? 'PURCHASE' : 'SALES';
  await pool.query(
    `INSERT INTO quotes
       (id, org_id, direction, customer_id, vendor_id, root_quote_id, revision, status, quote_number,
        quote_date, valid_until, currency_code, party_name_snapshot, subtotal_cents, tax_cents, total_cents,
        content_sha256, sent_at, sent_by, accepted_at, declined_at, expired_at, voided_at, void_reason,
        superseded_at, converted_at, converted_by, created_by)
     VALUES ($1, $2, $3, $4, $5, $1, 1, $6, $9,
             '2026-10-01', '2026-10-31', 'INR', 'Acme', 100, 0, 100,
             $7, now(), $8, now(), now(), now(), now(), 'reason',
             now(), now(), $8, $8)`,
    [id, orgId, direction, customerId, party.vendorId ?? null, status, HASH, createdBy, `QU-${id.slice(0, 8)}`],
  );
  return id;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
});

afterAll(closePool);

describe('quotes — schema constraints', () => {
  it('a sales quote names a customer and no vendor; a purchase quote the reverse', async () => {
    const customerId = await customerIn(userA.orgId);
    const vendorId = await vendorIn(userA.orgId);
    await expect(
      pool.query(
        `INSERT INTO quotes (org_id, direction, customer_id, vendor_id, root_quote_id, quote_date, valid_until,
                             currency_code, party_name_snapshot, created_by)
         VALUES ($1, 'SALES', $2, $3, gen_random_uuid(), '2026-10-01', '2026-10-31', 'INR', 'x', $4)`,
        [userA.orgId, customerId, vendorId, userA.id],
      ),
    ).rejects.toMatchObject({ constraint: 'ck_quotes_party' });
    await expect(
      pool.query(
        `INSERT INTO quotes (org_id, direction, customer_id, root_quote_id, quote_date, valid_until,
                             currency_code, party_name_snapshot, created_by)
         VALUES ($1, 'PURCHASE', $2, gen_random_uuid(), '2026-10-01', '2026-10-31', 'INR', 'x', $3)`,
        [userA.orgId, customerId, userA.id],
      ),
    ).rejects.toMatchObject({ constraint: 'ck_quotes_party' });
  });

  it('a sent quote must carry its number, send time and content hash', async () => {
    const customerId = await customerIn(userA.orgId);
    await expect(
      pool.query(
        `INSERT INTO quotes (id, org_id, direction, customer_id, root_quote_id, status, quote_date, valid_until,
                             currency_code, party_name_snapshot, created_by)
         VALUES ($1, $2, 'SALES', $3, $1, 'SENT', '2026-10-01', '2026-10-31', 'INR', 'x', $4)`,
        [randomUUID(), userA.orgId, customerId, userA.id],
      ),
    ).rejects.toMatchObject({ constraint: 'ck_quotes_sent_complete' });
  });

  it('total must equal subtotal + tax, and validity cannot precede the quote date', async () => {
    const customerId = await customerIn(userA.orgId);
    await expect(
      pool.query(
        `INSERT INTO quotes (id, org_id, direction, customer_id, root_quote_id, quote_date, valid_until,
                             currency_code, party_name_snapshot, subtotal_cents, tax_cents, total_cents, created_by)
         VALUES ($1, $2, 'SALES', $3, $1, '2026-10-01', '2026-10-31', 'INR', 'x', 100, 10, 999, $4)`,
        [randomUUID(), userA.orgId, customerId, userA.id],
      ),
    ).rejects.toMatchObject({ constraint: 'chk_quotes_total' });
    await expect(
      pool.query(
        `INSERT INTO quotes (id, org_id, direction, customer_id, root_quote_id, quote_date, valid_until,
                             currency_code, party_name_snapshot, created_by)
         VALUES ($1, $2, 'SALES', $3, $1, '2026-10-10', '2026-10-01', 'INR', 'x', $4)`,
        [randomUUID(), userA.orgId, customerId, userA.id],
      ),
    ).rejects.toMatchObject({ constraint: 'ck_quotes_validity' });
  });

  it("refuses another organization's customer (composite FK)", async () => {
    const foreignCustomer = await customerIn(userB.orgId);
    await expect(
      pool.query(
        `INSERT INTO quotes (id, org_id, direction, customer_id, root_quote_id, quote_date, valid_until,
                             currency_code, party_name_snapshot, created_by)
         VALUES ($1, $2, 'SALES', $3, $1, '2026-10-01', '2026-10-31', 'INR', 'x', $4)`,
        [randomUUID(), userA.orgId, foreignCustomer, userA.id],
      ),
    ).rejects.toMatchObject({ constraint: 'fk_quotes_customer' });
  });
});

describe('quotes — immutability trigger', () => {
  it('a sent quote cannot have its money, party snapshot or terms changed', async () => {
    const id = await rawQuote(userA.orgId, userA.id, 'SENT');
    for (const set of ["total_cents = 5, subtotal_cents = 5", "party_name_snapshot = 'Other'", "terms = 'new terms'"]) {
      await expect(pool.query(`UPDATE quotes SET ${set} WHERE id = $1`, [id])).rejects.toMatchObject({ code: '0A000' });
    }
  });

  it('a sent quote cannot be deleted; a draft can', async () => {
    const sent = await rawQuote(userA.orgId, userA.id, 'SENT');
    await expect(pool.query('DELETE FROM quotes WHERE id = $1', [sent])).rejects.toMatchObject({ code: '0A000' });
    const draft = await rawQuote(userA.orgId, userA.id, 'DRAFT');
    await pool.query('DELETE FROM quotes WHERE id = $1', [draft]);
  });

  it("a sent quote's lines cannot be added, changed or removed", async () => {
    const id = await rawQuote(userA.orgId, userA.id, 'SENT');
    const account = await accountIn(userA.orgId, '4100');
    await expect(
      pool.query(
        `INSERT INTO quote_lines (org_id, quote_id, line_number, description, quantity_milli, unit_price_cents,
                                  account_id, net_cents, tax_cents)
         VALUES ($1, $2, 1, 'x', 1000, 100, $3, 100, 0)`,
        [userA.orgId, id, account],
      ),
    ).rejects.toMatchObject({ code: '0A000' });
  });

  it('the trigger allows exactly the QUOTE_TRANSITIONS pairs (rule 10 parity)', async () => {
    const mismatches: string[] = [];
    for (const from of QUOTE_STATUSES) {
      for (const to of QUOTE_STATUSES) {
        if (from === to) continue;
        const id = await rawQuote(userA.orgId, userA.id, from);
        let allowed = true;
        try {
          await pool.query('UPDATE quotes SET status = $2 WHERE id = $1', [id, to]);
        } catch {
          allowed = false;
        }
        if (allowed !== canTransitionQuote(from, to)) mismatches.push(`${from}→${to} db=${String(allowed)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('quote_responses — insert-only evidence', () => {
  async function response(orgId: string, quoteId: string, recordedBy: string, kind = 'ACCEPTED') {
    return pool.query(
      `INSERT INTO quote_responses (org_id, quote_id, response, channel, signer_name, terms_accepted,
                                    recorded_by, quote_content_sha256)
       VALUES ($1, $2, $3, 'INTERNAL', 'Jane Doe', true, $4, $5) RETURNING id`,
      [orgId, quoteId, kind, recordedBy, HASH],
    );
  }

  it('cannot be updated or deleted', async () => {
    const quoteId = await rawQuote(userA.orgId, userA.id, 'SENT');
    const { rows } = await response(userA.orgId, quoteId, userA.id);
    const id = rows[0]!.id as string;
    await expect(pool.query("UPDATE quote_responses SET signer_name = 'Mallory' WHERE id = $1", [id])).rejects.toMatchObject({
      code: '0A000',
    });
    await expect(pool.query('DELETE FROM quote_responses WHERE id = $1', [id])).rejects.toMatchObject({ code: '0A000' });
  });

  it('a quote has at most one response — the race arbiter', async () => {
    const quoteId = await rawQuote(userA.orgId, userA.id, 'SENT');
    await response(userA.orgId, quoteId, userA.id, 'ACCEPTED');
    await expect(response(userA.orgId, quoteId, userA.id, 'DECLINED')).rejects.toMatchObject({
      constraint: 'ux_quote_responses_quote',
    });
  });

  it('an acceptance needs a signer name and accepted terms', async () => {
    const quoteId = await rawQuote(userA.orgId, userA.id, 'SENT');
    await expect(
      pool.query(
        `INSERT INTO quote_responses (org_id, quote_id, response, channel, signer_name, terms_accepted,
                                      recorded_by, quote_content_sha256)
         VALUES ($1, $2, 'ACCEPTED', 'INTERNAL', 'Jane', false, $3, $4)`,
        [userA.orgId, quoteId, userA.id, HASH],
      ),
    ).rejects.toMatchObject({ constraint: 'ck_quote_responses_accept' });
  });
});

describe('invoice / bill back-links', () => {
  async function invoiceFrom(orgId: string, customerId: string, quoteId: string, direction = 'SALES') {
    return pool.query(
      `INSERT INTO invoices (org_id, customer_id, issue_date, due_date, currency_code, customer_name_snapshot,
                             created_by, source_quote_id, source_quote_direction)
       VALUES ($1, $2, '2026-10-01', '2026-10-31', 'INR', 'Acme', $3, $4, $5)`,
      [orgId, customerId, userA.id, quoteId, direction],
    );
  }

  it('a quote converts to at most one invoice', async () => {
    const customerId = await customerIn(userA.orgId);
    const quoteId = await rawQuote(userA.orgId, userA.id, 'ACCEPTED', { customerId });
    await invoiceFrom(userA.orgId, customerId, quoteId);
    await expect(invoiceFrom(userA.orgId, customerId, quoteId)).rejects.toMatchObject({
      constraint: 'ux_invoices_source_quote',
    });
  });

  it('a purchase quote can never be the source of an invoice', async () => {
    const customerId = await customerIn(userA.orgId);
    const vendorId = await vendorIn(userA.orgId);
    const purchaseQuote = await rawQuote(userA.orgId, userA.id, 'ACCEPTED', { vendorId });
    // The CHECK pins an invoice's source direction to SALES …
    await expect(invoiceFrom(userA.orgId, customerId, purchaseQuote, 'PURCHASE')).rejects.toMatchObject({
      constraint: 'ck_invoices_source_quote',
    });
    // … and the composite FK refuses a SALES claim about a PURCHASE quote.
    await expect(invoiceFrom(userA.orgId, customerId, purchaseQuote, 'SALES')).rejects.toMatchObject({
      constraint: 'fk_invoices_source_quote',
    });
  });

  it("an invoice cannot name another organization's quote", async () => {
    const customerA = await customerIn(userA.orgId);
    const foreignQuote = await rawQuote(userB.orgId, userB.id, 'ACCEPTED');
    await expect(invoiceFrom(userA.orgId, customerA, foreignQuote)).rejects.toMatchObject({
      constraint: 'fk_invoices_source_quote',
    });
  });
});
