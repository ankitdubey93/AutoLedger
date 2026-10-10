import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { STATEMENT_MAX_RANGE_DAYS } from '../../config/constants.js';
import * as customerService from './customerService.js';
import * as vendorService from './vendorService.js';
import * as partyLedgerService from './partyLedgerService.js';
import {
  AGING_BUCKETS,
  type AgingBucket,
  type PartyKind,
  type PartyOpenItem,
  type PartyStatement,
  type StatementListRow,
  type StatementParty,
  type StatementType,
} from '../../types/accounting.js';

/**
 * Customer & vendor statements (Phase 39a).
 *
 * A statement is a *read* over the Phase 25 subledger — nothing is stored to
 * produce one. Two shapes:
 *   - OUTSTANDING on a date: the party's open items as they stood on it
 *     (`partyOpenItemsAsOf`, true as-at settlement — not the "now" open items).
 *   - ACTIVITY over a range: the party ledger, unpaginated, with opening,
 *     running and closing balance, plus the as-at open items at the range end
 *     for the aging footer.
 *
 * Every ledger read goes through partyLedgerService / the party services,
 * which own the org scoping (rule 1); the only SQL here is the 39b "last
 * sent" lookup on this module's own `statement_sends`.
 */

export type StatementRequest =
  | { type: 'OUTSTANDING'; asOf: string }
  | { type: 'ACTIVITY'; from: string; to: string };

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Validates the type/date combination a caller asked for — 400 on nonsense. */
export function readStatementRequest(input: {
  type: StatementType | null;
  asOf: string | null;
  from: string | null;
  to: string | null;
}): StatementRequest {
  const type = input.type ?? 'OUTSTANDING';
  if (type === 'OUTSTANDING') {
    return { type, asOf: input.asOf ?? todayIso() };
  }
  if (input.from === null) throw new ApiError(400, 'An activity statement needs a from date');
  const to = input.to ?? todayIso();
  const days = daysBetween(input.from, to);
  if (days < 0) throw new ApiError(400, 'from must be on or before to');
  if (days > STATEMENT_MAX_RANGE_DAYS) {
    throw new ApiError(400, `An activity statement can cover at most ${String(STATEMENT_MAX_RANGE_DAYS)} days`);
  }
  return { type, from: input.from, to };
}

async function loadStatementParty(orgId: string, kind: PartyKind, partyId: string): Promise<StatementParty> {
  // 404 through the party's own service — also the cross-tenant answer.
  const party =
    kind === 'CUSTOMER'
      ? await customerService.getCustomerById(orgId, partyId)
      : await vendorService.getVendorById(orgId, partyId);
  return {
    kind,
    id: party.id,
    name: party.name,
    email: party.email,
    billingAddress: party.billingAddress,
    taxNumber: party.taxNumber,
  };
}

function agingOf(items: PartyOpenItem[]): Record<AgingBucket, number> {
  const aging = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
  for (const item of items) aging[item.bucket] += item.baseOutstandingCents;
  return aging;
}

/** GET /statements/customers/:id and /statements/vendors/:id. */
export async function getStatement(
  orgId: string,
  kind: PartyKind,
  partyId: string,
  request: StatementRequest,
): Promise<PartyStatement> {
  const party = await loadStatementParty(orgId, kind, partyId);
  const statementDate = request.type === 'OUTSTANDING' ? request.asOf : request.to;
  const open = await partyLedgerService.partyOpenItemsAsOf(orgId, kind, partyId, statementDate);

  const base = {
    party,
    statementDate,
    openItems: open.items,
    outstandingCents: open.outstandingCents,
    overdueCents: open.overdueCents,
    aging: agingOf(open.items),
  };

  if (request.type === 'OUTSTANDING') {
    return {
      ...base,
      type: 'OUTSTANDING',
      from: null,
      openingBalanceCents: null,
      periodDebitCents: 0,
      periodCreditCents: 0,
      closingBalanceCents: open.outstandingCents,
      rows: [],
    };
  }

  const ledger = await partyLedgerService.partyLedgerForStatement(orgId, kind, partyId, {
    from: request.from,
    to: request.to,
  });
  return {
    ...base,
    type: 'ACTIVITY',
    from: request.from,
    openingBalanceCents: ledger.openingBalanceCents,
    periodDebitCents: ledger.periodDebitCents,
    periodCreditCents: ledger.periodCreditCents,
    closingBalanceCents: ledger.closingBalanceCents,
    rows: ledger.rows,
  };
}

/** 404 unless the party exists in the organization. */
export async function assertParty(orgId: string, kind: PartyKind, partyId: string): Promise<void> {
  await loadStatementParty(orgId, kind, partyId);
}

/** Last time each party of `kind` was emailed a statement (Phase 39b). */
async function lastSentByParty(orgId: string, kind: PartyKind): Promise<Map<string, string>> {
  // The column name is chosen from the closed PartyKind union, never request text (rule 4).
  const column = kind === 'CUSTOMER' ? 'customer_id' : 'vendor_id';
  const { rows } = await pool.query<{ party_id: string; last_sent: Date }>(
    `SELECT ${column} AS party_id, max(created_at) AS last_sent
       FROM statement_sends
      WHERE org_id = $1 AND party_kind = $2
      GROUP BY ${column}`,
    [orgId, kind],
  );
  return new Map(rows.map((r) => [r.party_id, r.last_sent.toISOString()]));
}

/** GET /statements/customers and /statements/vendors — the statements list. */
export async function listStatementParties(
  orgId: string,
  kind: PartyKind,
  options: { asOf: string; q: string | null; includeZero: boolean },
): Promise<StatementListRow[]> {
  const [balances, lastSent] = await Promise.all([
    partyLedgerService.partyBalancesAsOf(orgId, kind, options),
    lastSentByParty(orgId, kind),
  ]);
  return balances.map((b) => ({ ...b, lastSentAt: lastSent.get(b.partyId) ?? null }));
}
