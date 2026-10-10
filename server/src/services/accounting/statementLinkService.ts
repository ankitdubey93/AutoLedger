import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { sha256Hex } from '../../utils/pkce.js';
import type { PartyKind, StatementType } from '../../types/accounting.js';

/**
 * Resolving an emailed statement link's token to its send (Phase 39b) —
 * shared by the public statement view and online payment (39c), and the only
 * org-less query in the statement module: the token is the credential, and
 * the row it matches supplies the `org_id` every later read is scoped by.
 *
 * The token is looked up by its SHA-256 hash — never stored, never logged.
 * An unknown, expired or revoked token is one indistinguishable 404.
 */

export interface LiveSend {
  id: string;
  orgId: string;
  partyKind: PartyKind;
  partyId: string;
  statementType: StatementType;
  asOf: string | null;
  from: string | null;
  to: string | null;
  sentBy: string;
  expiresAt: string;
}

interface SendRow {
  id: string;
  org_id: string;
  party_kind: PartyKind;
  customer_id: string | null;
  vendor_id: string | null;
  statement_type: StatementType;
  as_of: string | null;
  period_from: string | null;
  period_to: string | null;
  sent_by: string;
  expires_at: Date;
}

const NOT_VALID = 'This statement link is not valid or has expired';

/** Resolves a raw link token to its send, or 404s. The only org-less query in the module. */
export async function resolveLiveSend(token: string): Promise<LiveSend> {
  if (token.length < 20 || token.length > 200) throw new ApiError(404, NOT_VALID);
  const { rows } = await pool.query<SendRow>(
    `SELECT id, org_id, party_kind, customer_id, vendor_id, statement_type,
            as_of::text AS as_of, period_from::text AS period_from, period_to::text AS period_to,
            sent_by, expires_at
       FROM statement_sends
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [sha256Hex(token)],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, NOT_VALID);
  return {
    id: row.id,
    orgId: row.org_id,
    partyKind: row.party_kind,
    partyId: row.customer_id ?? row.vendor_id ?? '',
    statementType: row.statement_type,
    asOf: row.as_of,
    from: row.period_from,
    to: row.period_to,
    sentBy: row.sent_by,
    expiresAt: row.expires_at.toISOString(),
  };
}

export interface PublicPaymentOptions {
  enabled: boolean;
  publishableKey: string | null;
}
