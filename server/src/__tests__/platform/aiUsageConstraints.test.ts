import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the service — every test here drives
 * raw SQL straight at the pool to prove migration 051's constraints and
 * trigger hold regardless of what wrote the row.
 */

const CHECK_VIOLATION = '23514';
const FEATURE_NOT_SUPPORTED = '0A000';

async function errorCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      return typeof err.code === 'string' ? err.code : undefined;
    }
  }
  return undefined;
}

async function errorConstraint(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'constraint' in err) {
      return typeof err.constraint === 'string' ? err.constraint : undefined;
    }
  }
  return undefined;
}

let userA: SeededUser;
let orgA: string;

/** Inserts one valid ai_model_calls row, raw SQL, returning its id. */
async function insertCall(overrides: Partial<{
  status: string;
  errorCode: string | null;
  costMicroUsd: number | null;
  pricingVersion: string | null;
  entityType: string | null;
  entityId: string | null;
  inputTokens: number;
  purpose: string;
  provider: string;
}> = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ai_model_calls
       (org_id, app_slug, purpose, provider, model, entity_type, entity_id,
        input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, total_tokens,
        cost_micro_usd, pricing_version, status, error_code, latency_ms, created_by)
     VALUES ($1, 'ap-flow', $2, $3, 'claude-sonnet-5', $4, $5, $6, 0, 0, 0, $6,
             $7, $8, $9, $10, 100, $11)
     RETURNING id`,
    [
      orgA,
      overrides.purpose ?? 'EXTRACT',
      overrides.provider ?? 'anthropic',
      overrides.entityType ?? null,
      overrides.entityId ?? null,
      overrides.inputTokens ?? 100,
      overrides.costMicroUsd === undefined ? null : overrides.costMicroUsd,
      overrides.pricingVersion === undefined ? null : overrides.pricingVersion,
      overrides.status ?? 'OK',
      overrides.errorCode === undefined ? null : overrides.errorCode,
      userA.id,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('fixture: no ai_model_calls id');
  return id;
}

describe('ai_model_calls database constraints', () => {
  beforeEach(async () => {
    await resetTables();
    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;
  });

  afterAll(closePool);

  it('an UPDATE on a recorded call is refused', async () => {
    const id = await insertCall();
    const code = await errorCode(() =>
      pool.query('UPDATE ai_model_calls SET model = $1 WHERE id = $2', ['other-model', id]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('a DELETE is allowed so an organization can cascade away', async () => {
    await insertCall();
    await expect(pool.query('DELETE FROM organizations WHERE id = $1', [orgA])).resolves.toBeDefined();
    const { rows } = await pool.query('SELECT 1 FROM ai_model_calls WHERE org_id = $1', [orgA]);
    expect(rows).toHaveLength(0);
  });

  it('a cost without a pricing version is rejected', async () => {
    const constraint = await errorConstraint(() => insertCall({ costMicroUsd: 10, pricingVersion: null }));
    expect(constraint).toBe('chk_ai_model_calls_cost_pair');
  });

  it('a pricing version without a cost is rejected', async () => {
    const constraint = await errorConstraint(() =>
      insertCall({ costMicroUsd: null, pricingVersion: '2026-06-24' }),
    );
    expect(constraint).toBe('chk_ai_model_calls_cost_pair');
  });

  it('an OK row carrying an error code is rejected', async () => {
    const constraint = await errorConstraint(() => insertCall({ status: 'OK', errorCode: '502' }));
    expect(constraint).toBe('chk_ai_model_calls_error');
  });

  it('an ERROR row without an error code is rejected', async () => {
    const constraint = await errorConstraint(() => insertCall({ status: 'ERROR', errorCode: null }));
    expect(constraint).toBe('chk_ai_model_calls_error');
  });

  it('an entity id without an entity type is rejected', async () => {
    const constraint = await errorConstraint(() =>
      insertCall({ entityType: null, entityId: '00000000-0000-0000-0000-000000000001' }),
    );
    expect(constraint).toBe('chk_ai_model_calls_entity_pair');
  });

  it('a negative token count is rejected', async () => {
    const code = await errorCode(() => insertCall({ inputTokens: -1 }));
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('an unknown purpose is rejected', async () => {
    const code = await errorCode(() => insertCall({ purpose: 'SUMMARIZE' }));
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('an unknown provider is rejected', async () => {
    const code = await errorCode(() => insertCall({ provider: 'openai' }));
    expect(code).toBe(CHECK_VIOLATION);
  });
});
