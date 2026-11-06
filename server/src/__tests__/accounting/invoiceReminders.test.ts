import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { sendDueRemindersForOrg } from '../../services/accounting/invoiceReminderService.js';
import * as historyService from '../../services/historyService.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { createCustomer, issueInvoice, receivePayment, type Agent } from '../helpers/accountingFixtures.js';
import { latestEmailLink } from '../helpers/email.js';

/**
 * Phase 48 — invoice reminders. Integration tier, real PostgreSQL.
 * This file starts with the settings cases (Step 14); the sweep cases follow.
 */

const app = createApp();
const SETTINGS = '/api/v1/settings/invoicing';

let userA: SeededUser;
let userB: SeededUser;
let agentA: Agent;
let agentB: Agent;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'rem-a', orgName: 'Harbor Point' });
  userB = await createUserWithOrg({ label: 'rem-b', orgName: 'Other Org' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
});

afterAll(closePool);

describe('reminder settings', () => {
  it('defaults to off with 7/14/30 days', async () => {
    const res = await agentA.get(SETTINGS);
    expect(res.status).toBe(200);
    expect(res.body.invoiceSettings).toMatchObject({ remindersEnabled: false, reminderOffsetsDays: [7, 14, 30] });
  });

  it('stores the offsets ascending and reads them back', async () => {
    const res = await agentA.patch(SETTINGS).send({ remindersEnabled: true, reminderOffsetsDays: [14, 7, -3] });
    expect(res.status).toBe(200);
    const read = await agentA.get(SETTINGS);
    expect(read.body.invoiceSettings).toMatchObject({ remindersEnabled: true, reminderOffsetsDays: [-3, 7, 14] });
  });

  it('rejects an empty list, duplicates and an out-of-range day (400)', async () => {
    expect((await agentA.patch(SETTINGS).send({ reminderOffsetsDays: [] })).status).toBe(400);
    expect((await agentA.patch(SETTINGS).send({ reminderOffsetsDays: [7, 7] })).status).toBe(400);
    expect((await agentA.patch(SETTINGS).send({ reminderOffsetsDays: [400] })).status).toBe(400);
  });

  it("one organization's change does not alter another's", async () => {
    await agentA.patch(SETTINGS).send({ remindersEnabled: true, reminderOffsetsDays: [3] });
    const b = await agentB.get(SETTINGS);
    expect(b.body.invoiceSettings).toMatchObject({ remindersEnabled: false, reminderOffsetsDays: [7, 14, 30] });
  });

  it('a VIEWER cannot change them (403)', async () => {
    const viewer = await createUserWithOrg({ label: 'rem-viewer', orgName: 'Viewer Solo' });
    await addMember(userA.orgId, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: userA.orgId });
    expect((await agent.patch(SETTINGS).send({ remindersEnabled: true })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------- sweep

const INVOICES = '/api/v1/invoices';
const CUSTOMER_EMAIL = 'ap@northwind.test';
const DUE = '2026-03-01';

async function reminderOutbox(orgId: string) {
  const { rows } = await pool.query<{
    template_data: { overdue?: boolean };
    attachment_kind: string | null;
    attachment_ref_id: string | null;
    status: string;
  }>(
    `SELECT template_data, attachment_kind, attachment_ref_id, status
       FROM email_outbox WHERE org_id = $1 AND template = 'invoice_reminder' ORDER BY created_at`,
    [orgId],
  );
  return rows;
}

async function reminderRows(orgId: string): Promise<{ offset_days: number }[]> {
  const { rows } = await pool.query<{ offset_days: number }>(
    'SELECT offset_days FROM invoice_reminders WHERE org_id = $1 ORDER BY offset_days',
    [orgId],
  );
  return rows;
}

describe('sendDueRemindersForOrg', () => {
  let customerId: string;
  let invoice: { id: string; number: string };

  async function enable(): Promise<void> {
    expect((await agentA.patch(SETTINGS).send({ remindersEnabled: true, reminderOffsetsDays: [7, 14, 30] })).status).toBe(200);
  }

  async function markPreviouslySent(invoiceId: string): Promise<string> {
    const res = await agentA.post(`${INVOICES}/${invoiceId}/send`).send({});
    expect(res.status).toBe(201);
    return res.body.send.id as string;
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    customerId = await createCustomer(agentA, 'Northwind Traders', CUSTOMER_EMAIL);
    invoice = await issueInvoice(agentA, userA.orgId, customerId, 125000, '2026-02-01', DUE);
    await markPreviouslySent(invoice.id);
    await enable();
  });

  it('sends one overdue reminder with the PDF attached, and a second run adds none', async () => {
    expect(await sendDueRemindersForOrg(userA.orgId, '2026-03-08')).toEqual({ sent: 1, failed: 0 });
    const rows = await reminderOutbox(userA.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.template_data.overdue).toBe(true);
    expect(rows[0]?.attachment_kind).toBe('INVOICE_PDF');
    expect(rows[0]?.attachment_ref_id).toBe(invoice.id);
    expect(await reminderRows(userA.orgId)).toEqual([{ offset_days: 7 }]);

    expect(await sendDueRemindersForOrg(userA.orgId, '2026-03-08')).toEqual({ sent: 0, failed: 0 });
    expect(await reminderOutbox(userA.orgId)).toHaveLength(1);
  });

  it('two concurrent sweeps produce exactly one reminder', async () => {
    const results = await Promise.all([
      sendDueRemindersForOrg(userA.orgId, '2026-03-08'),
      sendDueRemindersForOrg(userA.orgId, '2026-03-08'),
    ]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.failed, 0)).toBe(0);
    expect(await reminderOutbox(userA.orgId)).toHaveLength(1);
    expect(await reminderRows(userA.orgId)).toHaveLength(1);
    const sends = await pool.query("SELECT 1 FROM invoice_sends WHERE org_id = $1 AND send_kind = 'REMINDER'", [userA.orgId]);
    expect(sends.rowCount).toBe(1);
  });

  it('catches up with one reminder at the largest passed offset, never the smaller ones', async () => {
    expect(await sendDueRemindersForOrg(userA.orgId, '2026-04-15')).toEqual({ sent: 1, failed: 0 });
    expect(await reminderRows(userA.orgId)).toEqual([{ offset_days: 30 }]);
    expect(await sendDueRemindersForOrg(userA.orgId, '2026-04-15')).toEqual({ sent: 0, failed: 0 });
    expect(await reminderOutbox(userA.orgId)).toHaveLength(1);
  });

  it('sends nothing before the first offset has passed', async () => {
    expect(await sendDueRemindersForOrg(userA.orgId, '2026-03-07')).toEqual({ sent: 0, failed: 0 });
    expect(await reminderOutbox(userA.orgId)).toHaveLength(0);
  });

  it('sends nothing when reminders are disabled', async () => {
    await agentA.patch(SETTINGS).send({ remindersEnabled: false });
    expect(await sendDueRemindersForOrg(userA.orgId, '2026-03-08')).toEqual({ sent: 0, failed: 0 });
    expect(await reminderOutbox(userA.orgId)).toHaveLength(0);
  });

  it('sends nothing for an invoice that was never sent', async () => {
    const never = await issueInvoice(agentA, userA.orgId, customerId, 5000, '2026-02-01', DUE);
    expect(await sendDueRemindersForOrg(userA.orgId, '2026-03-08')).toEqual({ sent: 1, failed: 0 });
    const reminders = await pool.query<{ invoice_id: string }>('SELECT invoice_id FROM invoice_reminders WHERE org_id = $1', [userA.orgId]);
    expect(reminders.rows.map((r) => r.invoice_id)).toEqual([invoice.id]);
    expect(reminders.rows.some((r) => r.invoice_id === never.id)).toBe(false);
  });

  it('sends nothing for a fully paid invoice', async () => {
    await receivePayment(agentA, userA.orgId, customerId, '2026-03-02', [{ invoiceId: invoice.id, amountCents: 125000 }]);
    expect(await sendDueRemindersForOrg(userA.orgId, '2026-03-08')).toEqual({ sent: 0, failed: 0 });
    expect(await reminderOutbox(userA.orgId)).toHaveLength(0);
  });

  it('sends nothing for a void invoice', async () => {
    expect((await agentA.post(`${INVOICES}/${invoice.id}/void`).send({})).status).toBe(200);
    expect(await sendDueRemindersForOrg(userA.orgId, '2026-03-08')).toEqual({ sent: 0, failed: 0 });
    expect(await reminderOutbox(userA.orgId)).toHaveLength(0);
  });

  it('sends nothing once the customer email is removed', async () => {
    await pool.query('UPDATE customers SET email = NULL WHERE id = $1 AND org_id = $2', [customerId, userA.orgId]);
    expect(await sendDueRemindersForOrg(userA.orgId, '2026-03-08')).toEqual({ sent: 0, failed: 0 });
    expect(await reminderOutbox(userA.orgId)).toHaveLength(0);
  });

  it('sends nothing when the only earlier send failed', async () => {
    await pool.query("UPDATE email_outbox SET status = 'FAILED', secret_link = NULL WHERE org_id = $1 AND template = 'invoice_sent'", [userA.orgId]);
    expect(await sendDueRemindersForOrg(userA.orgId, '2026-03-08')).toEqual({ sent: 0, failed: 0 });
    expect(await reminderOutbox(userA.orgId)).toHaveLength(0);
  });

  it('rolls back a failed reminder completely and still reminds the next invoice', async () => {
    const second = await issueInvoice(agentA, userA.orgId, customerId, 7000, '2026-02-01', '2026-03-02');
    await markPreviouslySent(second.id);
    vi.spyOn(historyService, 'recordEventOnClient').mockImplementationOnce(() => {
      throw new Error('history down');
    });

    const result = await sendDueRemindersForOrg(userA.orgId, '2026-03-09');
    expect(result).toEqual({ sent: 1, failed: 1 });
    // The first invoice (earlier due date) rolled back whole; the second got its reminder.
    const reminders = await pool.query<{ invoice_id: string }>('SELECT invoice_id FROM invoice_reminders WHERE org_id = $1', [userA.orgId]);
    expect(reminders.rows.map((r) => r.invoice_id)).toEqual([second.id]);
    const sends = await pool.query("SELECT invoice_id FROM invoice_sends WHERE org_id = $1 AND send_kind = 'REMINDER'", [userA.orgId]);
    expect(sends.rows.map((r: { invoice_id: string }) => r.invoice_id)).toEqual([second.id]);
    expect(await reminderOutbox(userA.orgId)).toHaveLength(1);
  });

  it("another organization's sweep leaves this organization's invoice alone", async () => {
    await agentB.patch(SETTINGS).send({ remindersEnabled: true });
    expect(await sendDueRemindersForOrg(userB.orgId, '2026-03-08')).toEqual({ sent: 0, failed: 0 });
    expect(await reminderOutbox(userA.orgId)).toHaveLength(0);
    expect(await reminderRows(userA.orgId)).toHaveLength(0);
    expect(await reminderOutbox(userB.orgId)).toHaveLength(0);
  });

  it('the reminder token opens the public invoice page', async () => {
    await sendDueRemindersForOrg(userA.orgId, '2026-03-08');
    const url = await latestEmailLink(CUSTOMER_EMAIL, 'invoice_reminder');
    const token = url.pathname.split('/').pop() ?? '';
    const res = await agentB.get(`/api/v1/public/invoices/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.invoice.number).toBe(invoice.number);
  });
});
