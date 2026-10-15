import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'supertest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, type Agent } from '../helpers/accountingFixtures.js';
import { outboxFor } from '../helpers/email.js';

/**
 * Phase 41 — quotes, sales and purchase. Integration tier, real PostgreSQL.
 *
 * The central claims: a quote never touches the ledger at any stage; a
 * number is allocated only at first send (a deleted draft burns none); a
 * sent quote changes only by revision, which keeps the number; conversion
 * is manual, once only, produces a DRAFT invoice/bill at that document's
 * own FX rate, and is undone by deleting that draft; and none of it is
 * visible across tenants.
 */

const app = createApp();
const QUOTES = '/api/v1/quotes';
const PURCHASE_QUOTES = '/api/v1/purchase-quotes';
const INVOICES = '/api/v1/invoices';
const BILLS = '/api/v1/bills';
const RATES = '/api/v1/fx-rates';

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

async function createVendor(agent: Agent, name: string, email: string | null = null): Promise<string> {
  const res = await agent.post('/api/v1/vendors').send({ name, email });
  if (res.status !== 201) throw new Error(`fixture: vendor create failed ${res.status} ${res.text}`);
  return res.body.vendor.id as string;
}

/** Two units at 100.00, 15% tax: 200.00 + 30.00 = 230.00. */
async function salesPayload(orgId: string, partyId: string, extra: Record<string, unknown> = {}) {
  return {
    partyId,
    quoteDate: TODAY,
    validUntil: isoDaysFromNow(30),
    title: 'Fit-out, level 2',
    terms: 'Prices valid for 30 days. 50% deposit on acceptance.',
    lines: [
      {
        description: 'Installation',
        quantityMilli: 2000,
        unitPriceCents: 10000,
        accountId: await accountId(orgId, '4100'),
        taxRateBp: 1500,
      },
    ],
    ...extra,
  };
}

async function purchasePayload(orgId: string, partyId: string, extra: Record<string, unknown> = {}) {
  return {
    partyId,
    quoteDate: TODAY,
    validUntil: isoDaysFromNow(14),
    partyReference: 'VQ-7781',
    lines: [
      {
        description: 'Steel sheet',
        quantityMilli: 5000,
        unitPriceCents: 2000,
        accountId: await accountId(orgId, '6130'),
        taxRateBp: 0,
      },
    ],
    ...extra,
  };
}

async function draftQuote(agent: Agent, base: string, payload: object): Promise<string> {
  const res = await agent.post(base).send(payload);
  if (res.status !== 201) throw new Error(`fixture: quote create failed ${res.status} ${res.text}`);
  return res.body.quote.id as string;
}

async function sentQuote(agent: Agent, base: string, payload: object): Promise<string> {
  const id = await draftQuote(agent, base, payload);
  const res = await agent.post(`${base}/${id}/send`).send({ delivery: 'MANUAL' });
  if (res.status !== 200) throw new Error(`fixture: quote send failed ${res.status} ${res.text}`);
  return id;
}

async function acceptedQuote(agent: Agent, base: string, payload: object): Promise<string> {
  const id = await sentQuote(agent, base, payload);
  const res = await agent.post(`${base}/${id}/accept`).send({ signerName: 'Jane Doe' });
  if (res.status !== 200) throw new Error(`fixture: quote accept failed ${res.status} ${res.text}`);
  return id;
}

