import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { attemptAutoPost } from '../../services/capture/autoPostService.js';
import { lookupAbn } from '../../services/accounting/abnLookupService.js';
import { env } from '../../config/env.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * ABN tools and the bill inbox for an Australian organization (Phase 49f).
 *
 * The central claims: a captured bill posts immediately, so a receipt that does
 * not settle its GST is refused rather than guessed at, by hand and by auto-post
 * alike; a reviewer's codes resolve it; a vendor is matched by ABN before name;
 * and a generic organization behaves as it always has.
 */

const app = createApp();
const CAPTURE = '/api/v1/capture/documents';
const ACTIVATE = { gst: { registered: true, basis: 'ACCRUAL', basCycle: 'QUARTERLY', basMethod: 'FULL' }, timezone: 'Australia/Sydney' };
const ABN = '51 824 753 556';

type Agent = Awaited<ReturnType<typeof loginAgent>>;
let user: SeededUser;
let agent: Agent;

async function account(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [orgId, code]);
  return rows[0]?.id ?? '';
}

async function seed(
  orgId: string,
  createdBy: string,
  opts: { taxCents: number; totalCents: number; subtotalCents?: number; abn?: string | null; vendor?: string; currency?: string; lines: { amountCents: number; taxCents?: number; description?: string }[] },
): Promise<string> {
  const sha = Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64);
  const { rows: d } = await pool.query<{ id: string }>(
    `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
     VALUES ($1, $2, 10, 'application/pdf', 'r.pdf', $3) RETURNING id`,
    [orgId, sha, createdBy],
  );
  const { rows: c } = await pool.query<{ id: string }>(
    `INSERT INTO ap_flow_documents (org_id, document_id, created_by, status, page_count, processed_at)
     VALUES ($1, $2, $3, 'EXTRACTED', 1, now()) RETURNING id`,
    [orgId, d[0]?.id, createdBy],
  );
  const id = c[0]?.id ?? '';
  await pool.query(
    `INSERT INTO ap_flow_extractions
       (org_id, ap_flow_document_id, supplier_abn, vendor_name, invoice_number, invoice_date, currency,
        subtotal_cents, tax_cents, total_cents, arithmetic_ok, model, field_confidence)
     VALUES ($1, $2, $3, $4, $5, '2026-08-15', $6, $7, $8, $9, true, 'm', '{"vendor_name":1,"invoice_number":1,"invoice_date":1,"total":1}')`,
    [orgId, id, opts.abn ?? null, opts.vendor ?? 'Coastal Supplies', `R-${sha.slice(0, 8)}`, opts.currency ?? 'AUD', opts.subtotalCents ?? null, opts.taxCents, opts.totalCents],
  );
  const expense = await account(orgId, '6130');
  for (const [i, line] of opts.lines.entries()) {
    await pool.query(
      `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents, account_id, tax_cents, mapping_source, mapping_confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'HISTORY', 1)`,
      [orgId, id, i, line.description ?? `Line ${String(i)}`, line.amountCents, expense, line.taxCents ?? null],
    );
  }
  return id;
}

async function billOf(id: string) {
  const { rows } = await pool.query<{ bill_id: string }>('SELECT bill_id FROM ap_flow_documents WHERE id = $1', [id]);
  const billId = rows[0]?.bill_id ?? '';
  const res = await agent.get(`/api/v1/bills/${billId}`);
  return res.body.bill as { vendorId: string; taxCents: number; subtotalCents: number; totalCents: number; lines: { taxCode: string; taxRateBp: number; netCents: number; taxCents: number }[] };
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'a' });
  agent = await loginAgent(app, user);
  expect((await agent.post('/api/v1/settings/region/australia').send(ACTIVATE)).status).toBe(200);
});

afterAll(async () => {
  await closePool();
});

