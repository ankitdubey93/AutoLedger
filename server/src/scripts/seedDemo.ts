import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { pool } from '../db/connect.js';
import { createWalkthroughReplay, type ReplayClient, type ReplayResponse } from './walkthroughReplay.js';
import { WALKTHROUGH_MONTHS, defaultAnchor, parseAnchor, resolveDate, shiftIsoDate } from './walkthroughDates.js';

/**
 * `npm run seed:demo [-- --anchor YYYY-MM]` — builds a populated demo
 * organization, Harbor Point Fabrication, so the product can be explored
 * without typing six months of books in by hand.
 *
 * Layers, in order:
 *   1. the six walkthrough months (`walkthroughReplay.ts`) — the same replay
 *      `walkthrough.test.ts` proves equal to the computed answer key, cent
 *      for cent, now including products and stock, orders, a deposit, bank
 *      rules, recurring documents, imports and period close; month 6 lands
 *      on last month by default;
 *   2. this month's open work: an overdue invoice, an open one, a draft, an
 *      approved bill, a bill awaiting approval — so the dashboard, aging and
 *      approval queues have something in them.
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
  await replay.completeSetup(ORG_NAME);

  // ---- 1. six verified months ----
  await replay.importAccounts();
  await replay.createVendorsAndCustomers();
  for (const month of WALKTHROUGH_MONTHS) {
    await replay.replayMonth(month);
    console.log(`[seed:demo] month ${String(month)} of 6 replayed (${resolveDate(anchor, month, 1).slice(0, 7)})`);
  }

  // ---- 2. this month's open work ----
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
