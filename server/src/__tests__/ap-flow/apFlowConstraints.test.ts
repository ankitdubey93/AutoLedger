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

  afterAll(closePool);

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
