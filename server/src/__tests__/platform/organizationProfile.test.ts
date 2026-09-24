import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Organization profile (Phase 30) — GET/PATCH /organizations/profile and the
 * legalName/industry move off ledger_settings. Integration tier, real
 * PostgreSQL. Includes this module's own cross-tenant isolation suite (rule 15).
 */

const app = createApp();
const PROFILE = '/api/v1/organizations/profile';
const LC_SETTINGS = '/api/v1/ledger-core/settings';
const ONBOARDING = '/api/v1/ledger-core/settings/onboarding';

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;
let orgB: string;

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

/** Inserts a vault document row for `orgId`, raw SQL, and returns its id. */
async function seedDocument(orgId: string, uploadedBy: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
     VALUES ($1, $2, 10, 'image/png', 'logo.png', $3)
     RETURNING id`,
    [orgId, 'b'.repeat(64), uploadedBy],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('fixture: no document id');
  return id;
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;
});

afterAll(closePool);

describe('GET /organizations/profile', () => {
  it('before any write returns defaults with configured: false, not 404', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(PROFILE);

    expect(res.status).toBe(200);
    expect(res.body.profile.configured).toBe(false);
    expect(res.body.profile.city).toBeNull();
    expect(res.body.profile.postalSameAsStreet).toBe(true);
  });

  it('requires a session', async () => {
    const res = await request(app).get(PROFILE);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /organizations/profile', () => {
  it('creates the row, uppercases the country code and returns configured: true', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(PROFILE).send({ city: 'Mumbai', countryCode: 'in' });

    expect(res.status).toBe(200);
    expect(res.body.profile.city).toBe('Mumbai');
    expect(res.body.profile.countryCode).toBe('IN');
    expect(res.body.profile.configured).toBe(true);

    const follow = await agent.get(PROFILE);
    expect(follow.body.profile.city).toBe('Mumbai');
    expect(follow.body.profile.countryCode).toBe('IN');
  });

  it('lowercases contactEmail on write (rule 9)', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(PROFILE).send({ contactEmail: 'Billing@Example.COM' });

    expect(res.status).toBe(200);
    expect(res.body.profile.contactEmail).toBe('billing@example.com');
  });

  it('rejects an empty body with 400', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(PROFILE).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No fields to update');
  });

  it('rejects a three-letter country code with 400', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(PROFILE).send({ countryCode: 'IND' });

    expect(res.status).toBe(400);
  });

  it('a VIEWER cannot edit the profile but can read it', async () => {
    const viewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const patch = await agent.patch(PROFILE).send({ city: 'Mumbai' });
    expect(patch.status).toBe(403);

    const get = await agent.get(PROFILE);
    expect(get.status).toBe(200);
  });

  it("rejects another org's logo document id with 422", async () => {
    const docOfB = await seedDocument(orgB, userC.id);
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(PROFILE).send({ logoDocumentId: docOfB });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Logo document does not exist in this organization');
  });

  it("accepts the caller's own logo document id", async () => {
    const docOfA = await seedDocument(orgA, userA.id);
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(PROFILE).send({ logoDocumentId: docOfA });

    expect(res.status).toBe(200);
    expect(res.body.profile.logoDocumentId).toBe(docOfA);
  });
});

describe('organization profile — cross-tenant isolation', () => {
  it("org B never sees org A's profile", async () => {
    const agentA = await loginAgent(app, userA);
    const write = await agentA.patch(PROFILE).send({ city: 'Mumbai' });
    expect(write.status).toBe(200);

    const agentB = await loginAgent(app, userC);
    const res = await agentB.get(PROFILE);

    expect(res.status).toBe(200);
    expect(res.body.profile.city).toBeNull();
    expect(res.body.profile.configured).toBe(false);
    expect(res.text).not.toContain('Mumbai');
  });

  it("org B's write does not touch org A's profile", async () => {
    const agentA = await loginAgent(app, userA);
    await agentA.patch(PROFILE).send({ city: 'Mumbai' });

    const agentB = await loginAgent(app, userC);
    await agentB.patch(PROFILE).send({ city: 'Lisbon' });

    const res = await agentA.get(PROFILE);
    expect(res.body.profile.city).toBe('Mumbai');
  });

  it('ignores orgId in the query string, headers and body', async () => {
    const agentB = await loginAgent(app, userC);
    await agentB.patch(PROFILE).send({ city: 'Lisbon' });

    const agent = await loginAgent(app, userA);
    await agent.patch(PROFILE).send({ city: 'Mumbai' });

    const honest = await agent.get(PROFILE);
    const forged = await agent
      .get(PROFILE)
      .query({ orgId: orgB })
      .set('X-Org-Id', orgB)
      .send({ orgId: orgB });

    expect(forged.status).toBe(200);
    // Byte-identical: none of those three inputs is even consulted.
    expect(forged.text).toBe(honest.text);
    expect(forged.body.profile.city).toBe('Mumbai');
    expect(forged.text).not.toContain('Lisbon');
  });
});

describe('legalName and industry live on the profile (Step 5)', () => {
  it('a profile legalName is read back by GET /ledger-core/settings', async () => {
    const agent = await loginAgent(app, userA);
    const patch = await agent.patch(PROFILE).send({ legalName: 'Harbor Point Fabrication Pty Ltd' });
    expect(patch.status).toBe(200);

    const res = await agent.get(LC_SETTINGS);
    expect(res.status).toBe(200);
    expect(res.body.settings.legalName).toBe('Harbor Point Fabrication Pty Ltd');
  });

  it("onboarding with legalName '' returns 200 and reads back null on the profile", async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(ONBOARDING).send(onboardingPayload({ legalName: '' }));
    expect(res.status).toBe(200);

    const profile = await agent.get(PROFILE);
    expect(profile.status).toBe(200);
    expect(profile.body.profile.legalName).toBeNull();
  });

  it('onboarding writes legalName and industry to the profile', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent
      .post(ONBOARDING)
      .send(onboardingPayload({ legalName: 'Acme Books Ltd', industry: 'Retail' }));
    expect(res.status).toBe(200);

    const profile = await agent.get(PROFILE);
    expect(profile.body.profile.legalName).toBe('Acme Books Ltd');
    expect(profile.body.profile.industry).toBe('Retail');
    expect(profile.body.profile.configured).toBe(true);
  });

  it('a profile-only PATCH /ledger-core/settings before onboarding is 409 and writes nothing', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(LC_SETTINGS).send({ legalName: 'X' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Complete LedgerCore onboarding before changing settings');

    const profile = await agent.get(PROFILE);
    expect(profile.body.profile.configured).toBe(false);
    expect(profile.body.profile.legalName).toBeNull();
  });

  it('a mixed PATCH /ledger-core/settings before onboarding is 409 and rolls back the profile write', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(LC_SETTINGS).send({ legalName: 'X', timezone: 'UTC' });

    expect(res.status).toBe(409);

    const profile = await agent.get(PROFILE);
    expect(profile.body.profile.configured).toBe(false);
    expect(profile.body.profile.legalName).toBeNull();
  });

  it('an industry PATCH after onboarding round-trips to the profile', async () => {
    const agent = await loginAgent(app, userA);
    const onboard = await agent.post(ONBOARDING).send(onboardingPayload());
    expect(onboard.status).toBe(200);

    const res = await agent.patch(LC_SETTINGS).send({ industry: 'Software' });
    expect(res.status).toBe(200);
    expect(res.body.settings.industry).toBe('Software');

    const profile = await agent.get(PROFILE);
    expect(profile.body.profile.industry).toBe('Software');
  });
});
