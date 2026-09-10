import type { PoolClient } from 'pg';
import { pool } from '../db/connect.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../utils/apiError.js';
import { APPS } from '../config/apps.js';
import {
  canTransitionOnboarding,
  isOnboardingStatus,
  type OnboardingChecklistItem,
  type OnboardingSlug,
  type OnboardingState,
  type OnboardingStatus,
} from '../types/onboarding.js';

/**
 * Platform onboarding state — Phase 9a.
 *
 * Every function takes `orgId` first and every statement carries an
 * `org_id` predicate (guardrails rule 1). `orgId` always originates from the
 * verified access token, never from a route param, header or body — the
 * `:appSlug` segment is a routing target, not a tenancy boundary (rule 16).
 *
 * Every write is an upsert (`ON CONFLICT (org_id, app_slug) DO UPDATE`), so a
 * double submit from a flaky client is harmless — there is never a 409 for
 * "you already started".
 */

/** Both `pool` and a checked-out `PoolClient` satisfy this. */
type Queryable = Pick<PoolClient, 'query'>;

interface StateRow {
  app_slug: string;
  status: string;
  current_step: string | null;
  draft: Record<string, unknown>;
  completed_at: Date | null;
  skipped_at: Date | null;
  updated_at: Date;
}

function toState(row: StateRow): OnboardingState {
  if (!isOnboardingStatus(row.status)) {
    throw new Error(`Unknown onboarding status "${row.status}" for app ${row.app_slug}`);
  }
  return {
    appSlug: row.app_slug as OnboardingSlug,
    status: row.status,
    currentStep: row.current_step,
    draft: row.draft,
    completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
    skippedAt: row.skipped_at === null ? null : row.skipped_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The state of an app that has never had a row written — never a 404. */
function notStarted(appSlug: OnboardingSlug): OnboardingState {
  return {
    appSlug,
    status: 'NOT_STARTED',
    currentStep: null,
    draft: {},
    completedAt: null,
    skippedAt: null,
    updatedAt: null,
  };
}

const STATE_SELECT =
  'SELECT app_slug, status, current_step, draft, completed_at, skipped_at, updated_at FROM onboarding_states';

/** One item per app in APPS, plus 'platform'. A missing row reads as NOT_STARTED. */
export async function getChecklist(orgId: string): Promise<OnboardingChecklistItem[]> {
  const { rows } = await pool.query<StateRow>(`${STATE_SELECT} WHERE org_id = $1`, [orgId]);
  const byslug = new Map(rows.map((row) => [row.app_slug, toState(row)]));

  // 'platform' is marked 'planned' here deliberately: the row it tracks is
  // real (this phase creates it), but no suite-level onboarding UI has been
  // built yet — only LedgerCore's app-level wizard has. Marking it
  // 'building' would make SetupChecklist link to a page that does not
  // exist. Update this the phase a suite-level wizard actually ships.
  const slugs: { slug: OnboardingSlug; name: string; status: 'building' | 'planned' }[] = [
    ...APPS.map((app) => ({ slug: app.slug, name: app.name, status: app.status })),
    { slug: 'platform', name: 'AutoLedger', status: 'planned' },
  ];

  return slugs.map(({ slug, name, status }) => {
    const state = byslug.get(slug) ?? notStarted(slug);
    return { ...state, appName: name, appStatus: status };
  });
}

/** A missing row reads as a NOT_STARTED state with an empty draft — never a 404. */
export async function getState(orgId: string, appSlug: OnboardingSlug): Promise<OnboardingState> {
  const { rows } = await pool.query<StateRow>(`${STATE_SELECT} WHERE org_id = $1 AND app_slug = $2`, [
    orgId,
    appSlug,
  ]);
  const row = rows[0];
  return row === undefined ? notStarted(appSlug) : toState(row);
}

/** Reads the current status for one org/app, defaulting to NOT_STARTED when no row exists. */
async function currentStatus(q: Queryable, orgId: string, appSlug: OnboardingSlug): Promise<OnboardingStatus> {
  const { rows } = await q.query<{ status: string }>(
    'SELECT status FROM onboarding_states WHERE org_id = $1 AND app_slug = $2',
    [orgId, appSlug],
  );
  const status = rows[0]?.status;
  if (status === undefined) return 'NOT_STARTED';
  if (!isOnboardingStatus(status)) throw new Error(`Unknown onboarding status "${status}"`);
  return status;
}

/**
 * `from === to` is always legal — staying in the current state (e.g. saving a
 * second draft while already IN_PROGRESS) is not a transition, so it is never
 * checked against ONBOARDING_TRANSITIONS.
 */
function assertTransition(from: OnboardingStatus, to: OnboardingStatus): void {
  if (from === to) return;
  if (!canTransitionOnboarding(from, to)) {
    throw new ApiError(409, `Cannot move onboarding from ${from} to ${to}`);
  }
}

/** Upsert. Moves NOT_STARTED/SKIPPED/COMPLETED -> IN_PROGRESS and stores the step + draft. */
export async function saveDraft(
  orgId: string,
  appSlug: OnboardingSlug,
  input: { currentStep: string | null; draft: Record<string, unknown> },
): Promise<OnboardingState> {
  return withTransaction(async (client) => {
    const from = await currentStatus(client, orgId, appSlug);
    assertTransition(from, 'IN_PROGRESS');

    const { rows } = await client.query<StateRow>(
      `INSERT INTO onboarding_states (org_id, app_slug, status, current_step, draft)
       VALUES ($1, $2, 'IN_PROGRESS', $3, $4::jsonb)
       ON CONFLICT (org_id, app_slug) DO UPDATE SET
         status = 'IN_PROGRESS',
         current_step = EXCLUDED.current_step,
         draft = EXCLUDED.draft
       RETURNING app_slug, status, current_step, draft, completed_at, skipped_at, updated_at`,
      [orgId, appSlug, input.currentStep, JSON.stringify(input.draft)],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('no onboarding row after upsert');
    return toState(row);
  });
}

/** Upsert to SKIPPED, stamping skipped_at = now(). The draft is preserved, never cleared. */
export async function skip(orgId: string, appSlug: OnboardingSlug): Promise<OnboardingState> {
  return withTransaction(async (client) => {
    const from = await currentStatus(client, orgId, appSlug);
    assertTransition(from, 'SKIPPED');

    const { rows } = await client.query<StateRow>(
      `INSERT INTO onboarding_states (org_id, app_slug, status, skipped_at)
       VALUES ($1, $2, 'SKIPPED', now())
       ON CONFLICT (org_id, app_slug) DO UPDATE SET
         status = 'SKIPPED',
         skipped_at = now()
       RETURNING app_slug, status, current_step, draft, completed_at, skipped_at, updated_at`,
      [orgId, appSlug],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('no onboarding row after upsert');
    return toState(row);
  });
}

/** Upsert to IN_PROGRESS, clearing skipped_at. Legal from SKIPPED and from COMPLETED. */
export async function resume(orgId: string, appSlug: OnboardingSlug): Promise<OnboardingState> {
  return withTransaction(async (client) => {
    const from = await currentStatus(client, orgId, appSlug);
    assertTransition(from, 'IN_PROGRESS');

    const { rows } = await client.query<StateRow>(
      `INSERT INTO onboarding_states (org_id, app_slug, status, skipped_at)
       VALUES ($1, $2, 'IN_PROGRESS', NULL)
       ON CONFLICT (org_id, app_slug) DO UPDATE SET
         status = 'IN_PROGRESS',
         skipped_at = NULL
       RETURNING app_slug, status, current_step, draft, completed_at, skipped_at, updated_at`,
      [orgId, appSlug],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('no onboarding row after upsert');
    return toState(row);
  });
}

/**
 * Marks one app's row COMPLETED on a caller-supplied, already-open transaction
 * client. Runs no BEGIN/COMMIT/ROLLBACK — the caller owns the transaction, so
 * LedgerCore's wizard completion and this row commit together (rule 5).
 *
 * No transition check: completion is always legal from every state (an app
 * may be re-onboarded any number of times).
 */
export async function markCompletedOnClient(
  client: PoolClient,
  orgId: string,
  appSlug: OnboardingSlug,
): Promise<void> {
  await client.query(
    `INSERT INTO onboarding_states (org_id, app_slug, status, completed_at, skipped_at)
     VALUES ($1, $2, 'COMPLETED', now(), NULL)
     ON CONFLICT (org_id, app_slug) DO UPDATE SET
       status = 'COMPLETED',
       completed_at = now(),
       skipped_at = NULL`,
    [orgId, appSlug],
  );
}
