import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { pool } from '../db/connect.js';
import { createWalkthroughReplay, type ReplayClient, type ReplayResponse } from './walkthroughReplay.js';
import { defaultAnchor, parseAnchor, resolveDate, shiftIsoDate } from './walkthroughDates.js';

/**
 * `npm run seed:demo [-- --anchor YYYY-MM]` — builds a populated demo
 * organization, Harbor Point Fabrication, so the product can be explored
 * without typing four months of books in by hand.
 *
 * Layers, in order:
 *   1. the four walkthrough months (`walkthroughReplay.ts`) — the same replay
 *      `walkthrough.test.ts` proves equal to the computed answer key, cent
 *      for cent; month 4 lands on last month by default;
 *   2. inventory: the Manufacturing profile, four stock products received on
 *      a bill and partly sold on an invoice (one ends below its reorder point);
 *   3. this month's open work: an overdue invoice, an open one, a draft, an
 *      approved bill, a bill awaiting approval — so the dashboard, aging and
 *      approval queues have something in them;
 *   4. two bank rules — created last, so they can never change how the
 *      verified months' statement lines were matched.
 *
 * Everything goes through the HTTP API of an app started in-process on an
 * ephemeral port — the same routes, validation, FSMs and GL posting a person
 * hits, and no SQL here (rule 2's spirit, even for a script). The one
 * precondition is a migrated database; the demo email must not exist yet.
 *
 * Credentials: DEMO_EMAIL / DEMO_PASSWORD, defaulting to the values below.
 * They are demo credentials by design — the client can show them on the
 * login page (VITE_DEMO_EMAIL / VITE_DEMO_PASSWORD).
 */

const DEMO_EMAIL = (process.env.DEMO_EMAIL ?? 'demo@autoledger.dev').toLowerCase();
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'autoledger-demo';
const ORG_NAME = 'Harbor Point Fabrication';

function anchorFromArgs() {
  const i = process.argv.indexOf('--anchor');
  const raw = i === -1 ? undefined : process.argv[i + 1];
  return raw === undefined ? defaultAnchor() : parseAnchor(raw);
}

/** A fetch client with a minimal cookie jar — enough to carry the httpOnly session cookies. */
function createFetchClient(baseUrl: string) {
  const cookies = new Map<string, string>();

  async function send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ReplayResponse> {
    const headers: Record<string, string> = {};
    if (cookies.size > 0) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    for (const header of res.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq > 0) cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON body (shouldn't happen on /api/v1) — callers read `text`.
    }
    return { status: res.status, body: parsed, text };
  }

  return {
    get: (path) => send('GET', path),
    post: (path, body) => send('POST', path, body),
  } satisfies ReplayClient;
}

function expectStatus(res: ReplayResponse, status: number, what: string): void {
  if (res.status !== status) throw new Error(`seed:demo: ${what} failed: ${String(res.status)} ${res.text}`);
}

const server = createApp().listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const api = createFetchClient(`http://127.0.0.1:${String(port)}`);

