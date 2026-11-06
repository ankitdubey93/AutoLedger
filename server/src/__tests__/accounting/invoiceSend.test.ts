import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { drainEmailOutbox } from '../../services/mail/emailOutboxService.js';
import { resolveInvoiceAttachment } from '../../services/accounting/invoicePdfService.js';
import * as historyService from '../../services/historyService.js';
import type { MailTransport } from '../../services/mail/transports.js';
import type { OutgoingEmail } from '../../types/email.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { outboxFor } from '../helpers/email.js';
import { accountId, createCustomer, issueInvoice, type Agent } from '../helpers/accountingFixtures.js';

/**
 * Phase 48 — emailing an issued invoice. Integration tier, real PostgreSQL.
 * One transaction writes the send row, the outbox row and a history event;
 * "sent" is derived, never written to the immutable invoice.
 */

const app = createApp();
const INVOICES = '/api/v1/invoices';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let agentA: Agent;
let agentB: Agent;
let customerId: string;
let invoice: { id: string; number: string };

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetTables();
  userA = await createUserWithOrg({ label: 'send-a', orgName: 'Harbor Point' });
  userB = await createUserWithOrg({ label: 'send-b', orgName: 'Other Org' });
  orgA = userA.orgId;
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  customerId = await createCustomer(agentA, 'Northwind Traders', 'AP@Northwind.test');
  invoice = await issueInvoice(agentA, orgA, customerId, 125000, '2026-06-01', '2026-06-30');
});

afterAll(closePool);

async function counts(): Promise<{ sends: number; outbox: number }> {
  const s = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM invoice_sends');
  const o = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM email_outbox WHERE template LIKE 'invoice_%'");
  return { sends: Number(s.rows[0]?.n), outbox: Number(o.rows[0]?.n) };
}

async function createDraft(): Promise<string> {
  const revenueAccountId = await accountId(orgA, '4100');
  const res = await agentA.post(INVOICES).send({
    customerId,
    issueDate: '2026-06-01',
    dueDate: '2026-06-30',
    notes: null,
    paymentTerms: null,
    lines: [{ description: 'x', quantityMilli: 1000, unitPriceCents: 1000, revenueAccountId, taxRateBp: 0 }],
  });
  expect(res.status).toBe(201);
  return res.body.invoice.id as string;
}

