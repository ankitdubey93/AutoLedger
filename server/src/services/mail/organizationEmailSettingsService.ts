import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { env } from '../../config/env.js';
import type { OrganizationEmailSettings } from '../../types/email.js';

/**
 * Phase 38b — Organization settings → Email: how email sent on this
 * organization's behalf presents itself (invitations, approval requests).
 * Scoped by `org_id` from the verified token (rule 1).
 */

function toSettings(row: { sender_name: string | null; reply_to: string | null } | undefined): OrganizationEmailSettings {
  return {
    senderName: row?.sender_name ?? null,
    replyTo: row?.reply_to ?? null,
    fromEmail: env.MAIL_FROM_EMAIL,
    transport: env.MAIL_TRANSPORT,
  };
}

export async function getEmailSettings(orgId: string): Promise<OrganizationEmailSettings> {
  const { rows } = await pool.query<{ sender_name: string | null; reply_to: string | null }>(
    'SELECT sender_name, reply_to FROM organization_email_settings WHERE org_id = $1',
    [orgId],
  );
  return toSettings(rows[0]);
}

/** Upsert. `null` clears a field back to the platform default. */
export async function updateEmailSettings(
  orgId: string,
  input: { senderName?: string | null | undefined; replyTo?: string | null | undefined },
): Promise<OrganizationEmailSettings> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ sender_name: string | null; reply_to: string | null }>(
      `INSERT INTO organization_email_settings (org_id, sender_name, reply_to)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id) DO UPDATE SET
         sender_name = CASE WHEN $4 THEN EXCLUDED.sender_name ELSE organization_email_settings.sender_name END,
         reply_to    = CASE WHEN $5 THEN EXCLUDED.reply_to    ELSE organization_email_settings.reply_to    END
       RETURNING sender_name, reply_to`,
      [
        orgId,
        input.senderName ?? null,
        input.replyTo?.toLowerCase() ?? null,
        input.senderName !== undefined,
        input.replyTo !== undefined,
      ],
    );
    return toSettings(rows[0]);
  });
}