describe('posting a captured bill', () => {
  it('codes a fully taxable receipt, with the rate from the code', async () => {
    const id = await seed(user.orgId, user.id, { taxCents: 1_000, totalCents: 11_000, lines: [{ amountCents: 10_000 }] });
    expect((await agent.post(`${CAPTURE}/${id}/post`).send({})).status).toBe(200);
    const bill = await billOf(id);
    expect(bill.lines[0]).toMatchObject({ taxCode: 'P_GST', taxRateBp: 1000, netCents: 10_000, taxCents: 1_000 });
  });

  it('takes GST out of lines that already include it', async () => {
    const id = await seed(user.orgId, user.id, { taxCents: 1_000, totalCents: 11_000, lines: [{ amountCents: 11_000 }] });
    expect((await agent.post(`${CAPTURE}/${id}/post`).send({})).status).toBe(200);
    expect(await billOf(id)).toMatchObject({ subtotalCents: 10_000, taxCents: 1_000, totalCents: 11_000 });
  });

  it('uses GST printed per line on a mixed receipt', async () => {
    const id = await seed(user.orgId, user.id, {
      taxCents: 1_000,
      totalCents: 16_000,
      lines: [{ amountCents: 10_000, taxCents: 1_000 }, { amountCents: 5_000, taxCents: 0 }],
    });
    expect((await agent.post(`${CAPTURE}/${id}/post`).send({})).status).toBe(200);
    const bill = await billOf(id);
    expect(bill.lines.map((l) => l.taxCode).sort()).toEqual(['P_FREE', 'P_GST']);
  });

  it('refuses a mixed receipt it cannot split, then accepts a reviewer’s codes', async () => {
    const id = await seed(user.orgId, user.id, { taxCents: 1_000, totalCents: 16_000, lines: [{ amountCents: 10_000 }, { amountCents: 5_000 }] });

    const read = await agent.get(`${CAPTURE}/${id}`);
    expect(read.body.document.gstReview.reason).toMatch(/mix taxable and GST-free/);
    const refused = await agent.post(`${CAPTURE}/${id}/post`).send({});
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatch(/Choose a GST code/);

    const [first, second] = read.body.document.lineItems as { id: string }[];
    await agent.patch(`${CAPTURE}/${id}/line-items/${first?.id ?? ''}`).send({ taxCode: 'P_GST' });
    const coded = await agent.patch(`${CAPTURE}/${id}/line-items/${second?.id ?? ''}`).send({ taxCode: 'P_FREE' });
    expect(coded.status).toBe(200);
    expect(coded.body.document.gstReview).toBeNull();

    expect((await agent.post(`${CAPTURE}/${id}/post`).send({})).status).toBe(200);
    const bill = await billOf(id);
    const free = bill.lines.find((l) => l.taxCode === 'P_FREE');
    expect(free).toMatchObject({ netCents: 5_000, taxCents: 0 });
  });

  it('auto-post leaves a mixed receipt for a person, with the reason recorded', async () => {
    await agent.put('/api/v1/capture/settings').send({ autoPostEnabled: true, autoPostMinConfidence: 0.5, autoPostMaxTotalCents: null });
    const id = await seed(user.orgId, user.id, { taxCents: 1_000, totalCents: 16_000, lines: [{ amountCents: 10_000 }, { amountCents: 5_000 }] });
    expect(await attemptAutoPost(user.orgId, id)).toBe('BLOCKED');
    const read = await agent.get(`${CAPTURE}/${id}`);
    expect(read.body.document.status).toBe('EXTRACTED');
    expect(JSON.stringify(read.body.document.autoPostBlockers)).toMatch(/mix taxable and GST-free/);
    const { rows } = await pool.query('SELECT 1 FROM bills WHERE org_id = $1', [user.orgId]);
    expect(rows).toHaveLength(0);
  });

  it('claims nothing for an unregistered business', async () => {
    await agent.patch('/api/v1/settings/gst').send({ registered: false });
    const id = await seed(user.orgId, user.id, { taxCents: 1_000, totalCents: 11_000, lines: [{ amountCents: 10_000 }] });
    expect((await agent.post(`${CAPTURE}/${id}/post`).send({})).status).toBe(200);
    const bill = await billOf(id);
    expect(bill.lines[0]).toMatchObject({ taxCode: 'P_EXCLUDED', netCents: 11_000, taxCents: 0 });
  });
});

describe('matching a vendor', () => {
  it('prefers the ABN to the name, and stores it on a new vendor', async () => {
    const created = await agent.post('/api/v1/vendors').send({ name: 'Coastal Pty Ltd', taxNumber: '51824753556' });
    expect(created.body.vendor.taxNumber).toBe(ABN);

    const sameAbn = await seed(user.orgId, user.id, { taxCents: 0, totalCents: 100, abn: '51824753556', vendor: 'COASTAL SUPPLIES (TRADING NAME)', lines: [{ amountCents: 100 }] });
    await agent.post(`${CAPTURE}/${sameAbn}/post`).send({});
    expect((await billOf(sameAbn)).vendorId).toBe(created.body.vendor.id);

    const fresh = await seed(user.orgId, user.id, { taxCents: 0, totalCents: 100, abn: '53 004 085 616', vendor: 'New Vendor', lines: [{ amountCents: 100 }] });
    await agent.post(`${CAPTURE}/${fresh}/post`).send({});
    const vendor = await agent.get(`/api/v1/vendors/${(await billOf(fresh)).vendorId}`);
    expect(vendor.body.vendor.taxNumber).toBe('53 004 085 616');
  });

  it('ignores an ABN the model misread, falling back to the name', async () => {
    const id = await seed(user.orgId, user.id, { taxCents: 0, totalCents: 100, abn: '51 824 753 557', vendor: 'Misread Vendor', lines: [{ amountCents: 100 }] });
    await agent.post(`${CAPTURE}/${id}/post`).send({});
    const vendor = await agent.get(`/api/v1/vendors/${(await billOf(id)).vendorId}`);
    expect(vendor.body.vendor).toMatchObject({ name: 'Misread Vendor', taxNumber: null });
  });
});