async function ledgerRowCount(orgId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM journal_entries WHERE org_id = $1) + (SELECT count(*) FROM ledger_lines WHERE org_id = $1) AS n`,
    [orgId],
  );
  return Number(rows[0]?.n ?? '0');
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  customerA = await createCustomer(agentA, 'Acme Fitouts', 'buyer@acme.test');
  vendorA = await createVendor(agentA, 'Steel Co', 'sales@steel.test');
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(closePool);

describe('quotes — drafts', () => {
  it('creates a draft with server-computed totals, no number, and default terms', async () => {
    const res = await agentA.post(QUOTES).send(await salesPayload(userA.orgId, customerA));
    expect(res.status).toBe(201);
    const quote = res.body.quote;
    expect(quote).toMatchObject({
      direction: 'SALES',
      status: 'DRAFT',
      quoteNumber: null,
      revision: 1,
      partyId: customerA,
      partyNameSnapshot: 'Acme Fitouts',
      partyEmailSnapshot: 'buyer@acme.test',
      subtotalCents: 20000,
      taxCents: 3000,
      totalCents: 23000,
      indicativeFxRate: null,
    });
    expect(quote.lines[0]).toMatchObject({ netCents: 20000, taxCents: 3000 });
  });

  it('defaults valid-until from the organization setting when omitted', async () => {
    const payload = await salesPayload(userA.orgId, customerA);
    delete (payload as { validUntil?: string }).validUntil;
    const res = await agentA.post(QUOTES).send(payload);
    expect(res.status).toBe(201);
    expect(res.body.quote.validUntil).toBe(isoDaysFromNow(30));
  });

  it('a sales quote line must use a Revenue account; a purchase line an Expense/Asset account', async () => {
    const sales = await salesPayload(userA.orgId, customerA);
    sales.lines[0]!.accountId = await accountId(userA.orgId, '6130');
    expect((await agentA.post(QUOTES).send(sales)).status).toBe(422);

    const purchase = await purchasePayload(userA.orgId, vendorA);
    purchase.lines[0]!.accountId = await accountId(userA.orgId, '4100');
    expect((await agentA.post(PURCHASE_QUOTES).send(purchase)).status).toBe(422);
  });

  it('a customer id is not a party on the purchase routes (direction comes from the route)', async () => {
    const res = await agentA.post(PURCHASE_QUOTES).send(await purchasePayload(userA.orgId, customerA));
    expect(res.status).toBe(422);
  });

  it('a draft can be edited and deleted; a sales id is a 404 on the purchase routes', async () => {
    const id = await draftQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    const edited = await agentA
      .patch(`${QUOTES}/${id}`)
      .send(await salesPayload(userA.orgId, customerA, { title: 'Revised scope' }));
    expect(edited.status).toBe(200);
    expect(edited.body.quote.title).toBe('Revised scope');

    expect((await agentA.get(`${PURCHASE_QUOTES}/${id}`)).status).toBe(404);
    expect((await agentA.delete(`${QUOTES}/${id}`)).status).toBe(204);
    expect((await agentA.get(`${QUOTES}/${id}`)).status).toBe(404);
  });

  it('lists by effective status and hides superseded versions by default', async () => {
    await draftQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    await sentQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    const all = await agentA.get(QUOTES);
    expect(all.status).toBe(200);
    expect(all.body.totalCount).toBe(2);
    const sent = await agentA.get(`${QUOTES}?status=SENT`);
    expect(sent.body.quotes).toHaveLength(1);
    expect(sent.body.quotes[0].quoteNumber).toBe('QU-000001');
  });
});

describe('quotes — sending, numbering and immutability', () => {
  it('numbers at first send only, so a deleted draft burns no number', async () => {
    const scrap = await draftQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    await agentA.delete(`${QUOTES}/${scrap}`);
    const id = await sentQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    const quote = (await agentA.get(`${QUOTES}/${id}`)).body.quote;
    expect(quote).toMatchObject({ status: 'SENT', quoteNumber: 'QU-000001' });
    expect(quote.contentSha256).toMatch(/^[0-9a-f]{64}$/);

    const purchase = await sentQuote(agentA, PURCHASE_QUOTES, await purchasePayload(userA.orgId, vendorA));
    expect((await agentA.get(`${PURCHASE_QUOTES}/${purchase}`)).body.quote.quoteNumber).toBe('PQ-000001');
  });

  it('a sent quote cannot be edited or deleted', async () => {
    const id = await sentQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    expect((await agentA.patch(`${QUOTES}/${id}`).send(await salesPayload(userA.orgId, customerA))).status).toBe(409);
    expect((await agentA.delete(`${QUOTES}/${id}`)).status).toBe(409);
  });

  it('refuses to send a quote whose validity has already passed', async () => {
    const id = await draftQuote(
      agentA,
      QUOTES,
      await salesPayload(userA.orgId, customerA, { quoteDate: isoDaysFromNow(-10), validUntil: isoDaysFromNow(-1) }),
    );
    expect((await agentA.post(`${QUOTES}/${id}/send`).send({ delivery: 'MANUAL' })).status).toBe(422);
  });

  it('emailing writes a quote_sent email with a token link, and stores only its hash', async () => {
    const id = await draftQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    const res = await agentA
      .post(`${QUOTES}/${id}/send`)
      .send({ delivery: 'EMAIL', toEmail: 'Buyer@Acme.test', message: 'As discussed on site.' });
    expect(res.status).toBe(200);
    expect(res.body.quote.links).toHaveLength(1);
    expect(res.body.quote.links[0]).toMatchObject({ toEmail: 'buyer@acme.test', live: true });

    const emails = await outboxFor('buyer@acme.test', 'quote_sent');
    expect(emails).toHaveLength(1);
    expect(emails[0]!.template_data).toMatchObject({ quoteNumber: 'QU-000001', direction: 'SALES' });
    const { rows } = await pool.query<{ token_hash: string }>('SELECT token_hash FROM quote_links WHERE quote_id = $1', [id]);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-sending revokes the previous link, leaving one live link', async () => {
    const id = await sentQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    await agentA.post(`${QUOTES}/${id}/send`).send({ delivery: 'EMAIL', toEmail: 'a@acme.test' });
    const res = await agentA.post(`${QUOTES}/${id}/send`).send({ delivery: 'EMAIL', toEmail: 'b@acme.test' });
    expect(res.body.quote.links.filter((l: { live: boolean }) => l.live)).toHaveLength(1);
    expect(res.body.quote.links[0]).toMatchObject({ toEmail: 'b@acme.test', live: true });
  });
});

describe('quotes — revisions', () => {
  it('a revision keeps the number, bumps the revision, and supersedes the sent version when sent', async () => {
    const original = await sentQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    const revised = await agentA.post(`${QUOTES}/${original}/revise`).send({});
    expect(revised.status).toBe(201);
    const revisionId = revised.body.quote.id as string;
    expect(revised.body.quote).toMatchObject({ status: 'DRAFT', revision: 2, quoteNumber: null });

    // Only one draft revision per chain.
    expect((await agentA.post(`${QUOTES}/${original}/revise`).send({})).status).toBe(409);

    await agentA.patch(`${QUOTES}/${revisionId}`).send(
      await salesPayload(userA.orgId, customerA, {
        lines: [
          { description: 'Installation', quantityMilli: 2000, unitPriceCents: 9000, accountId: await accountId(userA.orgId, '4100'), taxRateBp: 1500 },
        ],
      }),
    );
    expect((await agentA.post(`${QUOTES}/${revisionId}/send`).send({ delivery: 'MANUAL' })).status).toBe(200);

    const after = (await agentA.get(`${QUOTES}/${revisionId}`)).body.quote;
    expect(after).toMatchObject({ status: 'SENT', quoteNumber: 'QU-000001', revision: 2, totalCents: 20700 });
    expect(after.revisions.map((r: { status: string }) => r.status)).toEqual(['SUPERSEDED', 'SENT']);
    expect((await agentA.get(`${QUOTES}/${original}`)).body.quote.status).toBe('SUPERSEDED');
  });

  it('a revision keeps its party', async () => {
    const original = await sentQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    const revisionId = (await agentA.post(`${QUOTES}/${original}/revise`).send({})).body.quote.id as string;
    const other = await createCustomer(agentA, 'Someone Else');
    expect((await agentA.patch(`${QUOTES}/${revisionId}`).send(await salesPayload(userA.orgId, other))).status).toBe(422);
  });

  it('an accepted quote cannot be revised', async () => {
    const id = await acceptedQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    expect((await agentA.post(`${QUOTES}/${id}/revise`).send({})).status).toBe(409);
  });

  it('sending a revision fails if the previous one was accepted while it was drafted', async () => {
    const original = await sentQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    const revisionId = (await agentA.post(`${QUOTES}/${original}/revise`).send({})).body.quote.id as string;
    await agentA.post(`${QUOTES}/${original}/accept`).send({ signerName: 'Jane Doe' });
    expect((await agentA.post(`${QUOTES}/${revisionId}/send`).send({ delivery: 'MANUAL' })).status).toBe(409);
  });
});

describe('quotes — responses, expiry and void', () => {
  it('records an internal acceptance with its evidence', async () => {
    const id = await sentQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    const res = await agentA.post(`${QUOTES}/${id}/accept`).send({ signerName: 'Jane Doe', note: 'Signed PDF attached' });
    expect(res.status).toBe(200);
    expect(res.body.quote.status).toBe('ACCEPTED');
    expect(res.body.quote.response).toMatchObject({
      response: 'ACCEPTED',
      channel: 'INTERNAL',
      signerName: 'Jane Doe',
      recordedBy: userA.id,
      quoteContentSha256: res.body.quote.contentSha256,
    });
    // Answered once only.
    expect((await agentA.post(`${QUOTES}/${id}/decline`).send({})).status).toBe(409);
  });

  it('recording a response on a draft finalizes it first (a paper vendor quote)', async () => {
    const id = await draftQuote(agentA, PURCHASE_QUOTES, await purchasePayload(userA.orgId, vendorA));
    const res = await agentA.post(`${PURCHASE_QUOTES}/${id}/accept`).send({ signerName: 'Sam at Steel Co' });
    expect(res.status).toBe(200);
    expect(res.body.quote).toMatchObject({ status: 'ACCEPTED', quoteNumber: 'PQ-000001' });
  });

  it('a sent quote past validity reads EXPIRED and cannot be accepted', async () => {
    const id = await sentQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA, { validUntil: TODAY }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    // Two days on, the 15-minute access token has expired too: sign in again.
    const later = await loginAgent(app, userA);
    const quote = (await later.get(`${QUOTES}/${id}`)).body.quote;
    expect(quote).toMatchObject({ status: 'SENT', effectiveStatus: 'EXPIRED' });
    expect((await later.post(`${QUOTES}/${id}/accept`).send({ signerName: 'Late Larry' })).status).toBe(409);
    expect((await later.get(`${QUOTES}?status=EXPIRED`)).body.totalCount).toBe(1);
  });

  it('the expiry sweep persists EXPIRED', async () => {
    const { expireQuotesForOrg } = await import('../../services/accounting/quoteService.js');
    const id = await sentQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA, { validUntil: TODAY }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    expect(await expireQuotesForOrg(userA.orgId)).toBe(1);
    vi.useRealTimers();
    expect((await agentA.get(`${QUOTES}/${id}`)).body.quote).toMatchObject({ status: 'EXPIRED' });
  });

  it('void needs a reason and revokes live links', async () => {
    const id = await sentQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    await agentA.post(`${QUOTES}/${id}/send`).send({ delivery: 'EMAIL', toEmail: 'buyer@acme.test' });
    expect((await agentA.post(`${QUOTES}/${id}/void`).send({ reason: '' })).status).toBe(400);
    const res = await agentA.post(`${QUOTES}/${id}/void`).send({ reason: 'Customer went elsewhere' });
    expect(res.status).toBe(200);
    expect(res.body.quote).toMatchObject({ status: 'VOID', voidReason: 'Customer went elsewhere' });
    expect(res.body.quote.links[0].live).toBe(false);
  });
});

describe('quotes — conversion', () => {
  it('converts an accepted sales quote into a linked DRAFT invoice, with nothing posted', async () => {
    const before = await ledgerRowCount(userA.orgId);
    const id = await acceptedQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    expect(await ledgerRowCount(userA.orgId)).toBe(before);

    const res = await agentA.post(`${QUOTES}/${id}/convert`).send({});
    expect(res.status).toBe(201);
    expect(res.body.document.kind).toBe('INVOICE');
    // Conversion itself posts nothing — the draft invoice posts only when issued.
    expect(await ledgerRowCount(userA.orgId)).toBe(before);

    const invoice = (await agentA.get(`${INVOICES}/${res.body.document.id}`)).body.invoice;
    expect(invoice).toMatchObject({
      status: 'DRAFT',
      customerId: customerA,
      totalCents: 23000,
      sourceQuote: { id, quoteNumber: 'QU-000001', revision: 1 },
    });
    expect(invoice.lines[0]).toMatchObject({ description: 'Installation', quantityMilli: 2000, unitPriceCents: 10000 });

    const quote = (await agentA.get(`${QUOTES}/${id}`)).body.quote;
    expect(quote.status).toBe('CONVERTED');
    expect(quote.convertedDocument).toMatchObject({ kind: 'INVOICE', id: res.body.document.id });

    const { rows: events } = await pool.query<{ event_type: string }>(
      'SELECT event_type FROM outbox_events WHERE org_id = $1 AND event_type LIKE $2 ORDER BY id',
      [userA.orgId, 'quote.%'],
    );
    expect(events.map((e) => e.event_type)).toEqual(['quote.sent', 'quote.accepted', 'quote.converted']);
  });

  it('converts once only', async () => {
    const id = await acceptedQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    expect((await agentA.post(`${QUOTES}/${id}/convert`).send({})).status).toBe(201);
    expect((await agentA.post(`${QUOTES}/${id}/convert`).send({})).status).toBe(409);
  });

  it('only an accepted quote converts', async () => {
    const id = await sentQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    expect((await agentA.post(`${QUOTES}/${id}/convert`).send({})).status).toBe(409);
  });

  it('deleting the draft invoice returns the quote to ACCEPTED; voiding an issued one does not', async () => {
    const id = await acceptedQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    const first = (await agentA.post(`${QUOTES}/${id}/convert`).send({})).body.document.id as string;
    expect((await agentA.delete(`${INVOICES}/${first}`)).status).toBe(204);
    expect((await agentA.get(`${QUOTES}/${id}`)).body.quote.status).toBe('ACCEPTED');

    const second = (await agentA.post(`${QUOTES}/${id}/convert`).send({})).body.document.id as string;
    expect((await agentA.post(`${INVOICES}/${second}/issue`).send({})).status).toBe(200);
    expect((await agentA.post(`${INVOICES}/${second}/void`).send({})).status).toBe(200);
    expect((await agentA.get(`${QUOTES}/${id}`)).body.quote.status).toBe('CONVERTED');
    expect((await agentA.post(`${QUOTES}/${id}/convert`).send({})).status).toBe(409);
  });

  it('the invoice resolves the FX rate of its own date, not the quote date', async () => {
    expect((await agentA.patch('/api/v1/organizations').send({ baseCurrency: 'INR' })).status).toBe(200);
    await agentA.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: isoDaysFromNow(-5), rate: '80.00000000' });
    const id = await acceptedQuote(
      agentA,
      QUOTES,
      await salesPayload(userA.orgId, customerA, { currencyCode: 'USD' }),
    );
    const quote = (await agentA.get(`${QUOTES}/${id}`)).body.quote;
    expect(quote.indicativeFxRate).toBe('80.00000000');
    expect(quote.indicativeBaseTotalCents).toBe(23000 * 80);

    await agentA.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: TODAY, rate: '84.00000000' });
    const converted = (await agentA.post(`${QUOTES}/${id}/convert`).send({ documentDate: TODAY })).body.document;
    const invoice = (await agentA.get(`${INVOICES}/${converted.id}`)).body.invoice;
    expect(invoice).toMatchObject({ currencyCode: 'USD', fxRate: '84.00000000', baseTotalCents: 23000 * 84 });
  });

  it('converts an accepted purchase quote into a DRAFT bill carrying the vendor reference', async () => {
    const id = await acceptedQuote(agentA, PURCHASE_QUOTES, await purchasePayload(userA.orgId, vendorA));
    const res = await agentA.post(`${PURCHASE_QUOTES}/${id}/convert`).send({});
    expect(res.status).toBe(201);
    expect(res.body.document.kind).toBe('BILL');
    const bill = (await agentA.get(`${BILLS}/${res.body.document.id}`)).body.bill;
    expect(bill).toMatchObject({
      status: 'DRAFT',
      vendorId: vendorA,
      vendorReference: 'VQ-7781',
      totalCents: 10000,
      sourceQuote: { id, quoteNumber: 'PQ-000001' },
    });
  });

  it('a purchase quote without a party reference falls back to its own number', async () => {
    const id = await acceptedQuote(
      agentA,
      PURCHASE_QUOTES,
      await purchasePayload(userA.orgId, vendorA, { partyReference: null }),
    );
    const res = await agentA.post(`${PURCHASE_QUOTES}/${id}/convert`).send({});
    const bill = (await agentA.get(`${BILLS}/${res.body.document.id}`)).body.bill;
    expect(bill.vendorReference).toBe('PQ-000001');
  });
});

describe('quotes — permissions', () => {
  it('a viewer can read quotes but not create, send or convert them', async () => {
    const id = await acceptedQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    const viewer = await createUserWithOrg({ label: 'viewer' });
    await addMember(userA.orgId, viewer.id, 'VIEWER');
    const agentV = await loginAgent(app, viewer);
    await agentV.post('/api/v1/auth/switch-org').send({ orgId: userA.orgId });
    expect((await agentV.get(`${QUOTES}/${id}`)).status).toBe(200);
    expect((await agentV.post(QUOTES).send(await salesPayload(userA.orgId, customerA))).status).toBe(403);
    expect((await agentV.post(`${QUOTES}/${id}/convert`).send({})).status).toBe(403);
  });
});

describe('quotes — cross-tenant isolation', () => {
  it("org B cannot see or act on org A's quotes through any route", async () => {
    const sales = await acceptedQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    const purchase = await sentQuote(agentA, PURCHASE_QUOTES, await purchasePayload(userA.orgId, vendorA));

    expect((await agentB.get(QUOTES)).body.totalCount).toBe(0);
    expect((await agentB.get(PURCHASE_QUOTES)).body.totalCount).toBe(0);
    for (const [base, id] of [
      [QUOTES, sales],
      [PURCHASE_QUOTES, purchase],
    ] as const) {
      expect((await agentB.get(`${base}/${id}`)).status).toBe(404);
      expect((await agentB.delete(`${base}/${id}`)).status).toBe(404);
      expect((await agentB.post(`${base}/${id}/send`).send({ delivery: 'MANUAL' })).status).toBe(404);
      expect((await agentB.post(`${base}/${id}/revise`).send({})).status).toBe(404);
      expect((await agentB.post(`${base}/${id}/accept`).send({ signerName: 'Mallory' })).status).toBe(404);
      expect((await agentB.post(`${base}/${id}/decline`).send({})).status).toBe(404);
      expect((await agentB.post(`${base}/${id}/void`).send({ reason: 'x' })).status).toBe(404);
      expect((await agentB.post(`${base}/${id}/convert`).send({})).status).toBe(404);
    }
    // And org A's customer is not a valid party for org B.
    const res = await agentB.post(QUOTES).send(await salesPayload(userB.orgId, customerA));
    expect(res.status).toBe(422);
  });
});

/** supertest only buffers text/JSON by default; collect the raw PDF bytes. */
function binary(res: Response, cb: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

describe('quotes — PDF', () => {
  it('GET /quotes/:id/pdf -> 200 application/pdf, body starts %PDF-, filename QU-000001.pdf', async () => {
    const id = await sentQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    const res = await agentA.get(`${QUOTES}/${id}/pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="QU-000001.pdf"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(Number(res.headers['content-length'])).toBe(body.length);
  });

  it('a draft downloads as quote-draft.pdf', async () => {
    const id = await draftQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    const res = await agentA.get(`${QUOTES}/${id}/pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="quote-draft.pdf"');
  });

  it("org B cannot download org A's quote PDF -> 404", async () => {
    const id = await sentQuote(agentA, QUOTES, await salesPayload(userA.orgId, customerA));
    expect((await agentB.get(`${QUOTES}/${id}/pdf`)).status).toBe(404);
    // Wrong direction is also a 404.
    expect((await agentA.get(`${PURCHASE_QUOTES}/${id}/pdf`)).status).toBe(404);
  });
});
