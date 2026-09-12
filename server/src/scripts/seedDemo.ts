import { pool } from '../db/connect.js';
import { env } from '../config/env.js';
import { loadSandbox } from '../services/sandbox/sandboxService.js';
import { ApiError } from '../utils/apiError.js';

/**
 * `npm run seed:demo` — loads the Phase 18 sandbox dataset into an
 * organization from a terminal, mirroring `db/reset.ts`'s posture: an
 * exported function this file's own CLI tail drives, with the identical
 * `env.isProduction` refusal.
 *
 * Direct `pool.query` here is the same sanctioned exception `db/reset.ts`
 * and `scripts/verifyIntegrity.ts` already take — a one-shot operator
 * script, not a request-handling layer, so guardrails rule 2 (no SQL in
 * controllers) does not apply to it.
 *
 * Target organization: `process.argv[2]` as an org name if given, else the
 * single organization in the database. Zero or more than one match with no
 * argument given prints the candidates and exits 1 rather than guessing.
 */

interface OrgCandidate {
  id: string;
  name: string;
}

async function resolveOrg(nameArg: string | undefined): Promise<OrgCandidate> {
  if (nameArg !== undefined) {
    const { rows } = await pool.query<OrgCandidate>('SELECT id, name FROM organizations WHERE name = $1', [
      nameArg,
    ]);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`No organization named "${nameArg}"`);
    }
    return row;
  }

  const { rows } = await pool.query<OrgCandidate>('SELECT id, name FROM organizations ORDER BY created_at ASC');
  if (rows.length === 1) {
    const only = rows[0];
    if (only === undefined) throw new Error('unreachable');
    return only;
  }
  if (rows.length === 0) {
    throw new Error('No organizations exist yet. Register one first.');
  }
  const names = rows.map((r) => `  - ${r.name} (${r.id})`).join('\n');
  throw new Error(`More than one organization exists — name the one to seed:\n${names}`);
}

async function resolveOwner(orgId: string): Promise<string> {
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM organization_members WHERE org_id = $1 AND role = 'OWNER' ORDER BY created_at ASC LIMIT 1`,
    [orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`Organization ${orgId} has no OWNER member`);
  return row.user_id;
}

async function main(): Promise<void> {
  if (env.isProduction) {
    throw new Error('seed:demo refuses to run with NODE_ENV=production');
  }

  const org = await resolveOrg(process.argv[2]);
  const ownerId = await resolveOwner(org.id);

  console.log(`[seed:demo] loading the sandbox dataset into "${org.name}" (${org.id})`);
  const dataset = await loadSandbox(org.id, ownerId);

  console.log(`[seed:demo] loaded dataset ${dataset.datasetVersion}, anchored at ${dataset.anchorMonth}`);
  for (const [key, value] of Object.entries(dataset.counts)) {
    console.log(`  ${key}: ${String(value)}`);
  }
}

try {
  await main();
  await pool.end();
  process.exit(0);
} catch (err) {
  if (err instanceof ApiError) {
    console.error(`[seed:demo] ${err.message}`);
  } else {
    console.error('[seed:demo] failed:', err instanceof Error ? err.message : err);
  }
  await pool.end();
  process.exit(1);
}
