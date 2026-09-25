import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the service — every test here drives
 * raw SQL straight at the pool to prove migration 031's constraints and
 * triggers hold regardless of what wrote the row. Capture's immutability is
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
async function seedCaptureDocument(): Promise<{ captureDocId: string; vaultDocId: string }> {
  const { rows: docRows } = await pool.query<{ id: string }>(
    `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
     VALUES ($1, $2, 10, 'application/pdf', 'invoice.pdf', $3)
     RETURNING id`,
    [orgA, 'a'.repeat(64), userA.id],
  );
  const vaultDocId = docRows[0]?.id;
  if (vaultDocId === undefined) throw new Error('fixture: no vault document id');

  const { rows: captureRows } = await pool.query<{ id: string }>(
    `INSERT INTO ap_flow_documents (org_id, document_id, created_by)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [orgA, vaultDocId, userA.id],
  );
  const captureDocId = captureRows[0]?.id;
  if (captureDocId === undefined) throw new Error('fixture: no ap_flow_documents id');

  return { captureDocId, vaultDocId };
}

describe('capture database constraints', () => {
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
    const { captureDocId } = await seedCaptureDocument();
    await pool.query(
      `INSERT INTO ap_flow_extractions (org_id, ap_flow_document_id, arithmetic_ok, model)
       VALUES ($1, $2, true, 'claude-sonnet-5')`,
      [orgA, captureDocId],
    );

    const code = await errorCode(() =>
      pool.query('UPDATE ap_flow_extractions SET vendor_name = $1 WHERE org_id = $2', ['x', orgA]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('rejects an in-place UPDATE on ap_flow_pages with 0A000', async () => {
    const { captureDocId } = await seedCaptureDocument();
    await pool.query(
      `INSERT INTO ap_flow_pages (org_id, ap_flow_document_id, page_number, width_px, height_px, redacted_sha256, ocr_text)
       VALUES ($1, $2, 1, 100, 100, $3, 'text')`,
      [orgA, captureDocId, 'b'.repeat(64)],
    );

    const code = await errorCode(() =>
      pool.query('UPDATE ap_flow_pages SET ocr_text = $1 WHERE org_id = $2', ['x', orgA]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('allows DELETE on ap_flow_extractions — re-extraction depends on it', async () => {
    const { captureDocId } = await seedCaptureDocument();
    await pool.query(
      `INSERT INTO ap_flow_extractions (org_id, ap_flow_document_id, arithmetic_ok, model)
       VALUES ($1, $2, true, 'claude-sonnet-5')`,
      [orgA, captureDocId],
    );

    const code = await errorCode(() =>
      pool.query('DELETE FROM ap_flow_extractions WHERE org_id = $1 AND ap_flow_document_id = $2', [
        orgA,
        captureDocId,
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
    const { captureDocId } = await seedCaptureDocument();
    await pool.query(
      `INSERT INTO ap_flow_pages (org_id, ap_flow_document_id, page_number, width_px, height_px, redacted_sha256, ocr_text)
       VALUES ($1, $2, 1, 100, 100, $3, 'text')`,
      [orgA, captureDocId, 'e'.repeat(64)],
    );

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_pages (org_id, ap_flow_document_id, page_number, width_px, height_px, redacted_sha256, ocr_text)
         VALUES ($1, $2, 1, 200, 200, $3, 'text2')`,
        [orgA, captureDocId, 'f'.repeat(64)],
      ),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('UPDATE ap_flow_documents.status succeeds and bumps updated_at', async () => {
    const { captureDocId } = await seedCaptureDocument();
    const { rows: before } = await pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM ap_flow_documents WHERE org_id = $1 AND id = $2',
      [orgA, captureDocId],
    );

    // A short delay so updated_at, if bumped, differs measurably from the
    // insert-time value even on a fast clock.
    await new Promise((resolve) => setTimeout(resolve, 10));

    await pool.query(
      `UPDATE ap_flow_documents SET status = 'PROCESSING' WHERE org_id = $1 AND id = $2`,
      [orgA, captureDocId],
    );

    const { rows: after } = await pool.query<{ status: string; updated_at: Date }>(
      'SELECT status, updated_at FROM ap_flow_documents WHERE org_id = $1 AND id = $2',
      [orgA, captureDocId],
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
describe('capture phase 11 database constraints', () => {
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
    const { captureDocId } = await seedCaptureDocument();
    const accountId = await accountIdByCode(orgA, '6130');

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents, account_id)
         VALUES ($1, $2, 0, 'Office supplies', 1000, $3)`,
        [orgB, captureDocId, accountId],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('rejects two line items sharing a line_index on one document', async () => {
    const { captureDocId } = await seedCaptureDocument();
    await pool.query(
      `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents)
       VALUES ($1, $2, 0, 'Line one', 1000)`,
      [orgA, captureDocId],
    );

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents)
         VALUES ($1, $2, 0, 'Line one again', 2000)`,
        [orgA, captureDocId],
      ),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('rejects an unknown mapping_source', async () => {
    const { captureDocId } = await seedCaptureDocument();

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents, mapping_source)
         VALUES ($1, $2, 0, 'Line one', 1000, 'GUESS')`,
        [orgA, captureDocId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects a mapping_confidence above 1', async () => {
    const { captureDocId } = await seedCaptureDocument();

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents, mapping_confidence)
         VALUES ($1, $2, 0, 'Line one', 1000, 1.500)`,
        [orgA, captureDocId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects marking a document POSTED without a journal entry id', async () => {
    const { captureDocId } = await seedCaptureDocument();

    const code = await errorCode(() =>
      pool.query(`UPDATE ap_flow_documents SET status = 'POSTED' WHERE org_id = $1 AND id = $2`, [
        orgA,
        captureDocId,
      ]),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  /** Marks a document POSTED via raw SQL, satisfying chk_ap_flow_documents_posted_complete. */
  async function markPosted(captureDocId: string): Promise<void> {
    await pool.query(
      `UPDATE ap_flow_documents
          SET status = 'POSTED', journal_entry_id = $3, posted_sha256 = $4, posted_at = now(), posted_by = $5
        WHERE org_id = $1 AND id = $2`,
      [orgA, captureDocId, randomUUID(), 'a'.repeat(64), userA.id],
    );
  }

  it('rejects any UPDATE of a POSTED document', async () => {
    const { captureDocId } = await seedCaptureDocument();
    await markPosted(captureDocId);

    const code = await errorCode(() =>
      pool.query(`UPDATE ap_flow_documents SET failure_reason = $1 WHERE org_id = $2 AND id = $3`, [
        'x',
        orgA,
        captureDocId,
      ]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it("rejects an UPDATE of a POSTED document's line item", async () => {
    const { captureDocId } = await seedCaptureDocument();
    const accountId = await accountIdByCode(orgA, '6130');
    await pool.query(
      `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents, account_id)
       VALUES ($1, $2, 0, 'Office supplies', 1000, $3)`,
      [orgA, captureDocId, accountId],
    );
    await markPosted(captureDocId);

    const otherAccountId = await accountIdByCode(orgA, '6140');
    const code = await errorCode(() =>
      pool.query(
        `UPDATE ap_flow_line_items SET account_id = $1 WHERE org_id = $2 AND ap_flow_document_id = $3`,
        [otherAccountId, orgA, captureDocId],
      ),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('allows updating a line item while the document is EXTRACTED', async () => {
    const { captureDocId } = await seedCaptureDocument();
    const accountId = await accountIdByCode(orgA, '6130');
    await pool.query(
      `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents, account_id)
       VALUES ($1, $2, 0, 'Office supplies', 1000, $3)`,
      [orgA, captureDocId, accountId],
    );
    await pool.query(`UPDATE ap_flow_documents SET status = 'EXTRACTED' WHERE org_id = $1 AND id = $2`, [
      orgA,
      captureDocId,
    ]);

    const otherAccountId = await accountIdByCode(orgA, '6140');
    const result = await pool.query(
      `UPDATE ap_flow_line_items SET account_id = $1 WHERE org_id = $2 AND ap_flow_document_id = $3`,
      [otherAccountId, orgA, captureDocId],
    );
    expect(result.rowCount).toBe(1);
  });

  it("cascades line items when its Capture document is deleted", async () => {
    const { captureDocId } = await seedCaptureDocument();
    await pool.query(
      `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents)
       VALUES ($1, $2, 0, 'Line one', 1000)`,
      [orgA, captureDocId],
    );

    await pool.query('DELETE FROM ap_flow_documents WHERE org_id = $1 AND id = $2', [orgA, captureDocId]);

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
    const { captureDocId } = await seedCaptureDocument();
    await markPosted(captureDocId);

    const code = await errorCode(() =>
      pool.query(
        `UPDATE ap_flow_documents
            SET status = 'POSTED', journal_entry_id = $3, posted_sha256 = $4, posted_at = now(), posted_by = $5
          WHERE org_id = $1 AND id = $2`,
        [orgA, captureDocId, randomUUID(), 'b'.repeat(64), userA.id],
      ),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  // -------------------------------------------------- Phase 19 — auto-post

  it('ap_flow_settings rejects a threshold above 1', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_settings (org_id, auto_post_min_confidence) VALUES ($1, 1.5)`,
        [orgA],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('ap_flow_settings allows one row per organization', async () => {
    await pool.query('INSERT INTO ap_flow_settings (org_id) VALUES ($1)', [orgA]);
    const code = await errorCode(() => pool.query('INSERT INTO ap_flow_settings (org_id) VALUES ($1)', [orgA]));
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('auto_post_blockers must be a JSON array', async () => {
    const { captureDocId } = await seedCaptureDocument();
    await pool.query("UPDATE ap_flow_documents SET status = 'EXTRACTED' WHERE org_id = $1 AND id = $2", [
      orgA,
      captureDocId,
    ]);

    const code = await errorCode(() =>
      pool.query(`UPDATE ap_flow_documents SET auto_post_blockers = '{}' WHERE org_id = $1 AND id = $2`, [
        orgA,
        captureDocId,
      ]),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  // Drive intake's own constraint proofs moved to
  // __tests__/integrations/driveConstraints.test.ts in Phase 19.3 — the
  // integration is platform-level now, not Capture's.

  // ------------------------------------------------- duplicate capture

  // A DUPLICATE row is only ever created by captureDocumentService.captureFile,
  // which always supplies duplicate_of_id when it does — that invariant is a
  // service-layer guarantee, not a DB one (see migration 056). A DB-level
  // CHECK for the pairing was tried and dropped: fk_ap_flow_documents_
  // duplicate_of's ON DELETE SET NULL can null duplicate_of_id on a row that
  // is still DUPLICATE (its primary was deleted), and Postgres re-validates
  // every CHECK against the row a cascade produces — so the check and the FK
  // action were mutually incompatible for a state the database itself can
  // legitimately produce. This test documents the trade-off rather than
  // asserting a guarantee the schema no longer makes.
  it('the database does not itself forbid a DUPLICATE row with no duplicate_of_id (a service-layer invariant only)', async () => {
    const { vaultDocId } = await seedCaptureDocument();
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_documents (org_id, document_id, created_by, status)
         VALUES ($1, $2, $3, 'DUPLICATE')`,
        [orgA, vaultDocId, userA.id],
      ),
    );
    expect(code).toBeUndefined();
  });

  it('a non-DUPLICATE row may still carry duplicate_of_id, as history after being pushed through', async () => {
    const { captureDocId: primaryId, vaultDocId: primaryVaultId } = await seedCaptureDocument();
    const { rows: vaultRows } = await pool.query<{ id: string }>(
      `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
       VALUES ($1, $2, 10, 'application/pdf', 'invoice2.pdf', $3) RETURNING id`,
      [orgA, 'd'.repeat(64), userA.id],
    );
    const secondVaultId = vaultRows[0]?.id;
    expect(secondVaultId).not.toBe(primaryVaultId);

    // Born DUPLICATE, then confirmed legitimate — duplicate_of_id survives
    // the move to PENDING, exactly what requestReextraction relies on.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ap_flow_documents (org_id, document_id, created_by, status, duplicate_of_id)
       VALUES ($1, $2, $3, 'DUPLICATE', $4) RETURNING id`,
      [orgA, secondVaultId, userA.id, primaryId],
    );
    const dupId = rows[0]?.id;

    const code = await errorCode(() =>
      pool.query(`UPDATE ap_flow_documents SET status = 'PENDING' WHERE org_id = $1 AND id = $2`, [orgA, dupId]),
    );
    expect(code).toBeUndefined();
  });

  it("duplicate_of_id cannot reference another organization's document", async () => {
    const { captureDocId: captureDocIdB } = await (async () => {
      const { rows: vaultRows } = await pool.query<{ id: string }>(
        `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
         VALUES ($1, $2, 10, 'application/pdf', 'invoice.pdf', $3) RETURNING id`,
        [orgB, 'e'.repeat(64), userB.id],
      );
      const { rows: apRows } = await pool.query<{ id: string }>(
        `INSERT INTO ap_flow_documents (org_id, document_id, created_by) VALUES ($1, $2, $3) RETURNING id`,
        [orgB, vaultRows[0]?.id, userB.id],
      );
      return { captureDocId: apRows[0]?.id as string };
    })();

    const { rows: vaultRowsA } = await pool.query<{ id: string }>(
      `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
       VALUES ($1, $2, 10, 'application/pdf', 'invoice3.pdf', $3) RETURNING id`,
      [orgA, 'f'.repeat(64), userA.id],
    );

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO ap_flow_documents (org_id, document_id, created_by, status, duplicate_of_id)
         VALUES ($1, $2, $3, 'DUPLICATE', $4)`,
        [orgA, vaultRowsA[0]?.id, userA.id, captureDocIdB],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('deleting the primary document nulls only duplicate_of_id on the duplicate row', async () => {
    const { captureDocId: primaryId } = await seedCaptureDocument();
    const { rows: vaultRows } = await pool.query<{ id: string }>(
      `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
       VALUES ($1, $2, 10, 'application/pdf', 'invoice4.pdf', $3) RETURNING id`,
      [orgA, '1'.repeat(64), userA.id],
    );
    const { rows: dupRows } = await pool.query<{ id: string }>(
      `INSERT INTO ap_flow_documents (org_id, document_id, created_by, status, duplicate_of_id)
       VALUES ($1, $2, $3, 'DUPLICATE', $4) RETURNING id`,
      [orgA, vaultRows[0]?.id, userA.id, primaryId],
    );
    const dupId = dupRows[0]?.id;

    await pool.query('DELETE FROM ap_flow_documents WHERE org_id = $1 AND id = $2', [orgA, primaryId]);

    const { rows } = await pool.query<{ org_id: string; duplicate_of_id: string | null; status: string }>(
      'SELECT org_id, duplicate_of_id, status FROM ap_flow_documents WHERE id = $1',
      [dupId],
    );
    expect(rows[0]?.org_id).toBe(orgA);
    expect(rows[0]?.duplicate_of_id).toBeNull();
    // The row itself, and its DUPLICATE status, survive — only the
    // now-dangling pointer is cleared. (A stale-forever DUPLICATE with no
    // duplicateOfId is a known, accepted display gap: the client's "View
    // the earlier capture" link simply doesn't render without one.)
    expect(rows[0]?.status).toBe('DUPLICATE');
  });
});
