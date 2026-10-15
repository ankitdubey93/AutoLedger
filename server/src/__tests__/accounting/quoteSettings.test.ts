import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, type Agent } from '../helpers/accountingFixtures.js';

/**
 * Phase 42 slice A — the quote settings (prefixes, next numbers, default
 * validity and terms) are editable through PATCH /settings/invoicing and
 * actually drive new quotes. Integration tier, real PostgreSQL.
 */

const app = createApp();
const SETTINGS = '/api/v1/settings/invoicing';
const QUOTES = '/api/v1/quotes';
const PURCHASE_QUOTES = '/api/v1/purchase-quotes';

const DAY_MS = 24 * 60 * 60 * 1000;
function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}
const TODAY = isoDaysFromNow(0);

let userA: SeededUser;
let userB: SeededUser;
let agentA: Agent;
let agentB: Agent;
let customerA: string;
let vendorA: string;

async function line(orgId: string, code: string) {
  return {
    description: 'Work',
    quantityMilli: 1000,
    unitPriceCents: 10000,
    accountId: await accountId(orgId, code),
    taxRateBp: 0,
  };
}

async function salesPayload(extra: Record<string, unknown> = {}) {
  return { partyId: customerA, quoteDate: TODAY, lines: [await line(userA.orgId, '4100')], ...extra };
}

async function purchasePayload(extra: Record<string, unknown> = {}) {
  return { partyId: vendorA, quoteDate: TODAY, lines: [await line(userA.orgId, '6130')], ...extra };
}

async function createDraft(base: string, payload: object): Promise<{ id: string; quote: Record<string, unknown> }> {
  const res = await agentA.post(base).send(payload);
  if (res.status !== 201) throw new Error(`fixture: quote create failed ${res.status} ${res.text}`);
  return { id: res.body.quote.id as string, quote: res.body.quote as Record<string, unknown> };
}

async function send(base: string, id: string) {
  return agentA.post(`${base}/${id}/send`).send({ delivery: 'MANUAL' });
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  customerA = await createCustomer(agentA, 'Acme Fitouts', 'buyer@acme.test');
  const v = await agentA.post('/api/v1/vendors').send({ name: 'Steel Co', email: 'sales@steel.test' });
  if (v.status !== 201) throw new Error(`fixture: vendor create failed ${v.status} ${v.text}`);
  vendorA = v.body.vendor.id as string;
});

afterAll(closePool);

describe('quote settings', () => {
  it('PATCH /settings/invoicing quotePrefix "EST-" → the next sent quote is EST-000001', async () => {
    const patch = await agentA.patch(SETTINGS).send({ quotePrefix: 'EST-' });
    expect(patch.status).toBe(200);
    expect(patch.body.invoiceSettings.quotePrefix).toBe('EST-');
    const { id } = await createDraft(QUOTES, await salesPayload());
    const sent = await send(QUOTES, id);
    expect(sent.status).toBe(200);
    expect(sent.body.quote.quoteNumber).toBe('EST-000001');
  });

  it('purchaseQuotePrefix "RFQ-" → the next sent purchase quote is RFQ-000001', async () => {
    const patch = await agentA.patch(SETTINGS).send({ purchaseQuotePrefix: 'RFQ-' });
    expect(patch.status).toBe(200);
    const { id } = await createDraft(PURCHASE_QUOTES, await purchasePayload());
    const sent = await send(PURCHASE_QUOTES, id);
    expect(sent.status).toBe(200);
    expect(sent.body.quote.quoteNumber).toBe('RFQ-000001');
  });

  it('defaultQuoteValidityDays 14 → a quote created without validUntil is valid until quoteDate + 14', async () => {
    expect((await agentA.patch(SETTINGS).send({ defaultQuoteValidityDays: 14 })).status).toBe(200);
    const { quote } = await createDraft(QUOTES, await salesPayload());
    expect(quote.validUntil).toBe(isoDaysFromNow(14));
  });

  it('defaultQuoteTerms set → a new quote without terms gets them; one with terms: null keeps null', async () => {
    const patch = await agentA.patch(SETTINGS).send({ defaultQuoteTerms: 'Net 14, 50% deposit.' });
    expect(patch.status).toBe(200);
    expect(patch.body.invoiceSettings.defaultQuoteTerms).toBe('Net 14, 50% deposit.');
    const inherited = await createDraft(QUOTES, await salesPayload());
    expect(inherited.quote.terms).toBe('Net 14, 50% deposit.');
    const explicitNull = await createDraft(QUOTES, await salesPayload({ terms: null }));
    expect(explicitNull.quote.terms).toBeNull();
  });

  it('quoteNextNumber reset to 1 after QU-000001 was sent → sending another quote is 409 with the collision message', async () => {
    const first = await createDraft(QUOTES, await salesPayload());
    const sentFirst = await send(QUOTES, first.id);
    expect(sentFirst.body.quote.quoteNumber).toBe('QU-000001');
    expect((await agentA.patch(SETTINGS).send({ quoteNextNumber: 1 })).status).toBe(200);
    const second = await createDraft(QUOTES, await salesPayload());
    const res = await send(QUOTES, second.id);
    expect(res.status).toBe(409);
    expect(res.body.error ?? res.body.message).toBe(
      'That quote number is already in use — raise the next quote number in Settings → Invoices',
    );
  });

  it('a VIEWER cannot PATCH the quote settings → 403', async () => {
    const viewer = await createUserWithOrg({ label: 'viewer' });
    await addMember(userA.orgId, viewer.id, 'VIEWER');
    const agentV = await loginAgent(app, viewer);
    await agentV.post('/api/v1/auth/switch-org').send({ orgId: userA.orgId });
    const res = await agentV.patch(SETTINGS).send({ quotePrefix: 'HACK-' });
    expect(res.status).toBe(403);
    expect((await agentA.get(SETTINGS)).body.invoiceSettings.quotePrefix).toBe('QU-');
  });

  it("org B's PATCH does not change org A's quote prefix", async () => {
    expect((await agentB.patch(SETTINGS).send({ quotePrefix: 'BRV-', defaultQuoteValidityDays: 7 })).status).toBe(200);
    const a = (await agentA.get(SETTINGS)).body.invoiceSettings;
    expect(a.quotePrefix).toBe('QU-');
    expect(a.defaultQuoteValidityDays).toBe(30);
    const b = (await agentB.get(SETTINGS)).body.invoiceSettings;
    expect(b.quotePrefix).toBe('BRV-');
  });
});