describe('ABN validation', () => {
  it('checks and formats on customers and vendors, and leaves foreign numbers alone', async () => {
    const good = await agent.post('/api/v1/customers').send({ name: 'A', taxNumber: '51824753556' });
    expect(good.body.customer.taxNumber).toBe(ABN);
    expect((await agent.post('/api/v1/customers').send({ name: 'B', taxNumber: '51 824 753 557' })).status).toBe(422);
    const foreign = await agent.post('/api/v1/vendors').send({ name: 'C', taxNumber: 'GB123456789' });
    expect(foreign.body.vendor.taxNumber).toBe('GB123456789');
    expect((await agent.patch(`/api/v1/customers/${good.body.customer.id as string}`).send({ taxNumber: '11111111111' })).status).toBe(422);
  });

  it("insists on a real ABN for the organization's own", async () => {
    expect((await agent.patch('/api/v1/organizations').send({ taxNumber: 'GB123456789' })).status).toBe(422);
    const ok = await agent.patch('/api/v1/organizations').send({ taxNumber: '51824753556' });
    expect(ok.status).toBe(200);
    expect(ok.body.organization.taxNumber).toBe(ABN);
  });
});

describe('a generic organization', () => {
  it('keeps free-text numbers and the old pro-rata posting, with no GST review', async () => {
    const other = await createUserWithOrg({ label: 'g' });
    const otherAgent = await loginAgent(app, other);
    const raw = await otherAgent.post('/api/v1/customers').send({ name: 'A', taxNumber: '51 824 753 557' });
    expect(raw.body.customer.taxNumber).toBe('51 824 753 557');
    expect((await otherAgent.patch('/api/v1/organizations').send({ taxNumber: 'anything' })).status).toBe(200);

    const id = await seed(other.orgId, other.id, { taxCents: 1_000, totalCents: 16_000, currency: 'USD', lines: [{ amountCents: 10_000 }, { amountCents: 5_000 }] });
    const read = await otherAgent.get(`${CAPTURE}/${id}`);
    expect(read.body.document.gstReview).toBeNull();
    expect((await otherAgent.post(`${CAPTURE}/${id}/post`).send({})).status).toBe(200);
    const { rows } = await pool.query<{ tax_code: string | null; tax_cents: string }>(
      `SELECT l.tax_code, l.tax_cents::text FROM bill_lines l WHERE l.org_id = $1 ORDER BY l.line_number`,
      [other.orgId],
    );
    expect(rows).toEqual([
      { tax_code: null, tax_cents: '667' },
      { tax_code: null, tax_cents: '333' },
    ]);
    expect((await otherAgent.patch(`${CAPTURE}/${id}/line-items/00000000-0000-0000-0000-000000000000`).send({ taxCode: 'P_GST' })).status).toBeGreaterThanOrEqual(400);
    expect((await otherAgent.get('/api/v1/abn/status')).status).toBe(403);
  });

  it('cannot read or code another organization’s document', async () => {
    const id = await seed(user.orgId, user.id, { taxCents: 0, totalCents: 100, lines: [{ amountCents: 100 }] });
    const lineId = ((await agent.get(`${CAPTURE}/${id}`)).body.document.lineItems as { id: string }[])[0]?.id ?? '';
    const other = await createUserWithOrg({ label: 'x' });
    const otherAgent = await loginAgent(app, other);
    await otherAgent.post('/api/v1/settings/region/australia').send(ACTIVATE);
    expect((await otherAgent.get(`${CAPTURE}/${id}`)).status).toBe(404);
    expect((await otherAgent.patch(`${CAPTURE}/${id}/line-items/${lineId}`).send({ taxCode: 'P_GST' })).status).toBe(404);
  });
});

describe('ABN Lookup', () => {
  const fake = (body: string, ok = true) => (() => Promise.resolve(new Response(body, { status: ok ? 200 : 500 }))) as unknown as typeof fetch;

  it('is off unless configured', async () => {
    expect((await agent.get('/api/v1/abn/status')).body.lookupEnabled).toBe(env.ABR_GUID !== '');
    if (env.ABR_GUID === '') {
      await expect(lookupAbn(ABN, fake(''))).rejects.toThrow(/not configured/);
    }
  });

  it('parses the JSONP answer, and treats an empty Abn as not found', async () => {
    const original = env.ABR_GUID;
    Object.assign(env, { ABR_GUID: 'test-guid' });
    try {
      const body = 'callback({"Abn":"51824753556","AbnStatus":"Active","EntityName":"AUSTRALIAN TAXATION OFFICE","Gst":"2000-07-01"})';
      await expect(lookupAbn(ABN, fake(body))).resolves.toEqual({
        abn: ABN,
        active: true,
        entityName: 'AUSTRALIAN TAXATION OFFICE',
        gstRegisteredFrom: '2000-07-01',
      });
      await expect(lookupAbn(ABN, fake('callback({"Abn":""})'))).resolves.toBeNull();
      await expect(lookupAbn('51 824 753 557', fake(''))).rejects.toThrow(/not a valid ABN/);
      await expect(lookupAbn(ABN, fake('oops'))).rejects.toThrow(/unexpected/);
      await expect(lookupAbn(ABN, fake('', false))).rejects.toThrow(/could not be reached/);
    } finally {
      Object.assign(env, { ABR_GUID: original });
    }
  });
});