describe('POST /invoices/:id/send', () => {
  it('writes a hashed send, an outbox row referencing the PDF, and derives lastSentAt', async () => {
    const res = await agentA.post(`${INVOICES}/${invoice.id}/send`).send({});
    expect(res.status).toBe(201);
    expect(res.body.send).toEqual(
      expect.objectContaining({ invoiceId: invoice.id, sendKind: 'MANUAL', toEmail: 'ap@northwind.test' }),
    );

    const [row] = await outboxFor('ap@northwind.test', 'invoice_sent');
    expect(row?.org_id).toBe(orgA);
    const attach = await pool.query<{ attachment_kind: string; attachment_ref_id: string; secret_link: string | null }>(
      'SELECT attachment_kind, attachment_ref_id, secret_link FROM email_outbox WHERE id = $1',
      [row?.id],
    );
    expect(attach.rows[0]?.attachment_kind).toBe('INVOICE_PDF');
    expect(attach.rows[0]?.attachment_ref_id).toBe(invoice.id);

    const { rows } = await pool.query<{ token_hash: string }>('SELECT token_hash FROM invoice_sends');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // The raw token appears only in the emailed link, never in the stored hash.
    const { latestEmailLink } = await import('../helpers/email.js');
    const url = await latestEmailLink('ap@northwind.test', 'invoice_sent');
    const token = url.pathname.split('/').pop() ?? '';
    expect(url.pathname).toBe(`/invoice/${token}`);
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(rows[0]?.token_hash).not.toContain(token);

    const read = await agentA.get(`${INVOICES}/${invoice.id}`);
    expect(read.body.invoice.lastSentAt).not.toBeNull();
  });

  it('refuses a draft and a void invoice (422) and writes nothing', async () => {
    const draftId = await createDraft();
    const draft = await agentA.post(`${INVOICES}/${draftId}/send`).send({});
    expect(draft.status).toBe(422);
    expect(draft.body.error).toBe('Only an issued invoice can be sent');

    expect((await agentA.post(`${INVOICES}/${invoice.id}/void`).send({})).status).toBe(200);
    const voided = await agentA.post(`${INVOICES}/${invoice.id}/send`).send({});
    expect(voided.status).toBe(422);
    expect(voided.body.error).toBe('Only an issued invoice can be sent');

    expect(await counts()).toEqual({ sends: 0, outbox: 0 });
  });

  it('needs an address: 422 without one, and a supplied address is lowercased', async () => {
    const noEmail = await createCustomer(agentA, 'No Email Ltd');
    const inv = await issueInvoice(agentA, orgA, noEmail, 5000, '2026-06-01', '2026-06-30');
    const refused = await agentA.post(`${INVOICES}/${inv.id}/send`).send({});
    expect(refused.status).toBe(422);
    expect(await counts()).toEqual({ sends: 0, outbox: 0 });

    const ok = await agentA.post(`${INVOICES}/${inv.id}/send`).send({ toEmail: 'X@Example.COM' });
    expect(ok.status).toBe(201);
    expect(ok.body.send.toEmail).toBe('x@example.com');
    const stored = await pool.query<{ to_email: string }>('SELECT to_email FROM invoice_sends WHERE org_id = $1', [orgA]);
    expect(stored.rows.map((r) => r.to_email)).toEqual(['x@example.com']);
  });

  it('a FAILED outbox row does not count as sent', async () => {
    expect((await agentA.post(`${INVOICES}/${invoice.id}/send`).send({})).status).toBe(201);
    await pool.query("UPDATE email_outbox SET status = 'FAILED', secret_link = NULL WHERE template = 'invoice_sent'");
    const read = await agentA.get(`${INVOICES}/${invoice.id}`);
    expect(read.body.invoice.lastSentAt).toBeNull();
    const sends = await agentA.get(`${INVOICES}/${invoice.id}/sends`);
    expect(sends.status).toBe(200);
    expect(sends.body.sends[0].deliveryStatus).toBe('FAILED');
  });

  it('the drain attaches the rendered PDF', async () => {
    expect((await agentA.post(`${INVOICES}/${invoice.id}/send`).send({})).status).toBe(201);
    const sent: OutgoingEmail[] = [];
    const transport: MailTransport = {
      name: 'log',
      send(message) {
        sent.push(message);
        return Promise.resolve({ providerMessageId: 'test-1' });
      },
    };
    await drainEmailOutbox({
      transport,
      resolveAttachment: (_kind, orgId, refId) => resolveInvoiceAttachment(orgId, refId),
    });
    const message = sent.find((m) => m.to.email === 'ap@northwind.test');
    const attachment = message?.attachments?.[0];
    expect(attachment).toBeDefined();
    expect(Buffer.isBuffer(attachment?.content)).toBe(true);
    expect(attachment?.content.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(attachment?.filename).toBe(`${invoice.number}.pdf`);
    expect(attachment?.filename).toMatch(/^INV-.*\.pdf$/);
  });

  it("org B cannot send, list or revoke org A's invoice (404) and nothing is queued", async () => {
    expect((await agentB.post(`${INVOICES}/${invoice.id}/send`).send({ toEmail: 'a@b.test' })).status).toBe(404);
    expect((await agentB.get(`${INVOICES}/${invoice.id}/sends`)).status).toBe(404);

    const sent = await agentA.post(`${INVOICES}/${invoice.id}/send`).send({});
    const sendId = sent.body.send.id as string;
    const before = await counts();
    expect((await agentB.post(`${INVOICES}/${invoice.id}/sends/${sendId}/revoke`).send({})).status).toBe(404);
    const row = await pool.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM invoice_sends WHERE id = $1', [sendId]);
    expect(row.rows[0]?.revoked_at).toBeNull();
    expect(await counts()).toEqual(before);

    const orgBOutbox = await pool.query('SELECT 1 FROM email_outbox WHERE org_id = $1', [userB.orgId]);
    expect(orgBOutbox.rowCount).toBe(0);
  });

  it('revoke is idempotent and org-scoped for the owner', async () => {
    const sent = await agentA.post(`${INVOICES}/${invoice.id}/send`).send({});
    const sendId = sent.body.send.id as string;
    const first = await agentA.post(`${INVOICES}/${invoice.id}/sends/${sendId}/revoke`).send({});
    expect(first.status).toBe(200);
    expect(first.body.send.revokedAt).not.toBeNull();
    const second = await agentA.post(`${INVOICES}/${invoice.id}/sends/${sendId}/revoke`).send({});
    expect(second.body.send.revokedAt).toBe(first.body.send.revokedAt);
  });

  it('a VIEWER can list sends but not send (403)', async () => {
    const viewer = await createUserWithOrg({ label: 'send-viewer', orgName: 'Viewer Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    expect((await agent.post(`${INVOICES}/${invoice.id}/send`).send({})).status).toBe(403);
    expect((await agent.get(`${INVOICES}/${invoice.id}/sends`)).status).toBe(200);
    expect(await counts()).toEqual({ sends: 0, outbox: 0 });
  });

  it('rolls back the send and outbox rows when the history write fails', async () => {
    vi.spyOn(historyService, 'recordEventOnClient').mockRejectedValueOnce(new Error('history down'));
    const res = await agentA.post(`${INVOICES}/${invoice.id}/send`).send({});
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await counts()).toEqual({ sends: 0, outbox: 0 });
  });

  it('leaves the immutable invoice untouched', async () => {
    const before = await pool.query<{ updated_at: Date }>('SELECT updated_at FROM invoices WHERE id = $1', [invoice.id]);
    expect((await agentA.post(`${INVOICES}/${invoice.id}/send`).send({})).status).toBe(201);
    const after = await pool.query<{ updated_at: Date }>('SELECT updated_at FROM invoices WHERE id = $1', [invoice.id]);
    expect(after.rows[0]?.updated_at.toISOString()).toBe(before.rows[0]?.updated_at.toISOString());
  });
});
