import type { Readable } from 'node:stream';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import * as fiscalPeriodService from '../ledger-core/fiscalPeriodService.js';
import * as planService from '../forecaster/planService.js';
import * as storageService from '../storageService.js';
import { enqueue } from '../../queue/queues.js';
import { ApiError } from '../../utils/apiError.js';
import { canTransitionDeck } from '../../types/boarddeck.js';
import type { BoardDeckDeck, BoardDeckDeckStatus } from '../../types/boarddeck.js';

const MAX_ERROR_MESSAGE_CHARS = 500;

/**
 * BoardDeck (Phase 15) — .pptx deck lifecycle. This file contains ZERO SQL
 * against fiscal_periods or forecaster_plans. Its only routes into other
 * apps are `fiscalPeriodService.getPeriodById` and `planService.getPlanById`
 * (guardrails rule 16) — both already 404 a cross-tenant id.
 *
 * No REFERENCES fiscal_periods/forecaster_plans on
 * boarddeck_decks.fiscal_period_id/plan_id — migration 043's header.
 */

const PG_INVALID_TEXT_REPRESENTATION = '22P02';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface DeckRow {
  id: string;
  title: string;
  fiscal_period_id: string;
  plan_id: string | null;
  period_starts_on: string; // DATE columns come back as strings — db/connect.ts.
  period_ends_on: string;
  status: BoardDeckDeckStatus;
  sha256: string | null;
  byte_size: string | null;
  slide_count: number | null;
  error_message: string | null;
  generated_at: Date | null;
  created_by_name: string | null;
  created_at: Date;
}

const DECK_SELECT = `
  SELECT d.id, d.title, d.fiscal_period_id, d.plan_id,
         d.period_starts_on, d.period_ends_on, d.status,
         d.sha256, d.byte_size, d.slide_count, d.error_message, d.generated_at,
         creator.name AS created_by_name,
         d.created_at
    FROM boarddeck_decks d
    LEFT JOIN users creator ON creator.id = d.created_by
`;

function toDeck(row: DeckRow): BoardDeckDeck {
  return {
    id: row.id,
    title: row.title,
    fiscalPeriodId: row.fiscal_period_id,
    planId: row.plan_id,
    periodStartsOn: row.period_starts_on,
    periodEndsOn: row.period_ends_on,
    status: row.status,
    sha256: row.sha256,
    byteSizeBytes: row.byte_size === null ? null : Number(row.byte_size),
    slideCount: row.slide_count,
    errorMessage: row.error_message,
    generatedAt: row.generated_at === null ? null : row.generated_at.toISOString(),
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listDecks(orgId: string): Promise<BoardDeckDeck[]> {
  const { rows } = await pool.query<DeckRow>(`${DECK_SELECT} WHERE d.org_id = $1 ORDER BY d.created_at DESC`, [
    orgId,
  ]);
  return rows.map(toDeck);
}

export async function getDeckById(orgId: string, id: string): Promise<BoardDeckDeck> {
  try {
    const { rows } = await pool.query<DeckRow>(`${DECK_SELECT} WHERE d.org_id = $1 AND d.id = $2`, [orgId, id]);
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Deck not found');
    return toDeck(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_INVALID_TEXT_REPRESENTATION) {
      throw new ApiError(404, 'Deck not found');
    }
    throw err;
  }
}

export interface CreateDeckInput {
  title: string;
  fiscalPeriodId: string;
  planId: string | null;
}

export async function createDeck(orgId: string, userId: string, input: CreateDeckInput): Promise<BoardDeckDeck> {
  const period = await fiscalPeriodService.getPeriodById(orgId, input.fiscalPeriodId);
  if (input.planId !== null) {
    await planService.getPlanById(orgId, input.planId);
  }

  const id = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO boarddeck_decks
         (org_id, title, fiscal_period_id, plan_id, period_starts_on, period_ends_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [orgId, input.title, input.fiscalPeriodId, input.planId, period.startsOn, period.endsOn, userId],
    );
    const inserted = rows[0];
    if (inserted === undefined) throw new Error('createDeck: insert returned no row');
    return inserted.id;
  });

  // After commit — never inside the transaction (guardrails rule 5). jobId
  // is the idempotency key: a repeat add for the same deck is dropped by
  // BullMQ, which is what makes retryDeck's fresh jobId below necessary.
  await enqueue('boarddeck-generate', { orgId, deckId: id }, { jobId: `boarddeck-generate-${id}` });

  return getDeckById(orgId, id);
}

export async function retryDeck(orgId: string, id: string): Promise<BoardDeckDeck> {
  const existing = await getDeckById(orgId, id);
  if (existing.status !== 'FAILED') {
    throw new ApiError(409, 'Only a FAILED deck can be retried');
  }
  if (!canTransitionDeck('FAILED', 'PENDING')) {
    throw new ApiError(409, 'Cannot retry from FAILED');
  }

  await pool.query(
    `UPDATE boarddeck_decks SET status = 'PENDING', error_message = NULL
      WHERE org_id = $1 AND id = $2 AND status = 'FAILED'`,
    [orgId, id],
  );

  // A fresh jobId — the original may still be present in Redis from the
  // failed attempt.
  await enqueue('boarddeck-generate', { orgId, deckId: id }, { jobId: `boarddeck-generate-${id}-${String(Date.now())}` });

  return getDeckById(orgId, id);
}

export async function deleteDeck(orgId: string, id: string): Promise<void> {
  // The stored blob is deliberately not deleted — storageService has no
  // delete, and an orphaned blob is the same accepted cost
  // documentService.uploadDocument records for its own rollback path.
  const { rowCount } = await pool.query('DELETE FROM boarddeck_decks WHERE org_id = $1 AND id = $2', [orgId, id]);
  if (rowCount === 0) throw new ApiError(404, 'Deck not found');
}

export async function openDeckStream(orgId: string, id: string): Promise<{ deck: BoardDeckDeck; stream: Readable }> {
  const deck = await getDeckById(orgId, id);
  if (deck.status !== 'READY') {
    throw new ApiError(409, 'Deck is not ready');
  }
  if (deck.sha256 === null) {
    throw new ApiError(500, 'Deck is READY with no artifact');
  }
  return { deck, stream: storageService.get(orgId, deck.sha256) };
}

/* ---------- called only by the queue handler (Step C6) */

export async function loadForGeneration(orgId: string, id: string): Promise<BoardDeckDeck | null> {
  try {
    return await getDeckById(orgId, id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function markGenerating(orgId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE boarddeck_decks SET status = 'GENERATING' WHERE org_id = $1 AND id = $2 AND status = 'PENDING'`,
    [orgId, id],
  );
  return rowCount === 1;
}

export async function markReady(
  orgId: string,
  id: string,
  artifact: { sha256: string; byteSizeBytes: number; slideCount: number },
): Promise<void> {
  await pool.query(
    `UPDATE boarddeck_decks
        SET status = 'READY', sha256 = $3, byte_size = $4, slide_count = $5,
            generated_at = now(), error_message = NULL
      WHERE org_id = $1 AND id = $2 AND status = 'GENERATING'`,
    [orgId, id, artifact.sha256, artifact.byteSizeBytes, artifact.slideCount],
  );
}

export async function markFailed(orgId: string, id: string, message: string): Promise<void> {
  await pool.query(
    `UPDATE boarddeck_decks
        SET status = 'FAILED', error_message = $3, sha256 = NULL, byte_size = NULL,
            slide_count = NULL, generated_at = NULL
      WHERE org_id = $1 AND id = $2`,
    [orgId, id, message.slice(0, MAX_ERROR_MESSAGE_CHARS)],
  );
}
