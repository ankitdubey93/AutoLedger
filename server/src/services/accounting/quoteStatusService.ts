import type { PoolClient } from 'pg';
import { ApiError } from '../../utils/apiError.js';
import * as historyService from '../historyService.js';
import type { HistoryAction } from '../../types/history.js';
import { canTransitionQuote, isQuoteStatus, type QuoteStatus } from '../../types/accounting.js';

/**
 * Phase 41 — the one place a quote's status is written after it is sent
 * (guardrails rule 10). DRAFT → SENT is the exception: finalizing writes the
 * number, snapshot and content hash with it, so `quoteService.sendQuote`
 * checks `canTransitionQuote` itself and writes that one transition.
 *
 * A separate module, not part of quoteService, so invoiceService/billService
 * can revert a conversion when its draft is deleted without importing
 * quoteService — which imports them (a cycle).
 *
 * Every column a transition writes is fixed here per target status: no
 * caller-supplied column name ever reaches the SQL (rule 4).
 */

type Queryable = Pick<PoolClient, 'query'>;

export interface TransitionExtras {
  /** VOID only. */
  reason?: string;
  /** CONVERTED only. */
  userId?: string;
}

/**
 * Locks the quote, checks the transition, and writes it with its timestamp.
 * Returns the previous status. 404 for another tenant's id (rule 1); 409 for
 * a transition the table does not allow.
 */
export async function transitionQuoteOnClient(
  client: Queryable,
  orgId: string,
  quoteId: string,
  to: Exclude<QuoteStatus, 'DRAFT' | 'SENT'>,
  extras: TransitionExtras = {},
): Promise<QuoteStatus> {
  const { rows } = await client.query<{ status: string; direction: string }>(
    'SELECT status, direction FROM quotes WHERE id = $1 AND org_id = $2 FOR UPDATE',
    [quoteId, orgId],
  );
  const current = rows[0]?.status;
  const direction = rows[0]?.direction;
  if (current === undefined) throw new ApiError(404, 'Quote not found');
  if (!isQuoteStatus(current)) throw new Error(`Unknown quote status "${current}" on quote ${quoteId}`);
  if (!canTransitionQuote(current, to)) {
    throw new ApiError(409, `A ${current.toLowerCase()} quote cannot become ${to.toLowerCase()}`);
  }

  switch (to) {
    case 'ACCEPTED':
      if (current === 'CONVERTED') {
        // Undoing a conversion: the accepted_at evidence stays as it was.
        await client.query(
          `UPDATE quotes SET status = 'ACCEPTED', converted_at = NULL, converted_by = NULL
            WHERE id = $1 AND org_id = $2`,
          [quoteId, orgId],
        );
      } else {
        await client.query(
          `UPDATE quotes SET status = 'ACCEPTED', accepted_at = now() WHERE id = $1 AND org_id = $2`,
          [quoteId, orgId],
        );
      }
      break;
    case 'DECLINED':
      await client.query(
        `UPDATE quotes SET status = 'DECLINED', declined_at = now() WHERE id = $1 AND org_id = $2`,
        [quoteId, orgId],
      );
      break;
    case 'EXPIRED':
      await client.query(
        `UPDATE quotes SET status = 'EXPIRED', expired_at = now() WHERE id = $1 AND org_id = $2`,
        [quoteId, orgId],
      );
      break;
    case 'SUPERSEDED':
      await client.query(
        `UPDATE quotes SET status = 'SUPERSEDED', superseded_at = now() WHERE id = $1 AND org_id = $2`,
        [quoteId, orgId],
      );
      break;
    case 'VOID': {
      const reason = extras.reason;
      if (reason === undefined || reason.trim() === '') throw new ApiError(422, 'A reason is required');
      await client.query(
        `UPDATE quotes SET status = 'VOID', voided_at = now(), void_reason = $3 WHERE id = $1 AND org_id = $2`,
        [quoteId, orgId, reason],
      );
      break;
    }
    case 'CONVERTED': {
      const userId = extras.userId;
      if (userId === undefined) throw new Error('transitionQuoteOnClient: CONVERTED needs extras.userId');
      await client.query(
        `UPDATE quotes SET status = 'CONVERTED', converted_at = now(), converted_by = $3
          WHERE id = $1 AND org_id = $2`,
        [quoteId, orgId, userId],
      );
      break;
    }
  }

  // Phase 46c — the timeline entry. No actor on the public accept/decline
  // flow or the expiry sweep: historyService reads the request context only.
  const actions = {
    ACCEPTED: 'ACCEPTED',
    DECLINED: 'DECLINED',
    EXPIRED: 'EXPIRED',
    VOID: 'VOIDED',
    SUPERSEDED: 'SUPERSEDED',
    CONVERTED: 'CONVERTED',
  } as const satisfies Record<typeof to, Exclude<HistoryAction, 'NOTE'>>;
  let summary = `Marked ${to.toLowerCase()}`;
  if (current === 'CONVERTED') summary = 'Conversion undone';
  else if (to === 'VOID' && extras.reason !== undefined) summary = `Voided: ${extras.reason}`;
  await historyService.recordEventOnClient(client, orgId, {
    entityType: direction === 'SALES' ? 'QUOTE' : 'PURCHASE_QUOTE',
    entityId: quoteId,
    action: actions[to],
    summary,
  });

  return current;
}

/**
 * Called by invoiceService.deleteInvoice / billService.deleteBill, on their
 * own transaction, when the deleted draft was converted from a quote: the
 * quote goes back to ACCEPTED and may be converted again. A no-op when the
 * document had no source quote.
 */
export async function revertConversionOnClient(
  client: Queryable,
  orgId: string,
  quoteId: string | null,
): Promise<void> {
  if (quoteId === null) return;
  await transitionQuoteOnClient(client, orgId, quoteId, 'ACCEPTED');
}
