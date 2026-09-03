import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

/**
 * LedgerCore — onboarding & settings. Integration tier, real PostgreSQL.
 *
 * Includes this app's own cross-tenant isolation suite (rule 15). Fixture
 * mirrors accounts.test.ts's shape — userA (org A only), userC (org B only),
 * userB (both) — because without the spanning user, "returns nothing to
 * everybody" would pass every isolation assertion trivially.
 */

const app = createApp();
const SETTINGS = '/api/v1/ledger-core/settings';
const ONBOARDING = '/api/v1/ledger-core/settings/onboarding';
const ORGANIZATIONS = '/api/v1/organizations';
const JOURNALS = '/api/v1/ledger-core/journals';

let userA: SeededUser;
let userB: SeededUser;
let userC: SeededUser;
let orgA: string;
let orgB: string;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

/** A minimal, always-valid onboarding payload. Callers override individual fields. */
function onboardingPayload(overrides: Record<string, unknown> = {}) {
  return {
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
    ...overrides,
  };
}

/** Posts a balanced entry via HTTP, matching reports.test.ts's `sale` helper. */
async function postSale(agent: Agent, orgId: string, amountCents = 10000) {
  const res = await agent.post(JOURNALS).send({
    entryDate: '2026-06-01',
    description: 'Fixture sale',
    lines: [
      { accountId: await accountId(orgId, '1110'), debitCents: amountCents, creditCents: 0 },
      { accountId: await accountId(orgId, '4200'), debitCents: 0, creditCents: amountCents },
    ],
  });
  if (res.status !== 201) throw new Error(`fixture: posting failed ${res.status} ${res.text}`);
  return res;
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;

  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bobs Own' });
  await addMember(orgA, userB.id, 'ADMIN');
  await addMember(orgB, userB.id, 'ADMIN');
});

afterAll(closePool);

describe('GET /settings before onboarding', () => {
  it('reports onboardedAt: null with sensible defaults, not a 404', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(SETTINGS);

    expect(res.status).toBe(200);
    expect(res.body.settings.onboardedAt).toBeNull();
    expect(res.body.settings.fiscalYearStartMonth).toBe(1);
    expect(res.body.settings.baseCurrencyLocked).toBe(false);
  });
});

describe('POST /settings/onboarding', () => {
  it('persists organization name, currency and fiscal year', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(ONBOARDING).send(
      onboardingPayload({
        organizationName: 'Acme Books',
        baseCurrency: 'INR',
        fiscalYearStartMonth: 4,
        booksStartDate: '2026-04-01',
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body.settings.onboardedAt).not.toBeNull();
    expect(res.body.settings.currentFiscalYear.startDate).toBe('2026-04-01');
  });

  it('re-reading GET /settings shows the persisted values, including on the organization itself', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(ONBOARDING).send(
      onboardingPayload({ organizationName: 'Acme Books', baseCurrency: 'INR', fiscalYearStartMonth: 4 }),
    );

    const settings = await agent.get(SETTINGS);
    expect(settings.body.settings.organizationName).toBe('Acme Books');
    expect(settings.body.settings.baseCurrency).toBe('INR');

    const org = await agent.get(ORGANIZATIONS);
    expect(org.body.organization.name).toBe('Acme Books');
    expect(org.body.organization.baseCurrency).toBe('INR');
  });

  it('is idempotent — submitting twice overwrites rather than erroring', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(ONBOARDING).send(onboardingPayload({ fiscalYearStartMonth: 4 }));
    const second = await agent.post(ONBOARDING).send(onboardingPayload({ fiscalYearStartMonth: 7 }));

    expect(second.status).toBe(200);
    expect(second.body.settings.fiscalYearStartMonth).toBe(7);
  });

  it('a VIEWER cannot onboard', async () => {
    const viewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await agent.post(ONBOARDING).send(onboardingPayload());
    expect(res.status).toBe(403);
  });

  it('an ACCOUNTANT cannot onboard', async () => {
    const accountant = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann' });
    await addMember(orgA, accountant.id, 'ACCOUNTANT');
    const agent = await loginAgent(app, accountant);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await agent.post(ONBOARDING).send(onboardingPayload());
    expect(res.status).toBe(403);
  });

  it('rejects an unsupported currency at the schema boundary', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(ONBOARDING).send(onboardingPayload({ baseCurrency: 'XYZ' }));
    expect(res.status).toBe(400);
  });

  it('rejects a cash account belonging to another organization with 422, and rolls back the organization rename', async () => {
    const agent = await loginAgent(app, userA);
    const foreignAccount = await accountId(orgB, '1110');

    // This payload's organizationName rename runs (via updateOrganization) BEFORE
    // the ledger_settings INSERT fails on the composite FK — a real mid-transaction
    // failure, not merely a validation error caught before any write. If ROLLBACK
    // did not hold, org A would be silently renamed despite the 422 (rule 5).
    const res = await agent
      .post(ONBOARDING)
      .send(onboardingPayload({ organizationName: 'Should Not Stick', cashAccountId: foreignAccount }));

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/cash account/i);

    const { rows } = await pool.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [
      orgA,
    ]);
    expect(rows[0]?.name).not.toBe('Should Not Stick');
    expect(rows[0]?.name).toBe('Org Alpha');
  });

  describe('the base-currency lock', () => {
    it('refuses a currency change once a journal entry exists', async () => {
      const agent = await loginAgent(app, userA);
      await agent.post(ONBOARDING).send(onboardingPayload({ baseCurrency: 'USD' }));
      await postSale(agent, orgA);

      const res = await agent.post(ONBOARDING).send(onboardingPayload({ baseCurrency: 'INR' }));

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/base currency/i);
    });

    it('allows re-onboarding with the SAME currency once a journal entry exists', async () => {
      const agent = await loginAgent(app, userA);
      await agent.post(ONBOARDING).send(onboardingPayload({ baseCurrency: 'USD' }));
      await postSale(agent, orgA);

      const res = await agent.post(ONBOARDING).send(onboardingPayload({ baseCurrency: 'USD' }));

      expect(res.status).toBe(200);
    });
  });
});

