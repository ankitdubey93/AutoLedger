import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * StockLedger (Phase 28) — setup: choosing and applying an industry
 * profile. Integration tier, real PostgreSQL. Includes this module's
 * cross-tenant isolation suite (rule 15) and an injected-failure rollback
 * case (rule 5).
 */

const app = createApp();
const SETTINGS = '/api/v1/stock/settings';
const PROFILES = '/api/v1/stock/setup/profiles';
const SETUP = '/api/v1/stock/setup';
const LEDGER_ONBOARDING = '/api/v1/ledger-core/settings/onboarding';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

/** Selects `targetOrgId` as the agent's active org — needed for a user who belongs to several. */
async function switchTo(agent: Agent, targetOrgId: string): Promise<Agent> {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

/** A minimal, always-valid LedgerCore onboarding payload, mirroring ledger-core/settings.test.ts. */
function ledgerOnboardingPayload(overrides: Record<string, unknown> = {}) {
  return {
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
    ...overrides,
  };
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
});

afterAll(closePool);

describe('GET /stock/settings', () => {
  it('before setup is unconfigured and suggests GENERAL', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(SETTINGS);

    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      configured: false,
      defaultLocationId: null,
      industryProfile: null,
      suggestedProfile: 'GENERAL',
      updatedAt: null,
    });
  });

  it('suggests from the LedgerCore industry', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(LEDGER_ONBOARDING).send(ledgerOnboardingPayload({ industry: 'Steel fabrication' }));

    const res = await agent.get(SETTINGS);
    expect(res.body.settings.suggestedProfile).toBe('MANUFACTURING');
  });

  it('VIEWER can read settings', async () => {
    const viewer = await createUserWithOrg({ label: 'viewer', orgName: 'Org Viewer' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await switchTo(agent, orgA);

    const res = await agent.get(SETTINGS);
    expect(res.status).toBe(200);
  });
});

describe('GET /stock/setup/profiles', () => {
  it('lists ten profiles with examples', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(PROFILES);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(10);

    const realEstate = res.body.profiles.find((p: { key: string }) => p.key === 'REAL_ESTATE');
    expect(realEstate).toBeDefined();
    const defaultScheme = realEstate.codeSchemes.find((s: { isDefault: boolean }) => s.isDefault);
    expect(defaultScheme.example).toBe('RES-0001');
  });
});

describe('POST /stock/setup', () => {
  it('applies REAL_ESTATE', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(SETUP).send({ industryProfile: 'REAL_ESTATE' });

    expect(res.status).toBe(200);
    expect(res.body.created.categories).toBe(4);
    expect(res.body.settings.industryProfile).toBe('REAL_ESTATE');
    expect(res.body.settings.configured).toBe(true);

    const { rows: categories } = await pool.query<{ code: string }>(
      'SELECT code FROM stock_categories WHERE org_id = $1 ORDER BY code',
      [orgA],
    );
    expect(categories.map((r) => r.code)).toEqual(['COM', 'MAT', 'PLT', 'RES']);

    const { rows: locations } = await pool.query<{ code: string }>(
      'SELECT code FROM stock_locations WHERE org_id = $1',
      [orgA],
    );
    expect(locations.map((r) => r.code)).toEqual(['SITE-1']);

    const { rows: schemes } = await pool.query<{ pattern: string }>(
      'SELECT pattern FROM stock_code_schemes WHERE org_id = $1 AND is_default',
      [orgA],
    );
    expect(schemes).toHaveLength(1);
    expect(schemes[0]?.pattern).toBe('{CAT}-{SEQ:4}');

    const { rows: onboarding } = await pool.query<{ status: string }>(
      "SELECT status FROM onboarding_states WHERE org_id = $1 AND app_slug = 'stock'",
      [orgA],
    );
    expect(onboarding[0]?.status).toBe('COMPLETED');
  });

  it('applying twice is idempotent', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(SETUP).send({ industryProfile: 'REAL_ESTATE' });

    const before = await pool.query<{ count: string }>('SELECT count(*) FROM stock_categories WHERE org_id = $1', [orgA]);

    const res = await agent.post(SETUP).send({ industryProfile: 'REAL_ESTATE' });
    expect(res.status).toBe(200);
    expect(res.body.created).toEqual({ uoms: 0, categories: 0, attributes: 0, codeSchemes: 0, locations: 0 });

    const after = await pool.query<{ count: string }>('SELECT count(*) FROM stock_categories WHERE org_id = $1', [orgA]);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('switching profile adds and never removes', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(SETUP).send({ industryProfile: 'GENERAL' });
    await agent.post(SETUP).send({ industryProfile: 'MANUFACTURING' });

    const { rows } = await pool.query<{ code: string }>(
      'SELECT code FROM stock_categories WHERE org_id = $1 ORDER BY code',
      [orgA],
    );
    const codes = rows.map((r) => r.code);
    expect(codes).toContain('GEN');
    expect(codes).toContain('RM');

    const { rows: defaultScheme } = await pool.query<{ pattern: string }>(
      'SELECT pattern FROM stock_code_schemes WHERE org_id = $1 AND is_default',
      [orgA],
    );
    expect(defaultScheme).toHaveLength(1);
    expect(defaultScheme[0]?.pattern).toBe('{CAT}-{SEQ:5}');
  });

  it('rejects an unknown profile', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(SETUP).send({ industryProfile: 'FOO' });
    expect(res.status).toBe(400);
  });

  it('ACCOUNTANT cannot apply', async () => {
    const accountant = await createUserWithOrg({ label: 'accountant', orgName: 'Org Accountant' });
    await addMember(orgA, accountant.id, 'ACCOUNTANT');
    const agent = await loginAgent(app, accountant);
    await switchTo(agent, orgA);

    const res = await agent.post(SETUP).send({ industryProfile: 'GENERAL' });
    expect(res.status).toBe(403);
  });

  it('applying in org A creates nothing in org B', async () => {
    const agentA = await loginAgent(app, userA);
    await agentA.post(SETUP).send({ industryProfile: 'REAL_ESTATE' });

    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM stock_categories WHERE org_id = $1', [orgB]);
    expect(rows[0]?.count).toBe('0');

    const agentB = await loginAgent(app, userB);
    const res = await agentB.get(SETTINGS);
    expect(res.body.settings.configured).toBe(false);
  });

  it('a failure mid-apply rolls back everything', async () => {
    await pool.query("ALTER TABLE stock_locations ADD CONSTRAINT tmp_block_site CHECK (code <> 'SITE-1')");
    try {
      const agent = await loginAgent(app, userA);
      const res = await agent.post(SETUP).send({ industryProfile: 'REAL_ESTATE' });
      expect(res.status).toBe(500);

      const counts = await Promise.all(
        [
          'stock_settings',
          'stock_uoms',
          'stock_categories',
          'stock_attribute_definitions',
          'stock_code_schemes',
        ].map((table) => pool.query<{ count: string }>(`SELECT count(*) FROM ${table} WHERE org_id = $1`, [orgA])),
      );
      for (const result of counts) {
        expect(result.rows[0]?.count).toBe('0');
      }

      const { rows: onboarding } = await pool.query(
        "SELECT 1 FROM onboarding_states WHERE org_id = $1 AND app_slug = 'stock'",
        [orgA],
      );
      expect(onboarding).toHaveLength(0);
    } finally {
      await pool.query('ALTER TABLE stock_locations DROP CONSTRAINT IF EXISTS tmp_block_site');
    }
  });
});
