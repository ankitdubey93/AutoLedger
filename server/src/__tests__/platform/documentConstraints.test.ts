import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the application.
 *
 * Every test here goes around `documentService`, straight at the pool —
 * proving that a raw SQL statement cannot mutate a document row, cannot
 * link across tenants, and cannot write a malformed sha256 or mime_type,
 * independently of whatever the service also checks. Mirrors
 * ledger-core/ledgerConstraints.test.ts.
 */

const FEATURE_NOT_SUPPORTED = '0A000';
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

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

const VALID_SHA = 'a'.repeat(64);

async function insertDocument(
  orgId: string,
  uploadedBy: string,
  sha256: string = VALID_SHA,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
     VALUES ($1, $2, 10, 'application/pdf', 'x.pdf', $3)
     RETURNING id`,
    [orgId, sha256, uploadedBy],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no document id');
  return row.id;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'raw-a', orgName: 'Raw SQL Alpha' });
  userB = await createUserWithOrg({ label: 'raw-b', orgName: 'Raw SQL Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
});

afterAll(closePool);

describe('document_links tenancy', () => {
  it("the composite FK rejects a link whose org_id differs from the document's", async () => {
    const documentId = await insertDocument(orgA, userA.id);

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO document_links (org_id, document_id, app_slug, entity_type, entity_id, created_by)
         VALUES ($1, $2, 'ledger-core', 'invoice', $3, $4)`,
        [orgB, documentId, randomUUID(), userB.id],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe('immutability', () => {
  it('UPDATE on documents raises 0A000', async () => {
    await insertDocument(orgA, userA.id);
    const code = await errorCode(() =>
      pool.query(`UPDATE documents SET original_filename = 'x' WHERE org_id = $1`, [orgA]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('UPDATE on document_links raises 0A000', async () => {
    const documentId = await insertDocument(orgA, userA.id);
    await pool.query(
      `INSERT INTO document_links (org_id, document_id, app_slug, entity_type, entity_id, created_by)
       VALUES ($1, $2, 'ledger-core', 'invoice', $3, $4)`,
      [orgA, documentId, randomUUID(), userA.id],
    );
    const code = await errorCode(() =>
      pool.query(`UPDATE document_links SET entity_type = 'bill' WHERE org_id = $1`, [orgA]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });
});

describe('uniqueness', () => {
  it('a duplicate (org_id, sha256) is rejected', async () => {
    await insertDocument(orgA, userA.id, VALID_SHA);
    const code = await errorCode(() => insertDocument(orgA, userA.id, VALID_SHA));
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('a duplicate link target is rejected', async () => {
    const documentId = await insertDocument(orgA, userA.id);
    const entityId = randomUUID();
    const insertLink = () =>
      pool.query(
        `INSERT INTO document_links (org_id, document_id, app_slug, entity_type, entity_id, created_by)
         VALUES ($1, $2, 'ledger-core', 'invoice', $3, $4)`,
        [orgA, documentId, entityId, userA.id],
      );
    await insertLink();
    const code = await errorCode(insertLink);
    expect(code).toBe(UNIQUE_VIOLATION);
  });
});

describe('check constraints', () => {
  it('a sha256 that is not 64 lowercase hex is rejected', async () => {
    const code = await errorCode(() => insertDocument(orgA, userA.id, 'not-a-valid-sha'));
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('a mime_type outside the allowlist is rejected', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
         VALUES ($1, $2, 10, 'application/zip', 'x.zip', $3)`,
        [orgA, VALID_SHA, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('byte_size of 0 is rejected', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
         VALUES ($1, $2, 0, 'application/pdf', 'x.pdf', $3)`,
        [orgA, VALID_SHA, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe('cascade', () => {
  it("deleting an organization cascades its documents and links away", async () => {
    const documentId = await insertDocument(orgA, userA.id);
    await pool.query(
      `INSERT INTO document_links (org_id, document_id, app_slug, entity_type, entity_id, created_by)
       VALUES ($1, $2, 'ledger-core', 'invoice', $3, $4)`,
      [orgA, documentId, randomUUID(), userA.id],
    );

    await pool.query('DELETE FROM organizations WHERE id = $1', [orgA]);

    const docs = await pool.query('SELECT count(*)::int AS n FROM documents WHERE org_id = $1', [orgA]);
    const links = await pool.query('SELECT count(*)::int AS n FROM document_links WHERE org_id = $1', [
      orgA,
    ]);
    expect(docs.rows[0]?.n).toBe(0);
    expect(links.rows[0]?.n).toBe(0);
  });
});

describe('audit trail', () => {
  it('both tables are audited', async () => {
    const documentId = await insertDocument(orgA, userA.id);
    await pool.query(
      `INSERT INTO document_links (org_id, document_id, app_slug, entity_type, entity_id, created_by)
       VALUES ($1, $2, 'ledger-core', 'invoice', $3, $4)`,
      [orgA, documentId, randomUUID(), userA.id],
    );

    const docAudit = await pool.query<{ app_slug: string }>(
      `SELECT app_slug FROM audit_logs WHERE org_id = $1 AND table_name = 'documents' AND operation = 'INSERT'`,
      [orgA],
    );
    expect(docAudit.rows).toHaveLength(1);
    expect(docAudit.rows[0]?.app_slug).toBe('platform');

    const linkAudit = await pool.query<{ app_slug: string }>(
      `SELECT app_slug FROM audit_logs WHERE org_id = $1 AND table_name = 'document_links' AND operation = 'INSERT'`,
      [orgA],
    );
    expect(linkAudit.rows).toHaveLength(1);
    expect(linkAudit.rows[0]?.app_slug).toBe('platform');
  });
});