describe('inserting ledger_settings directly with a foreign cash account', () => {
  it('is rejected by the database with a foreign-key violation, not merely by the service', async () => {
    const foreignAccount = await accountId(orgB, '1110');

    await expect(
      pool.query(
        `INSERT INTO ledger_settings (org_id, fiscal_year_start_month, books_start_date, cash_account_id)
         VALUES ($1, 1, '2026-01-01', $2)`,
        [orgA, foreignAccount],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('PATCH /settings', () => {
  it('refuses to write before onboarding has completed once', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(SETTINGS).send({ industry: 'Software' });
    expect(res.status).toBe(409);
  });

  it('rejects an empty body with 400', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(ONBOARDING).send(onboardingPayload());

    const res = await agent.patch(SETTINGS).send({});
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range fiscal month with 400', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(ONBOARDING).send(onboardingPayload());

    const res = await agent.patch(SETTINGS).send({ fiscalYearStartMonth: 13 });
    expect(res.status).toBe(400);
  });

  it('updates the fiscal year start once onboarded', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(ONBOARDING).send(onboardingPayload({ fiscalYearStartMonth: 1 }));

    const res = await agent.patch(SETTINGS).send({ fiscalYearStartMonth: 7 });
    expect(res.status).toBe(200);
    expect(res.body.settings.fiscalYearStartMonth).toBe(7);
  });
});

describe('cross-tenant isolation', () => {
  it("each organization's settings are independent", async () => {
    const agentA = await loginAgent(app, userA);
    await agentA.post(ONBOARDING).send(onboardingPayload({ organizationName: 'Alpha Books' }));

    const agentC = await loginAgent(app, userC);
    await agentC.post(ONBOARDING).send(onboardingPayload({ organizationName: 'Beta Books' }));

    const settingsA = await agentA.get(SETTINGS);
    expect(settingsA.body.settings.organizationName).toBe('Alpha Books');

    const settingsC = await agentC.get(SETTINGS);
    expect(settingsC.body.settings.organizationName).toBe('Beta Books');
  });

  it('a forged orgId in the query string, headers and body is ignored', async () => {
    const agentA = await loginAgent(app, userA);
    await agentA.post(ONBOARDING).send(onboardingPayload({ organizationName: 'Alpha Books' }));

    const honest = await agentA.get(SETTINGS);
    const forged = await agentA
      .get(SETTINGS)
      .query({ orgId: orgB })
      .set('X-Org-Id', orgB)
      .send({ orgId: orgB });

    expect(forged.status).toBe(200);
    expect(forged.body).toEqual(honest.body);
    expect(forged.text).toBe(honest.text);
  });

  it('a user in both tenants sees each organization on switch', async () => {
    const agentB = await loginAgent(app, userB);

    await agentB.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    await agentB.post(ONBOARDING).send(onboardingPayload({ organizationName: 'Alpha Books' }));

    await agentB.post('/api/v1/auth/switch-org').send({ orgId: orgB });
    const inB = await agentB.get(SETTINGS);
    // Org B was never onboarded by this agent, so it must not see org A's name.
    expect(inB.body.settings.organizationName).not.toBe('Alpha Books');

    await agentB.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    const backInA = await agentB.get(SETTINGS);
    expect(backInA.body.settings.organizationName).toBe('Alpha Books');
  });
});
