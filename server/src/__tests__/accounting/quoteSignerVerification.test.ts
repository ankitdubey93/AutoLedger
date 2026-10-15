import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, type Agent } from '../helpers/accountingFixtures.js';
import { latestEmailToken, outboxFor } from '../helpers/email.js';

/**
 * Phase 42 (Slice D) — verified-email acceptance. When the org turns the
 * setting on, a signer must prove control of the address they typed with a
 * 6-digit code before the acceptance is recorded. The claims: the code is
 * single-use, bound to the link and to the email, capped in attempts and in
 * requests per hour, expires, and is stored only as a hash.
 */

const app = createApp();
const QUOTES = '/api/v1/quotes';
const PUBLIC = '/api/v1/public/quotes';
const BUYER = 'buyer@acme.test';
const JANE = 'jane@x.test';
const BOB = 'bob@x.test';

let user: SeededUser;
let agent: Agent;
let customerId: string;

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

async function emailedQuote(): Promise<{ id: string; token: string; hash: string }> {
  const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const created = await agent.post(QUOTES).send({
    partyId: customerId,
    quoteDate: isoToday(),
    validUntil,
    title: 'Fit-out',
    lines: [
      {
        description: 'Installation',
        quantityMilli: 1000,
        unitPriceCents: 50000,
        accountId: await accountId(user.orgId, '4100'),
        taxRateBp: 1000,
      },
    ],
  });
  if (created.status !== 201) throw new Error(`fixture: ${created.status} ${created.text}`);
  const id = created.body.quote.id as string;
  const sent = await agent.post(`${QUOTES}/${id}/send`).send({ delivery: 'EMAIL', toEmail: BUYER });
  if (sent.status !== 200) throw new Error(`fixture: ${sent.status} ${sent.text}`);
  const token = await latestEmailToken(BUYER, 'quote_sent');
  const view = (await request(app).get(`${PUBLIC}/${token}`)).body.quote;
  return { id, token, hash: view.contentSha256 as string };
}

async function requireCode(on: boolean): Promise<void> {
  const res = await agent.patch('/api/v1/settings/invoicing').send({ quoteAcceptanceRequiresCode: on });
  if (res.status !== 200) throw new Error(`fixture: ${res.status} ${res.text}`);
}

async function requestCode(token: string, email: string): Promise<request.Response> {
  return request(app).post(`${PUBLIC}/${token}/verify-email`).send({ signerEmail: email });
}

/** The code in the newest `quote_acceptance_code` email to `email`. */
async function emailedCode(email: string): Promise<string> {
  const rows = await outboxFor(email, 'quote_acceptance_code');
  const row = rows[rows.length - 1];
  if (row === undefined) throw new Error(`no code emailed to ${email}`);
  return row.template_data.code as string;
}

function accept(token: string, hash: string, email: string | null, code: string | null): request.Test {
  return request(app)
    .post(`${PUBLIC}/${token}/accept`)
    .send({ signerName: 'Jane Doe', signerEmail: email, acceptTerms: true, contentSha256: hash, code });
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  agent = await loginAgent(app, user);
  customerId = await createCustomer(agent, 'Acme Fitouts', BUYER);
});

afterAll(closePool);

describe('verified-email acceptance', () => {
  it('the public view says requiresEmailCode: true', async () => {
    const { token } = await emailedQuote();
    expect((await request(app).get(`${PUBLIC}/${token}`)).body.quote.requiresEmailCode).toBe(false);
    await requireCode(true);
    expect((await request(app).get(`${PUBLIC}/${token}`)).body.quote.requiresEmailCode).toBe(true);
  });

  it('accept without a code → 422 Enter the verification code we emailed you', async () => {
    await requireCode(true);
    const { token, hash } = await emailedQuote();
    const res = await accept(token, hash, JANE, null);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Enter the verification code we emailed you');
  });

  it('verify-email sends a 6-digit code; accept with it → 200 and signerEmailVerified: true', async () => {
    await requireCode(true);
    const { id, token, hash } = await emailedQuote();
    const asked = await requestCode(token, JANE);
    expect(asked.status).toBe(202);
    expect(asked.headers['cache-control']).toBe('no-store');
    const rows = await outboxFor(JANE, 'quote_acceptance_code');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.template_data.code).toMatch(/^\d{6}$/);
    expect(rows[0]!.template_data.quoteNumber).toBe('QU-000001');

    const res = await accept(token, hash, JANE, await emailedCode(JANE));
    expect(res.status).toBe(200);
    expect(res.body.quote.effectiveStatus).toBe('ACCEPTED');
    const internal = (await agent.get(`${QUOTES}/${id}`)).body.quote;
    expect(internal.response).toMatchObject({ signerEmail: JANE, signerEmailVerified: true });
  });

  it('a wrong code → 422; after 5 wrong codes the right one → 422 Too many attempts', async () => {
    await requireCode(true);
    const { token, hash } = await emailedQuote();
    await requestCode(token, JANE);
    const right = await emailedCode(JANE);
    const wrong = right === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i += 1) {
      const res = await accept(token, hash, JANE, wrong);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('That code is not correct');
    }
    const res = await accept(token, hash, JANE, right);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Too many attempts — request a new code');
  });

  it('a code for jane is not valid for bob → 422 Request a new verification code', async () => {
    await requireCode(true);
    const { token, hash } = await emailedQuote();
    await requestCode(token, JANE);
    const res = await accept(token, hash, BOB, await emailedCode(JANE));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Request a new verification code');
  });

  it('an expired code → 422 Request a new verification code', async () => {
    await requireCode(true);
    const { token, hash } = await emailedQuote();
    await requestCode(token, JANE);
    const code = await emailedCode(JANE);
    // Expiry is judged by the database clock (now()), which a faked JS Date cannot move,
    // so age the row eleven minutes instead — the same state 11 minutes of waiting leaves.
    await pool.query(
      `UPDATE quote_acceptance_codes
          SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'
        WHERE org_id = $1`,
      [user.orgId],
    );
    const res = await accept(token, hash, JANE, code);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Request a new verification code');
  });

  it('the 6th code request within an hour → 429', async () => {
    await requireCode(true);
    const { token } = await emailedQuote();
    for (let i = 0; i < 5; i += 1) expect((await requestCode(token, JANE)).status).toBe(202);
    const sixth = await requestCode(token, JANE);
    expect(sixth.status).toBe(429);
    expect(await outboxFor(JANE, 'quote_acceptance_code')).toHaveLength(5);
  });

  it('setting off: accept without a code still works and records signerEmailVerified: false', async () => {
    const { id, token, hash } = await emailedQuote();
    const res = await accept(token, hash, JANE, null);
    expect(res.status).toBe(200);
    const internal = (await agent.get(`${QUOTES}/${id}`)).body.quote;
    expect(internal.response).toMatchObject({ signerEmail: JANE, signerEmailVerified: false });
  });

  it('the code table stores only a 64-hex hash — the plain code is absent from quote_acceptance_codes', async () => {
    await requireCode(true);
    const { token } = await emailedQuote();
    await requestCode(token, JANE);
    const code = await emailedCode(JANE);
    const { rows } = await pool.query<{ code_hash: string }>(
      'SELECT code_hash FROM quote_acceptance_codes WHERE org_id = $1',
      [user.orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.code_hash).not.toBe(code);
    // The only secret-bearing column is the hash: no column stores the plain code.
    const { rows: cols } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'quote_acceptance_codes'`,
    );
    expect(cols.map((c) => c.column_name).filter((n) => n.includes('code'))).toEqual(['code_hash']);
  });
});
