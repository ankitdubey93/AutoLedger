import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the service — every test here drives
 * raw SQL straight at the pool to prove migration 031's constraints and
 * triggers hold regardless of what wrote the row. AP-Flow's immutability is
 * deliberately narrower than a posted financial document's (guardrails
 * rule 6): these are pre-posting drafts, and DELETE stays legal so
 * re-extraction can replace them wholesale.
 */

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const FEATURE_NOT_SUPPORTED = '0A000';

async function errorCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      return typeof err.code === 'string' ? err.code : undefined;
    }
  }
  return undefined;
}

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

/** Registers a vault document and an ap_flow_documents row for orgA, raw SQL. */
async function seedApFlowDocument(): Promise<{ apFlowDocId: string; vaultDocId: string }> {
  const { rows: docRows } = await pool.query<{ id: string }>(
    `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
     VALUES ($1, $2, 10, 'application/pdf', 'invoice.pdf', $3)
     RETURNING id`,
    [orgA, 'a'.repeat(64), userA.id],
  );
  const vaultDocId = docRows[0]?.id;
  if (vaultDocId === undefined) throw new Error('fixture: no vault document id');

  const { rows: apFlowRows } = await pool.query<{ id: string }>(
    `INSERT INTO ap_flow_documents (org_id, document_id, created_by)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [orgA, vaultDocId, userA.id],
  );
  const apFlowDocId = apFlowRows[0]?.id;
  if (apFlowDocId === undefined) throw new Error('fixture: no ap_flow_documents id');

  return { apFlowDocId, vaultDocId };
}

describe('ap-flow database constraints', () => {
  beforeEach(async () => {
    await resetTables();
    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;
    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    orgB = userB.orgId;
  });

  // closePool() runs once, in the last describe block in this file — see
  // the phase 11 describe below. Calling it here too would close the pool
  // after this block's tests finish and break every test after it.

  it('rejects an in-place UPDATE on ap_flow_extractions with 0A000', async () => {
    const { apFlowDocId } = await seedApFlowDocument();
    await pool.query(
      `INSERT INTO ap_flow_extractions (org_id, ap_flow_document_id, arithmetic_ok, model)
       VALUES ($1, $2, true, 'claude-sonnet-5')`,
      [orgA, apFlowDocId],
    );

    const code = await errorCode(() =>
      pool.query('UPDATE ap_flow_extractions SET vendor_name = $1 WHERE org_id = $2', ['x', orgA]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('rejects an in-place UPDATE on ap_flow_pages with 0A000', async () => {
    const { apFlowDocId } = await seedApFlowDocument();
    await pool.query(
      `INSERT INTO ap_flow_pages (org_id, ap_flow_document_id, page_number, width_px, height_px, redacted_sha256, ocr_text)
       VALUES ($1, $2, 1, 100, 100, $3, 'text')`,
      [orgA, apFlowDocId, 'b'.repeat(64)],
    );

    const code = await errorCode(() =>
      pool.query('UPDATE ap_flow_pages SET ocr_text = $1 WHERE org_id = $2', ['x', orgA]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('allows DELETE on ap_flow_extractions — re-extraction depends on it', async () => {
    const { apFlowDocId } = await seedApFlowDocument();
    await pool.query(
      `INSERT INTO ap_flow_extractions (org_id, ap_flow_document_id, arithmetic_ok, model)
       VALUES ($1, $2, true, 'claude-sonnet-5')`,
      [orgA, apFlowDocId],
    );

    const code = await errorCode(() =>
      pool.query('DELETE FROM ap_flow_extractions WHERE org_id = $1 AND ap_flow_document_id = $2', [
        orgA,
        apFlowDocId,
      ]),
    );
    expect(code).toBeUndefined();

    const { rows } = await pool.query('SELECT id FROM ap_flow_extractions WHERE org_id = $1', [orgA]);
    expect(rows).toHaveLength(0);
  });

  it('rejects a cross-tenant ap_flow_documents insert with 23503', async () => {
    const { rows: docRows } = await pool.query<{ id: string }>(
      `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
       VALUES ($1, $2, 10, 'application/pdf', 'invoice.pdf', $3)
       RETURNING id`,
      [orgA, 'c'.repeat(64), userA.id],
    );
    const vaultDocId = docRows[0]?.id;
    if (vaultDocId === undefined) throw new Error('fixture: no vault document id');

    // vaultDocId belongs to orgA; inserting under orgB must fail the
    // composite FK (org_id, document_id) -> documents (org_id, id).
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_documents (org_id, document_id, created_by) VALUES ($1, $2, $3)`,
        [orgB, vaultDocId, userB.id],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('rejects an unknown status with 23514', async () => {
    const { rows: docRows } = await pool.query<{ id: string }>(
      `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
       VALUES ($1, $2, 10, 'application/pdf', 'invoice.pdf', $3)
       RETURNING id`,
      [orgA, 'd'.repeat(64), userA.id],
    );
    const vaultDocId = docRows[0]?.id;
    if (vaultDocId === undefined) throw new Error('fixture: no vault document id');

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_documents (org_id, document_id, created_by, status) VALUES ($1, $2, $3, 'REVIEWED')`,
        [orgA, vaultDocId, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects a duplicate (org_id, ap_flow_document_id, page_number) with 23505', async () => {
    const { apFlowDocId } = await seedApFlowDocument();
    await pool.query(
      `INSERT INTO ap_flow_pages (org_id, ap_flow_document_id, page_number, width_px, height_px, redacted_sha256, ocr_text)
       VALUES ($1, $2, 1, 100, 100, $3, 'text')`,
      [orgA, apFlowDocId, 'e'.repeat(64)],
    );

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_pages (org_id, ap_flow_document_id, page_number, width_px, height_px, redacted_sha256, ocr_text)
         VALUES ($1, $2, 1, 200, 200, $3, 'text2')`,
        [orgA, apFlowDocId, 'f'.repeat(64)],
      ),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('UPDATE ap_flow_documents.status succeeds and bumps updated_at', async () => {
    const { apFlowDocId } = await seedApFlowDocument();
    const { rows: before } = await pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM ap_flow_documents WHERE org_id = $1 AND id = $2',
      [orgA, apFlowDocId],
    );

    // A short delay so updated_at, if bumped, differs measurably from the
    // insert-time value even on a fast clock.
    await new Promise((resolve) => setTimeout(resolve, 10));

    await pool.query(
      `UPDATE ap_flow_documents SET status = 'PROCESSING' WHERE org_id = $1 AND id = $2`,
      [orgA, apFlowDocId],
    );

    const { rows: after } = await pool.query<{ status: string; updated_at: Date }>(
      'SELECT status, updated_at FROM ap_flow_documents WHERE org_id = $1 AND id = $2',
      [orgA, apFlowDocId],
    );
    expect(after[0]?.status).toBe('PROCESSING');
    expect(after[0]?.updated_at.getTime()).toBeGreaterThan(before[0]?.updated_at.getTime() ?? 0);
  });
});

