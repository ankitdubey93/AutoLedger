import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { sha256Hex } from '../../utils/pkce.js';

/**
 * Resolving an emailed invoice link's token to its send (Phase 48) — shared by
 * the public invoice view and online payment, and the only org-less query in
 * the invoice-delivery module: the token is the credential, and the row it
 * matches supplies the `org_id` every later read is scoped by.
 *
 * The token is looked up by its SHA-256 hash — never stored, never logged.
 * An unknown, expired or revoked token is one indistinguishable 404.
 */

export interface LiveInvoiceSend {
  id: string;
  orgId: string;
  invoiceId: string;
  sentBy: string;
  expiresAt: string;
}

interface SendRow {
  id: string;
  org_id: string;
  invoice_id: string;
  sent_by: string;
  expires_at: Date;
}

const NOT_VALID = 'This invoice link is not valid or has expired';

/** Resolves a raw link token to its send, or 404s. */
export async function resolveLiveInvoiceSend(token: string): Promise<LiveInvoiceSend> {
  if (token.length < 20 || token.length > 200) throw new ApiError(404, NOT_VALID);
  const { rows } = await pool.query<SendRow>(
    `SELECT id, org_id, invoice_id, sent_by, expires_at
       FROM invoice_sends
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [sha256Hex(token)],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, NOT_VALID);
  return {
    id: row.id,
    orgId: row.org_id,
    invoiceId: row.invoice_id,
    sentBy: row.sent_by,
    expiresAt: row.expires_at.toISOString(),
  };
}
