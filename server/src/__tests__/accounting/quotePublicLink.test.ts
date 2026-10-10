import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, type Agent } from '../helpers/accountingFixtures.js';
import { latestEmailToken, outboxFor } from '../helpers/email.js';

/**
 * Phase 41 — the emailed quote link. No session: the token is the only
 * credential, so these requests go through a bare `request(app)`, never a
 * signed-in agent.
 *
 * The central claims: the page shows the frozen quote and nothing internal;
 * an unknown, revoked or superseded token is one indistinguishable 404;
 * accepting requires a typed name, ticked terms and the hash of what was
 * shown, and records IP and user agent as evidence; an expired quote, a
 * changed quote, or a second answer is refused.
 */

const app = createApp();
const QUOTES = '/api/v1/quotes';
const PUBLIC = '/api/v1/public/quotes';
const BUYER = 'buyer@acme.test';
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

let user: SeededUser;
let agent: Agent;
let customerId: string;

async function emailedQuote(validUntil = isoDaysFromNow(30)): Promise<{ id: string; token: string }> {
  const created = await agent.post(QUOTES).send({
    partyId: customerId,
    quoteDate: isoDaysFromNow(0),
    validUntil,
    title: 'Fit-out',
    terms: 'Payment 50% on acceptance.',
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
  return { id, token: await latestEmailToken(BUYER, 'quote_sent') };
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  agent = await loginAgent(app, user);
  customerId = await createCustomer(agent, 'Acme Fitouts', BUYER);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(closePool);

describe('public quote page', () => {
  it('shows the frozen quote with no session, never cached, and records the view', async () => {
    const { id, token } = await emailedQuote();
    const res = await request(app).get(`${PUBLIC}/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.quote).toMatchObject({
      quoteNumber: 'QU-000001',
      merchant: { name: 'Org Alpha' },
      partyName: 'Acme Fitouts',
      effectiveStatus: 'SENT',
      canRespond: true,
      totalCents: 55000,
      terms: 'Payment 50% on acceptance.',
    });
    // Nothing internal: no account ids on lines, no ids, no evidence detail.
    expect(res.body.quote.lines[0]).not.toHaveProperty('accountId');
    expect(res.body.quote).not.toHaveProperty('id');
    const { rows } = await pool.query<{ last_viewed_at: Date | null }>(
      'SELECT last_viewed_at FROM quote_links WHERE quote_id = $1',
      [id],
    );
    expect(rows[0]!.last_viewed_at).not.toBeNull();
  });

  it('an unknown, malformed or revoked token is the same 404', async () => {
    const { id, token } = await emailedQuote();
    const unknown = await request(app).get(`${PUBLIC}/${'x'.repeat(43)}`);
    const malformed = await request(app).get(`${PUBLIC}/short`);
    const linkId = (await agent.get(`${QUOTES}/${id}`)).body.quote.links[0].id as string;
    expect((await agent.post(`${QUOTES}/${id}/links/${linkId}/revoke`).send({})).status).toBe(200);
    const revoked = await request(app).get(`${PUBLIC}/${token}`);
    for (const res of [unknown, malformed, revoked]) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('This quote link is not valid or has expired');
    }
  });

  it('the old link stops working once a revision is sent', async () => {
    const { id, token } = await emailedQuote();
    const revisionId = (await agent.post(`${QUOTES}/${id}/revise`).send({})).body.quote.id as string;
    await agent.post(`${QUOTES}/${revisionId}/send`).send({ delivery: 'EMAIL', toEmail: BUYER });
    expect((await request(app).get(`${PUBLIC}/${token}`)).status).toBe(404);
    const newToken = await latestEmailToken(BUYER, 'quote_sent');
    expect((await request(app).get(`${PUBLIC}/${newToken}`)).body.quote).toMatchObject({ revision: 2 });
  });
});

describe('public accept / decline', () => {
  it('accepting records the signer, terms, IP, user agent and content hash', async () => {
    const { id, token } = await emailedQuote();
    const view = (await request(app).get(`${PUBLIC}/${token}`)).body.quote;
    const res = await request(app)
      .post(`${PUBLIC}/${token}/accept`)
      .set('User-Agent', 'QuoteTest/1.0')
      .send({ signerName: '  Jane Doe ', signerEmail: 'Jane@Acme.test', acceptTerms: true, contentSha256: view.contentSha256 });
    expect(res.status).toBe(200);
    expect(res.body.quote).toMatchObject({
      effectiveStatus: 'ACCEPTED',
      canRespond: false,
      response: { response: 'ACCEPTED', signerName: 'Jane Doe' },
    });
    // The public view never echoes evidence detail back.
    expect(res.body.quote.response).not.toHaveProperty('clientIp');

    const internal = (await agent.get(`${QUOTES}/${id}`)).body.quote;
    expect(internal.status).toBe('ACCEPTED');
    expect(internal.response).toMatchObject({
      channel: 'PUBLIC_LINK',
      signerName: 'Jane Doe',
      signerEmail: 'jane@acme.test',
      termsAccepted: true,
      userAgent: 'QuoteTest/1.0',
      quoteContentSha256: view.contentSha256,
      recordedBy: null,
    });
    expect(internal.response.clientIp).not.toBeNull();

    // The sender is told.
    expect(await outboxFor(user.email, 'quote_responded')).toHaveLength(1);
  });

  it('refuses an acceptance without ticked terms or a name', async () => {
    const { token } = await emailedQuote();
    const view = (await request(app).get(`${PUBLIC}/${token}`)).body.quote;
    const noTerms = await request(app)
      .post(`${PUBLIC}/${token}/accept`)
      .send({ signerName: 'Jane', acceptTerms: false, contentSha256: view.contentSha256 });
    const noName = await request(app)
      .post(`${PUBLIC}/${token}/accept`)
      .send({ signerName: '   ', acceptTerms: true, contentSha256: view.contentSha256 });
    expect(noTerms.status).toBe(400);
    expect(noName.status).toBe(400);
  });

  it('refuses an acceptance of content other than what the quote now holds', async () => {
    const { token } = await emailedQuote();
    const res = await request(app)
      .post(`${PUBLIC}/${token}/accept`)
      .send({ signerName: 'Jane', acceptTerms: true, contentSha256: 'b'.repeat(64) });
    expect(res.status).toBe(409);
  });

  it('refuses an acceptance after the validity date, while the page still shows the quote', async () => {
    const { token } = await emailedQuote(isoDaysFromNow(0));
    const view = (await request(app).get(`${PUBLIC}/${token}`)).body.quote;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    const page = await request(app).get(`${PUBLIC}/${token}`);
    expect(page.status).toBe(200);
    expect(page.body.quote).toMatchObject({ effectiveStatus: 'EXPIRED', canRespond: false });
    const res = await request(app)
      .post(`${PUBLIC}/${token}/accept`)
      .send({ signerName: 'Jane', acceptTerms: true, contentSha256: view.contentSha256 });
    expect(res.status).toBe(409);
  });

  it('declining with a reason; then the quote cannot be accepted', async () => {
    const { id, token } = await emailedQuote();
    const view = (await request(app).get(`${PUBLIC}/${token}`)).body.quote;
    const res = await request(app).post(`${PUBLIC}/${token}/decline`).send({ reason: 'Over budget' });
    expect(res.status).toBe(200);
    expect(res.body.quote.effectiveStatus).toBe('DECLINED');
    expect((await agent.get(`${QUOTES}/${id}`)).body.quote.response).toMatchObject({
      response: 'DECLINED',
      declineReason: 'Over budget',
    });
    const accept = await request(app)
      .post(`${PUBLIC}/${token}/accept`)
      .send({ signerName: 'Jane', acceptTerms: true, contentSha256: view.contentSha256 });
    expect(accept.status).toBe(409);
  });

  it('two simultaneous responses: exactly one wins', async () => {
    const { id, token } = await emailedQuote();
    const view = (await request(app).get(`${PUBLIC}/${token}`)).body.quote;
    const [a, b] = await Promise.all([
      request(app)
        .post(`${PUBLIC}/${token}/accept`)
        .send({ signerName: 'Jane', acceptTerms: true, contentSha256: view.contentSha256 }),
      request(app).post(`${PUBLIC}/${token}/decline`).send({ reason: null }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const { rows } = await pool.query('SELECT 1 FROM quote_responses WHERE quote_id = $1', [id]);
    expect(rows).toHaveLength(1);
  });
});

describe('public quote link — cross-tenant isolation', () => {
  it("a token for org A's quote never exposes or touches org B's data", async () => {
    const userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    const { token } = await emailedQuote();
    const res = await request(app).get(`${PUBLIC}/${token}`);
    expect(res.body.quote.merchant.name).toBe('Org Alpha');
    expect(JSON.stringify(res.body)).not.toContain('Org Bravo');
    const { rows } = await pool.query('SELECT 1 FROM quote_responses WHERE org_id = $1', [userB.orgId]);
    expect(rows).toHaveLength(0);
  });
});
