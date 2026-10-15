import type { PoolClient } from 'pg';
import { ApiError } from '../../utils/apiError.js';
import type { QuoteDirection } from '../../types/accounting.js';

/**
 * Phase 42 — validates the `orderLineId` an invoice or bill line carries.
 *
 * Called by invoiceService and billService on their own transaction client,
 * before they insert lines. It checks the *link* (the order line exists in
 * this organization, is on the right side, belongs to a confirmed order of
 * the same party and currency). The *quantity* cap — billed ≤ ordered — is
 * enforced by migration 092's deferred constraint trigger at COMMIT, so a
 * transaction that voids one document and raises another is judged on its
 * final state; the order rows are locked here so two concurrent invoices
 * against one order are serialised and the second sees the first's lines.
 */

type Queryable = Pick<PoolClient, 'query'>;

export async function assertOrderLineLinksOnClient(
  client: Queryable,
  orgId: string,
  direction: QuoteDirection,
  partyId: string,
  currencyCode: string,
  orderLineIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(orderLineIds)];
  if (ids.length === 0) return;

  // Ordered by order id so concurrent callers take their locks in one order.
  const { rows } = await client.query<{
    id: string;
    direction: QuoteDirection;
    status: string;
    customer_id: string | null;
    vendor_id: string | null;
    currency_code: string;
  }>(
    `SELECT ol.id, o.direction, o.status, o.customer_id, o.vendor_id, o.currency_code
       FROM order_lines ol
       JOIN orders o ON o.org_id = ol.org_id AND o.id = ol.order_id
      WHERE ol.org_id = $1 AND ol.id = ANY($2::uuid[])
      ORDER BY o.id, ol.id
        FOR UPDATE OF o`,
    [orgId, ids],
  );

  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = byId.get(id);
    // Another tenant's line and another direction's line are both simply "not found".
    if (row === undefined || row.direction !== direction) throw new ApiError(422, 'Order line not found');
    if (row.status !== 'CONFIRMED') throw new ApiError(422, 'Only a confirmed order can be invoiced');
    const orderParty = direction === 'SALES' ? row.customer_id : row.vendor_id;
    if (orderParty !== partyId) {
      throw new ApiError(422, `That order belongs to a different ${direction === 'SALES' ? 'customer' : 'vendor'}`);
    }
    if (row.currency_code.trim() !== currencyCode) {
      throw new ApiError(422, 'An order can only be billed in its own currency');
    }
  }
}