/**
 * Phase 11 — migration 032's constraints and triggers, proven the same way:
 * raw SQL straight at the pool, never through a service. ap_flow_line_items
 * is deliberately mutable while its parent document is not yet POSTED
 * (unlike ap_flow_pages/ap_flow_extractions, which are never editable) — the
 * posted-guard triggers are what freeze it, not an absence of UPDATE
 * privilege.
 */
describe('ap-flow phase 11 database constraints', () => {
  beforeEach(async () => {
    await resetTables();
    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;
    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    orgB = userB.orgId;
  });

  afterAll(closePool);

  /** Fetches an org's seeded default-chart account id by code (accounts is seeded at register). */
  async function accountIdByCode(orgId: string, code: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
      [orgId, code],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`fixture: no account ${code} for org ${orgId}`);
    return id;
  }

  it('rejects a line item whose org_id does not match its document', async () => {
    const { apFlowDocId } = await seedApFlowDocument();
    const accountId = await accountIdByCode(orgA, '6130');

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents, account_id)
         VALUES ($1, $2, 0, 'Office supplies', 1000, $3)`,
        [orgB, apFlowDocId, accountId],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('rejects two line items sharing a line_index on one document', async () => {
    const { apFlowDocId } = await seedApFlowDocument();
    await pool.query(
      `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents)
       VALUES ($1, $2, 0, 'Line one', 1000)`,
      [orgA, apFlowDocId],
    );

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents)
         VALUES ($1, $2, 0, 'Line one again', 2000)`,
        [orgA, apFlowDocId],
      ),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('rejects an unknown mapping_source', async () => {
    const { apFlowDocId } = await seedApFlowDocument();

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents, mapping_source)
         VALUES ($1, $2, 0, 'Line one', 1000, 'GUESS')`,
        [orgA, apFlowDocId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects a mapping_confidence above 1', async () => {
    const { apFlowDocId } = await seedApFlowDocument();

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents, mapping_confidence)
         VALUES ($1, $2, 0, 'Line one', 1000, 1.500)`,
        [orgA, apFlowDocId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects marking a document POSTED without a journal entry id', async () => {
    const { apFlowDocId } = await seedApFlowDocument();

    const code = await errorCode(() =>
      pool.query(`UPDATE ap_flow_documents SET status = 'POSTED' WHERE org_id = $1 AND id = $2`, [
        orgA,
        apFlowDocId,
      ]),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  /** Marks a document POSTED via raw SQL, satisfying chk_ap_flow_documents_posted_complete. */
  async function markPosted(apFlowDocId: string): Promise<void> {
    await pool.query(
      `UPDATE ap_flow_documents
          SET status = 'POSTED', journal_entry_id = $3, posted_sha256 = $4, posted_at = now(), posted_by = $5
        WHERE org_id = $1 AND id = $2`,
      [orgA, apFlowDocId, randomUUID(), 'a'.repeat(64), userA.id],
    );
  }

  it('rejects any UPDATE of a POSTED document', async () => {
    const { apFlowDocId } = await seedApFlowDocument();
    await markPosted(apFlowDocId);

    const code = await errorCode(() =>
      pool.query(`UPDATE ap_flow_documents SET failure_reason = $1 WHERE org_id = $2 AND id = $3`, [
        'x',
        orgA,
        apFlowDocId,
      ]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it("rejects an UPDATE of a POSTED document's line item", async () => {
    const { apFlowDocId } = await seedApFlowDocument();
    const accountId = await accountIdByCode(orgA, '6130');
    await pool.query(
      `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents, account_id)
       VALUES ($1, $2, 0, 'Office supplies', 1000, $3)`,
      [orgA, apFlowDocId, accountId],
    );
    await markPosted(apFlowDocId);

    const otherAccountId = await accountIdByCode(orgA, '6140');
    const code = await errorCode(() =>
      pool.query(
        `UPDATE ap_flow_line_items SET account_id = $1 WHERE org_id = $2 AND ap_flow_document_id = $3`,
        [otherAccountId, orgA, apFlowDocId],
      ),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('allows updating a line item while the document is EXTRACTED', async () => {
    const { apFlowDocId } = await seedApFlowDocument();
    const accountId = await accountIdByCode(orgA, '6130');
    await pool.query(
      `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents, account_id)
       VALUES ($1, $2, 0, 'Office supplies', 1000, $3)`,
      [orgA, apFlowDocId, accountId],
    );
    await pool.query(`UPDATE ap_flow_documents SET status = 'EXTRACTED' WHERE org_id = $1 AND id = $2`, [
      orgA,
      apFlowDocId,
    ]);

    const otherAccountId = await accountIdByCode(orgA, '6140');
    const result = await pool.query(
      `UPDATE ap_flow_line_items SET account_id = $1 WHERE org_id = $2 AND ap_flow_document_id = $3`,
      [otherAccountId, orgA, apFlowDocId],
    );
    expect(result.rowCount).toBe(1);
  });

  it("cascades line items when its AP-Flow document is deleted", async () => {
    const { apFlowDocId } = await seedApFlowDocument();
    await pool.query(
      `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents)
       VALUES ($1, $2, 0, 'Line one', 1000)`,
      [orgA, apFlowDocId],
    );

    await pool.query('DELETE FROM ap_flow_documents WHERE org_id = $1 AND id = $2', [orgA, apFlowDocId]);

    const { rows } = await pool.query('SELECT id FROM ap_flow_line_items WHERE org_id = $1', [orgA]);
    expect(rows).toHaveLength(0);
  });

  it('rejects two vendor map rows sharing a vendor_key in one org', async () => {
    const accountId = await accountIdByCode(orgA, '6120');
    await pool.query(
      `INSERT INTO ap_flow_vendor_account_map (org_id, vendor_key, account_id) VALUES ($1, $2, $3)`,
      [orgA, 'aws cloud services', accountId],
    );

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_vendor_account_map (org_id, vendor_key, account_id) VALUES ($1, $2, $3)`,
        [orgA, 'aws cloud services', accountId],
      ),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('allows the same vendor_key in two different organizations', async () => {
    const accountIdA = await accountIdByCode(orgA, '6120');
    const accountIdB = await accountIdByCode(orgB, '6120');

    const codeA = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_vendor_account_map (org_id, vendor_key, account_id) VALUES ($1, $2, $3)`,
        [orgA, 'aws cloud services', accountIdA],
      ),
    );
    const codeB = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_vendor_account_map (org_id, vendor_key, account_id) VALUES ($1, $2, $3)`,
        [orgB, 'aws cloud services', accountIdB],
      ),
    );
    expect(codeA).toBeUndefined();
    expect(codeB).toBeUndefined();
  });

  it('the database refuses a second POSTED transition even with the service bypassed', async () => {
    const { apFlowDocId } = await seedApFlowDocument();
    await markPosted(apFlowDocId);

    const code = await errorCode(() =>
      pool.query(
        `UPDATE ap_flow_documents
            SET status = 'POSTED', journal_entry_id = $3, posted_sha256 = $4, posted_at = now(), posted_by = $5
          WHERE org_id = $1 AND id = $2`,
        [orgA, apFlowDocId, randomUUID(), 'b'.repeat(64), userA.id],
      ),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });
});