try {
  const anchor = anchorFromArgs();
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => shiftIsoDate(today, -n);
  const daysAhead = (n: number) => shiftIsoDate(today, n);

  // ---- 0. the user, the organization, setup ----
  const registered = await api.post('/api/v1/auth/register', {
    name: 'Demo User',
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    organizationName: ORG_NAME,
  });
  if (registered.status === 409) {
    throw new Error(`seed:demo: ${DEMO_EMAIL} already exists. Run \`npm run db:reset\` first, or set DEMO_EMAIL to another address.`);
  }
  expectStatus(registered, 201, 'register');
  expectStatus(await api.post('/api/v1/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD }), 200, 'login');

  const replay = createWalkthroughReplay(api, anchor);
  expectStatus(
    await api.post('/api/v1/settings/onboarding', {
      organizationName: ORG_NAME,
      legalName: `${ORG_NAME} LLC`,
      baseCurrency: 'USD',
      fiscalYearStartMonth: 1,
      booksStartDate: resolveDate(anchor, 1, 1),
      industry: 'Manufacturing',
      timezone: 'UTC',
      cashAccountId: await replay.accountId('1110'),
    }),
    200,
    'setup wizard',
  );

  // ---- 1. four verified months ----
  await replay.createInterestAccount();
  await replay.createVendorsAndCustomers();
  for (const month of [1, 2, 3, 4] as const) {
    await replay.replayMonth(month);
    console.log(`[seed:demo] month ${String(month)} of 4 replayed (${resolveDate(anchor, month, 1).slice(0, 7)})`);
  }

  // ---- 2. inventory ----
  expectStatus(await api.post('/api/v1/inventory/setup', { industryProfile: 'MANUFACTURING' }), 200, 'inventory setup');
  const categories = (await api.get('/api/v1/inventory/categories')).body.categories as Array<{ id: string; code: string }>;
  const categoryId = (code: string) => {
    const found = categories.find((c) => c.code === code);
    if (found === undefined) throw new Error(`seed:demo: no inventory category ${code}`);
    return found.id;
  };
  const locations = (await api.get('/api/v1/inventory/locations')).body.locations as Array<{ id: string }>;
  const locationId = locations[0]?.id ?? null;

  const stock = [
    { name: 'Steel mounting bracket', category: 'CMP', attributes: { part_number: 'HB-2201' }, cost: 1850, price: 4200, reorder: 50, received: 200, sold: 120 },
    { name: 'Hydraulic fitting, 1/2 in', category: 'CMP', attributes: { part_number: 'HF-0512' }, cost: 725, price: 1600, reorder: 100, received: 300, sold: 240 },
    { name: 'Industrial fastener kit', category: 'CON', attributes: {}, cost: 3200, price: 6500, reorder: 20, received: 40, sold: 10 },
    { name: 'Shipping crate, large', category: 'PKG', attributes: {}, cost: 5500, price: 9000, reorder: 10, received: 25, sold: 0 },
  ];
  const products: Array<(typeof stock)[number] & { ledgerItemId: string }> = [];
  for (const s of stock) {
    const created = await api.post('/api/v1/inventory/items', {
      name: s.name,
      categoryId: categoryId(s.category),
      attributes: s.attributes,
      reorderPointMilli: s.reorder * 1000,
      product: { salePriceCents: s.price, purchasePriceCents: s.cost },
    });
    expectStatus(created, 201, `inventory item ${s.name}`);
    products.push({ ...s, ledgerItemId: created.body.item.ledgerItemId as string });
  }

  const inventoryAccountId = await replay.accountId('1140');
  const receipt = await api.post('/api/v1/bills', {
    vendorId: replay.vendorId('ironclad-supply'),
    vendorReference: 'ICS-STK-1042',
    billDate: daysAgo(18),
    dueDate: daysAhead(12),
    lines: products.map((p) => ({
      description: p.name,
      quantityMilli: p.received * 1000,
      unitPriceCents: p.cost,
      expenseAccountId: inventoryAccountId,
      itemId: p.ledgerItemId,
      stockLocationId: locationId,
    })),
  });
  expectStatus(receipt, 201, 'stock receipt bill');
  expectStatus(await api.post(`/api/v1/bills/${receipt.body.bill.id as string}/submit`, {}), 200, 'stock receipt submit');
  expectStatus(await api.post(`/api/v1/bills/${receipt.body.bill.id as string}/approve`, {}), 200, 'stock receipt approve');

  const productRevenueId = await replay.accountId('4100');
  const sale = await api.post('/api/v1/invoices', {
    customerId: replay.customerId('pinnacle-robotics'),
    issueDate: daysAgo(4),
    dueDate: daysAhead(26),
    lines: products
      .filter((p) => p.sold > 0)
      .map((p) => ({
        description: p.name,
        quantityMilli: p.sold * 1000,
        unitPriceCents: p.price,
        revenueAccountId: productRevenueId,
        itemId: p.ledgerItemId,
        stockLocationId: locationId,
      })),
  });
  expectStatus(sale, 201, 'stock sale invoice');
  expectStatus(await api.post(`/api/v1/invoices/${sale.body.invoice.id as string}/issue`, {}), 200, 'stock sale issue');
  console.log('[seed:demo] inventory set up, stock received and sold');

  // ---- 3. this month's open work ----
  async function invoice(customerKey: string, accountCode: string, description: string, cents: number, issueDate: string, dueDate: string, issue: boolean) {
    const created = await api.post('/api/v1/invoices', {
      customerId: replay.customerId(customerKey),
      issueDate,
      dueDate,
      lines: [{ description, quantityMilli: 1000, unitPriceCents: cents, revenueAccountId: await replay.accountId(accountCode) }],
    });
    expectStatus(created, 201, `invoice ${description}`);
    if (issue) expectStatus(await api.post(`/api/v1/invoices/${created.body.invoice.id as string}/issue`, {}), 200, `issue ${description}`);
  }
  async function bill(vendorKey: string, reference: string, accountCode: string, description: string, cents: number, billDate: string, dueDate: string, approve: boolean) {
    const created = await api.post('/api/v1/bills', {
      vendorId: replay.vendorId(vendorKey),
      vendorReference: reference,
      billDate,
      dueDate,
      lines: [{ description, quantityMilli: 1000, unitPriceCents: cents, expenseAccountId: await replay.accountId(accountCode) }],
    });
    expectStatus(created, 201, `bill ${reference}`);
    const id = created.body.bill.id as string;
    expectStatus(await api.post(`/api/v1/bills/${id}/submit`, {}), 200, `submit ${reference}`);
    if (approve) expectStatus(await api.post(`/api/v1/bills/${id}/approve`, {}), 200, `approve ${reference}`);
  }

  await invoice('brightline-analytics', '4200', 'Design consultation — conveyor retrofit', 685000, daysAgo(26), daysAgo(12), true);
  await invoice('kestrel-logistics', '4100', 'Fabricated racking — bay 3', 1240000, daysAgo(9), daysAhead(21), true);
  await invoice('novato-health', '4200', 'Scheduled maintenance visit', 147500, daysAgo(1), daysAhead(29), false);
  await bill('cloudspan', 'CS-INV-88213', '6120', 'Cloud hosting and backups', 118000, daysAgo(14), daysAhead(16), true);
  await bill('verity-audit', 'VAP-Q3-017', '6200', 'Quarterly review fee', 450000, daysAgo(3), daysAhead(27), false);
  console.log('[seed:demo] current-month documents entered');

  // ---- 4. bank rules ----
  const cashAccountId = await replay.accountId('1110');
  expectStatus(
    await api.post('/api/v1/bank-rules', {
      name: 'Monthly bank service charge',
      priority: 100,
      direction: 'OUT',
      memoContains: 'SERVICE CHARGE',
      amountMinCents: null,
      amountMaxCents: 10000,
      bankAccountId: cashAccountId,
      targetAccountId: await replay.accountId('6600'),
      description: 'Bank service charge',
    }),
    201,
    'bank rule (service charge)',
  );
  expectStatus(
    await api.post('/api/v1/bank-rules', {
      name: 'Interest on operating account',
      priority: 110,
      direction: 'IN',
      memoContains: 'INTEREST PAID',
      amountMinCents: null,
      amountMaxCents: null,
      bankAccountId: cashAccountId,
      targetAccountId: await replay.accountId('4300'),
      description: 'Bank interest',
    }),
    201,
    'bank rule (interest)',
  );

  console.log(`\nDemo organization "${ORG_NAME}" is ready.`);
  console.log(`  Email:    ${DEMO_EMAIL}`);
  console.log(`  Password: ${DEMO_PASSWORD}`);
  console.log(`  Books:    ${resolveDate(anchor, 1, 1)} → ${today}`);
  server.close();
  await pool.end();
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  server.close();
  await pool.end();
  process.exit(1);
}
