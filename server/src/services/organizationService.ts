import type { PoolClient } from 'pg';
import { pool } from '../db/connect.js';
import { ApiError } from '../utils/apiError.js';
import { isRole, type OrganizationMember, type OrganizationSummary } from '../types/auth.js';

/**
 * Organization reads and updates, scoped to the caller's active organization.
 *
 * Every function takes `orgId` as its first argument (docs/architecture.md) and
 * every query carries an `org_id` predicate. That `orgId` always originates
 * from the verified access token — never a param, header or body.
 */

/** Both `pool` and a checked-out `PoolClient` satisfy this — see authService.ts. */
type Queryable = Pick<PoolClient, 'query'>;

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  base_currency: string;
  created_at: Date;
}

function toOrganizationSummary(row: OrganizationRow): OrganizationSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    // CHAR(3) is blank-padded on read in some drivers; trim defensively.
    baseCurrency: row.base_currency.trim(),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The active organization's own record.
 *
 * Scoped rather than a bare lookup by id: even though the id comes from a
 * signed token, keeping the predicate here means the query is still correct if
 * this is ever called from somewhere less trustworthy.
 */
export async function getById(orgId: string): Promise<OrganizationSummary> {
  const { rows } = await pool.query<OrganizationRow>(
    'SELECT id, name, slug, base_currency, created_at FROM organizations WHERE id = $1',
    [orgId],
  );

  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Organization not found');
  return toOrganizationSummary(row);
}

/**
 * Edits the organization's name and/or base currency.
 *
 * Takes a `Queryable` last, defaulting to `pool`, so `settingsService`'s
 * onboarding transaction can pass its checked-out `client` and have this write
 * commit or roll back together with the rest of onboarding (guardrails rule
 * 5) — a stray `pool.query` here would run on a different connection and
 * commit immediately regardless of the caller's transaction.
 */
export async function updateOrganization(
  orgId: string,
  input: { name?: string | undefined; baseCurrency?: string | undefined },
  q: Queryable = pool,
): Promise<OrganizationSummary> {
  // Column names come from this frozen map, never from the request — rule 4
  // forbids interpolating an identifier a caller could influence.
  const COLUMNS = {
    name: 'name',
    baseCurrency: 'base_currency',
  } as const;

  const assignments: string[] = [];
  const values: unknown[] = [orgId];

  for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
    const value = input[key];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${COLUMNS[key]} = $${String(values.length)}`);
  }

  if (assignments.length === 0) throw new ApiError(400, 'No fields to update');

  const { rows } = await q.query<OrganizationRow>(
    `UPDATE organizations SET ${assignments.join(', ')}
      WHERE id = $1
      RETURNING id, name, slug, base_currency, created_at`,
    values,
  );

  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Organization not found');
  return toOrganizationSummary(row);
}

/**
 * Everyone in one organization.
 *
 * The `WHERE m.org_id = $1` is the tenant boundary: without it this would
 * return every user in the database, which is precisely the leak guardrails
 * rule 1 exists to prevent. Covered by the cross-tenant isolation test — a
 * caller in org A must never see a member of org B, no matter what they put in
 * the query string, headers or body.
 */
export async function listMembers(orgId: string): Promise<OrganizationMember[]> {
  const { rows } = await pool.query<{
    user_id: string;
    name: string | null;
    email: string;
    role: string;
    joined_at: Date;
  }>(
    `SELECT u.id AS user_id, u.name, u.email, m.role, m.created_at AS joined_at
       FROM organization_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1
      ORDER BY m.created_at ASC`,
    [orgId],
  );

  return rows.map((r) => {
    if (!isRole(r.role)) throw new Error(`Unknown role "${r.role}" in org ${orgId}`);
    return {
      userId: r.user_id,
      name: r.name,
      email: r.email,
      role: r.role,
      joinedAt: r.joined_at.toISOString(),
    };
  });
}
