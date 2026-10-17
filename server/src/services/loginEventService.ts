import type { PoolClient } from 'pg';
import { pool } from '../db/connect.js';
import { getRequestContext } from '../utils/requestContext.js';
import { logger } from '../utils/logger.js';
import type { LoginEvent, LoginOutcome, MemberActivity } from '../types/auth.js';

type Queryable = Pick<PoolClient, 'query'>;

export interface LoginEventInput {
  userId: string | null;
  orgId: string | null;
  email: string;
  outcome: LoginOutcome;
}

/**
 * Phase 46d — append one sign-in event on the caller's own client, so the row
 * commits or rolls back with whatever else that transaction does (rule 5).
 * The email is lowercased (rule 9); ip and user agent come from the request
 * context and are truncated to the column limits. Never stores a token or
 * password (rule 11).
 */
export async function recordLoginEventOnClient(q: Queryable, e: LoginEventInput): Promise<void> {
  const ctx = getRequestContext();
  await q.query(
    `INSERT INTO login_events (user_id, org_id, email, outcome, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      e.userId,
      e.orgId,
      e.email.toLowerCase().slice(0, 320),
      e.outcome,
      ctx?.ip?.slice(0, 45) ?? null,
      ctx?.userAgent?.slice(0, 500) ?? null,
    ],
  );
}

/**
 * Same write on the pool — for a FAILED sign-in (which must survive the login
 * transaction's ROLLBACK) and for callers that hold no transaction. Never
 * throws: a logging failure is logged and swallowed, so it can never turn a
 * 401 into a 500.
 */
export async function recordLoginEvent(e: LoginEventInput): Promise<void> {
  try {
    await recordLoginEventOnClient(pool, e);
  } catch (err) {
    logger.error({ err, outcome: e.outcome }, 'could not record login event');
  }
}

/**
 * The caller's own sign-in history. Scoped by the token's user id, not an
 * org: a user's own sign-ins belong to the identity, which precedes every
 * organization, so this is not tenant data (same reasoning as listSessions).
 */
export async function listMyLoginEvents(userId: string, limit = 20): Promise<LoginEvent[]> {
  const { rows } = await pool.query<{
    id: string;
    outcome: LoginOutcome;
    ip: string | null;
    user_agent: string | null;
    created_at: Date;
  }>(
    `SELECT id, outcome, ip, user_agent, created_at
       FROM login_events
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    outcome: r.outcome,
    ip: r.ip,
    userAgent: r.user_agent,
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * Per-member activity for managers. Membership and audit changes are scoped
 * to the org; last sign-in counts only sign-ins into this org (a member's
 * sign-in to another of their orgs is not this org's business).
 */
export async function listMemberActivity(orgId: string): Promise<MemberActivity[]> {
  const { rows } = await pool.query<{
    user_id: string;
    name: string | null;
    email: string;
    role: string;
    last_sign_in_at: Date | null;
    failed_last_30: string;
    changes_last_30: string;
  }>(
    `SELECT m.user_id, u.name, u.email,
            CASE WHEN m.role = 'CUSTOM' THEN COALESCE(r.name, 'Custom role') ELSE m.role END AS role,
            (SELECT max(le.created_at) FROM login_events le
              WHERE le.user_id = m.user_id AND le.org_id = $1 AND le.outcome = 'SUCCESS') AS last_sign_in_at,
            (SELECT count(*) FROM login_events le
              WHERE le.user_id = m.user_id AND le.outcome = 'FAILED'
                AND le.created_at > now() - interval '30 days') AS failed_last_30,
            (SELECT count(*) FROM audit_logs al
              WHERE al.org_id = $1 AND al.actor_user_id = m.user_id
                AND al.created_at > now() - interval '30 days') AS changes_last_30
       FROM organization_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.custom_role_id
      WHERE m.org_id = $1
      ORDER BY lower(u.email)`,
    [orgId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role,
    lastSignInAt: r.last_sign_in_at === null ? null : r.last_sign_in_at.toISOString(),
    failedSignInsLast30Days: Number(r.failed_last_30),
    changesLast30Days: Number(r.changes_last_30),
  }));
}
