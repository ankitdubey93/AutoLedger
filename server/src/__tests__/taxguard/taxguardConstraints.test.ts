import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the service — every test here drives
 * raw SQL straight at the pool to prove migrations 044-045's constraints
 * hold regardless of what wrote the row. corpusService is never imported.
 */

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

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

function vectorLiteral(dims: number): string {
  return `[${Array.from({ length: dims }, () => '0.01').join(',')}]`;
}

/** Registers a vault document and a READY-eligible taxguard_corpus_documents row for orgA. */
async function seedCorpusDocument(orgId: string, userId: string): Promise<{ corpusId: string; vaultDocId: string }> {
  const { rows: docRows } = await pool.query<{ id: string }>(
    `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
     VALUES ($1, $2, 10, 'application/pdf', 'act.pdf', $3)
     RETURNING id`,
    [orgId, 'd'.repeat(64), userId],
  );
  const vaultDocId = docRows[0]?.id;
  if (vaultDocId === undefined) throw new Error('fixture: no vault document id');

  const { rows: corpusRows } = await pool.query<{ id: string }>(
    `INSERT INTO taxguard_corpus_documents (org_id, document_id, title, jurisdiction, created_by)
     VALUES ($1, $2, 'Test Act', 'IN', $3)
     RETURNING id`,
    [orgId, vaultDocId, userId],
  );
  const corpusId = corpusRows[0]?.id;
  if (corpusId === undefined) throw new Error('fixture: no corpus document id');

  return { corpusId, vaultDocId };
}

describe('taxguard database constraints', () => {
  beforeEach(async () => {
    await resetTables();
    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;
    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    orgB = userB.orgId;
  });

  afterAll(closePool);

  it('rejects a chunk whose corpus_document_id belongs to another org with 23503', async () => {
    const { corpusId } = await seedCorpusDocument(orgA, userA.id);

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO taxguard_chunks (org_id, corpus_document_id, ordinal, citation, content, token_estimate)
         VALUES ($1, $2, 0, 'Test Act, Section 1', 'body', 10)`,
        [orgB, corpusId],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('rejects a duplicate (org_id, corpus_document_id, ordinal) with 23505', async () => {
    const { corpusId } = await seedCorpusDocument(orgA, userA.id);
    await pool.query(
      `INSERT INTO taxguard_chunks (org_id, corpus_document_id, ordinal, citation, content, token_estimate)
       VALUES ($1, $2, 0, 'Test Act, Section 1', 'body', 10)`,
      [orgA, corpusId],
    );

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO taxguard_chunks (org_id, corpus_document_id, ordinal, citation, content, token_estimate)
         VALUES ($1, $2, 0, 'Test Act, Section 1 (dup)', 'other body', 12)`,
        [orgA, corpusId],
      ),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('rejects an embedding without embedded_at with 23514', async () => {
    const { corpusId } = await seedCorpusDocument(orgA, userA.id);

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO taxguard_chunks (org_id, corpus_document_id, ordinal, citation, content, token_estimate, embedding)
         VALUES ($1, $2, 0, 'Test Act, Section 1', 'body', 10, $3::vector)`,
        [orgA, corpusId, vectorLiteral(1024)],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects a status outside the five with 23514', async () => {
    const { vaultDocId } = await seedCorpusDocument(orgA, userA.id);

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO taxguard_corpus_documents (org_id, document_id, title, jurisdiction, status, created_by)
         VALUES ($1, $2, 'Another Act', 'IN', 'BOGUS', $3)`,
        [orgA, vaultDocId, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects READY with chunk_count = 0 with 23514', async () => {
    const { vaultDocId } = await seedCorpusDocument(orgA, userA.id);

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO taxguard_corpus_documents
           (org_id, document_id, title, jurisdiction, status, chunk_count, ingested_at, created_by)
         VALUES ($1, $2, 'Another Act', 'IN', 'READY', 0, now(), $3)`,
        [orgA, vaultDocId, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects FAILED with a null error_message with 23514', async () => {
    const { vaultDocId } = await seedCorpusDocument(orgA, userA.id);

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO taxguard_corpus_documents (org_id, document_id, title, jurisdiction, status, created_by)
         VALUES ($1, $2, 'Another Act', 'IN', 'FAILED', $3)`,
        [orgA, vaultDocId, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects a 512-dimension vector into a vector(1024) column', async () => {
    const { corpusId } = await seedCorpusDocument(orgA, userA.id);

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO taxguard_chunks
           (org_id, corpus_document_id, ordinal, citation, content, token_estimate, embedding, embedded_at)
         VALUES ($1, $2, 0, 'Test Act, Section 1', 'body', 10, $3::vector, now())`,
        [orgA, corpusId, vectorLiteral(512)],
      ),
    );
    expect(code).toBeDefined();
  });

  it('deleting the organization cascades the corpus document and its chunks', async () => {
    const { corpusId } = await seedCorpusDocument(orgA, userA.id);
    await pool.query(
      `INSERT INTO taxguard_chunks (org_id, corpus_document_id, ordinal, citation, content, token_estimate)
       VALUES ($1, $2, 0, 'Test Act, Section 1', 'body', 10)`,
      [orgA, corpusId],
    );

    await pool.query('DELETE FROM organizations WHERE id = $1', [orgA]);

    const { rows: corpusRows } = await pool.query('SELECT id FROM taxguard_corpus_documents WHERE id = $1', [
      corpusId,
    ]);
    expect(corpusRows).toHaveLength(0);
    const { rows: chunkRows } = await pool.query('SELECT id FROM taxguard_chunks WHERE corpus_document_id = $1', [
      corpusId,
    ]);
    expect(chunkRows).toHaveLength(0);
  });
});
