import { pool } from '../../db/connect.js';
import { env } from '../../config/env.js';
import { decryptSecret } from '../../utils/secretBox.js';
import type { EmailTemplate } from '../../types/email.js';

/**
 * Phase 38b — reads what the email outbox holds for an address, the way a
 * test reads "the email that was sent". Token-bearing links exist only
 * here (the token tables store hashes), so this is how a test gets a
 * reset, invitation or verification token.
 */
export async function outboxFor(to: string, template?: EmailTemplate) {
  const { rows } = await pool.query<{
    id: string;
    org_id: string | null;
    template: EmailTemplate;
    template_data: Record<string, unknown>;
    secret_link: string | null;
    secret_encrypted: boolean;
    sender_name: string | null;
    reply_to: string | null;
    status: string;
  }>(
    `SELECT id, org_id, template, template_data, secret_link, secret_encrypted, sender_name, reply_to, status
       FROM email_outbox
      WHERE to_email = LOWER($1) AND ($2::text IS NULL OR template = $2)
      ORDER BY created_at, id`,
    [to, template ?? null],
  );
  return rows;
}

/** The newest link emailed to `to` with `template`, decrypted. Throws if none. */
export async function latestEmailLink(to: string, template: EmailTemplate): Promise<URL> {
  const rows = await outboxFor(to, template);
  const row = rows[rows.length - 1];
  if (row === undefined || row.secret_link === null) throw new Error(`no ${template} email with a link for ${to}`);
  const link = row.secret_encrypted ? decryptSecret(row.secret_link, env.INTEGRATION_ENCRYPTION_KEY) : row.secret_link;
  return new URL(link);
}

/** The `token` query parameter (or last path segment) of the newest such link. */
export async function latestEmailToken(to: string, template: EmailTemplate): Promise<string> {
  const url = await latestEmailLink(to, template);
  return url.searchParams.get('token') ?? url.pathname.split('/').pop() ?? '';
}
