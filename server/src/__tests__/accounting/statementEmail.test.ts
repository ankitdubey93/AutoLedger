import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { drainEmailOutbox } from '../../services/mail/emailOutboxService.js';
import type { MailTransport } from '../../services/mail/transports.js';
import type { OutgoingEmail } from '../../types/email.js';
import { fillPlaceholders, unknownLegacyPlaceholders } from '../../utils/placeholders.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { latestEmailLink, outboxFor } from '../helpers/email.js';
import { createCustomer, issueInvoice, type Agent } from '../helpers/accountingFixtures.js';
import request from 'supertest';

/**
 * Emailing statements (Phase 39b). Integration tier, real PostgreSQL.
 * Templates with whitelisted placeholders, sending through the outbox in one
 * transaction with a hashed link token, and the public token-scoped view.
 */

const app = createApp();
const TEMPLATES = '/api/v1/settings/statement-email-templates';
const STATEMENTS = '/api/v1/statements';
const PUBLIC = '/api/v1/public/statements';

let userA: SeededUser;
let orgA: string;
let agentA: Agent;
let customerId: string;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'mail-a', orgName: 'Harbor Point' });
  orgA = userA.orgId;
  agentA = await loginAgent(app, userA);
  customerId = await createCustomer(agentA, 'Northwind Traders', 'AP@Northwind.test');
  await issueInvoice(agentA, orgA, customerId, 125000, '2026-06-01', '2026-06-30');
});

afterAll(closePool);

function capture(): { transport: MailTransport; sent: OutgoingEmail[] } {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    transport: {
      name: 'log',
      send(message) {
        sent.push(message);
        return Promise.resolve({ providerMessageId: `test-${String(sent.length)}` });
      },
    },
  };
}

async function sendOne(body: Record<string, unknown> = {}) {
  return agentA
    .post(`${STATEMENTS}/customers/send`)
    .send({ partyIds: [customerId], type: 'OUTSTANDING', asOf: '2026-07-10', ...body });
}

async function linkToken(): Promise<string> {
  const url = await latestEmailLink('ap@northwind.test', 'party_statement');
  return url.pathname.split('/').pop() ?? '';
}

describe('placeholders', () => {
  it('fills bracket and legacy names, once, and reports unknown legacy ones', () => {
    const ctx = { date: '2026-07-01', contactName: '{{balance_due}}', balanceDue: 'USD 1.00' };
    expect(fillPlaceholders('Hi {{ contact_name }}, you owe [Balance Due] {{nope}} [draft]', 'STATEMENT', ctx)).toBe(
      'Hi {{balance_due}}, you owe USD 1.00 {{nope}} [draft]',
    );
    expect(unknownLegacyPlaceholders('{{nope}} {{balance_due}} {{nope}} {{x_y}}')).toEqual(['nope', 'x_y']);
  });
});

describe('/settings/statement-email-templates', () => {
  it('lists the built-in default per kind until the org saves its own', async () => {
    const res = await agentA.get(TEMPLATES);
    expect(res.status).toBe(200);
    expect(res.body.templates.map((t: { partyKind: string; builtIn: boolean }) => [t.partyKind, t.builtIn])).toEqual([
      ['CUSTOMER', true],
      ['VENDOR', true],
    ]);
  });

  it('first template of a kind becomes the default; making another default moves it; deleting promotes', async () => {
    const first = await agentA
      .post(TEMPLATES)
      .send({ partyKind: 'CUSTOMER', name: 'Friendly', subject: 'Hi {{contact_name}}', body: 'You owe {{balance_due}}' });
    expect(first.status).toBe(201);
    expect(first.body.template.isDefault).toBe(true);

    const second = await agentA
      .post(TEMPLATES)
      .send({ partyKind: 'CUSTOMER', name: 'Firm', subject: 'Overdue', body: 'Pay {{overdue_amount}}', isDefault: true });
    expect(second.body.template.isDefault).toBe(true);

    const list = await agentA.get(`${TEMPLATES}?kind=CUSTOMER`);
    expect(list.body.templates.map((t: { name: string; isDefault: boolean }) => [t.name, t.isDefault])).toEqual([
      ['Firm', true],
      ['Friendly', false],
    ]);

    expect((await agentA.delete(`${TEMPLATES}/${second.body.template.id}`)).status).toBe(204);
    const after = await agentA.get(`${TEMPLATES}?kind=CUSTOMER`);
    expect(after.body.templates).toEqual([expect.objectContaining({ name: 'Friendly', isDefault: true })]);
  });

  it('refuses unknown placeholders (422), un-defaulting (422), and a VIEWER (403)', async () => {
    const bad = await agentA
      .post(TEMPLATES)
      .send({ partyKind: 'CUSTOMER', name: 'Bad', subject: 'Hi {{first_name}}', body: 'x' });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('Unknown placeholder: {{first_name}}');

    const ok = await agentA.post(TEMPLATES).send({ partyKind: 'CUSTOMER', name: 'Ok', subject: 's', body: 'b' });
    expect((await agentA.patch(`${TEMPLATES}/${ok.body.template.id}`).send({ isDefault: false })).status).toBe(422);

    const viewer = await createUserWithOrg({ label: 'mail-viewer', orgName: 'Viewer Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    expect((await agent.get(TEMPLATES)).status).toBe(403);
    expect((await agent.post(TEMPLATES).send({ partyKind: 'CUSTOMER', name: 'V', subject: 's', body: 'b' })).status).toBe(403);
    expect((await agent.post(`${STATEMENTS}/customers/send`).send({ partyIds: [customerId] })).status).toBe(403);
  });
});

describe('POST /statements/customers/send', () => {
  it('writes one send (token hashed) and one outbox email with the filled template', async () => {
    const res = await sendOne();
    expect(res.status).toBe(201);
    expect(res.body.sent).toEqual([expect.objectContaining({ partyId: customerId, toEmail: 'ap@northwind.test' })]);
    expect(res.body.skipped).toEqual([]);

    const [row] = await outboxFor('ap@northwind.test', 'party_statement');
    expect(row?.org_id).toBe(orgA);
    expect(row?.template_data.subject).toBe('Statement from Harbor Point');
    expect(row?.template_data.body).toContain('Balance due: USD 1,250.00');
    expect(row?.template_data.body).toContain('Hi Northwind Traders,');

    const token = await linkToken();
    const url = await latestEmailLink('ap@northwind.test', 'party_statement');
    expect(url.pathname).toBe(`/statement/${token}`);
    const { rows } = await pool.query<{ token_hash: string }>('SELECT token_hash FROM statement_sends');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toContain(token);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders HTML-escaped and clears the link once sent', async () => {
    await agentA.patch(`/api/v1/customers/${customerId}`).send({ name: '<script>alert(1)</script>' });
    await sendOne();
    const { transport, sent } = capture();
    await drainEmailOutbox({ transport });
    // Registration's own verification email drains too; read only the statement.
    const statementEmails = sent.filter((m) => m.to.email === 'ap@northwind.test');
    expect(statementEmails).toHaveLength(1);
    const html = statementEmails[0]?.html ?? '';
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Review and pay');
    const [row] = await outboxFor('ap@northwind.test', 'party_statement');
    expect(row?.status).toBe('SENT');
    expect(row?.secret_link).toBeNull();
  });

  it('skips a party without an email; toEmail overrides only for one party', async () => {
    const noEmail = await createCustomer(agentA, 'No Email Co');
    const res = await agentA
      .post(`${STATEMENTS}/customers/send`)
      .send({ partyIds: [customerId, noEmail], type: 'OUTSTANDING' });
    expect(res.status).toBe(201);
    expect(res.body.sent).toHaveLength(1);
    expect(res.body.skipped).toEqual([{ partyId: noEmail, name: 'No Email Co', reason: 'NO_EMAIL' }]);

    const override = await agentA
      .post(`${STATEMENTS}/customers/send`)
      .send({ partyIds: [noEmail], toEmail: 'Billing@NoEmail.test' });
    expect(override.body.sent[0].toEmail).toBe('billing@noemail.test');

    const twoWithOverride = await agentA
      .post(`${STATEMENTS}/customers/send`)
      .send({ partyIds: [customerId, noEmail], toEmail: 'x@y.test' });
    expect(twoWithOverride.status).toBe(422);
  });

  it('fills a saved legacy {{name}} template and bracket placeholders alike (Phase 40)', async () => {
    const mixed = await agentA.post(TEMPLATES).send({
      partyKind: 'CUSTOMER',
      name: 'Mixed',
      subject: '{{organization_name}} [Statement Date] [draft]',
      body: 'Hi [Contact Name], you owe {{balance_due}} as at [Date].',
    });
    expect(mixed.status).toBe(201);
    await sendOne({ templateId: mixed.body.template.id });
    const [row] = await outboxFor('ap@northwind.test', 'party_statement');
    expect(row?.template_data.subject).toBe('Harbor Point 10 Jul 2026 [draft]');
    expect(row?.template_data.body).toBe('Hi Northwind Traders, you owe USD 1,250.00 as at 10 Jul 2026.');
  });

  it('uses the chosen template, and refuses a vendor template for a customer', async () => {
    const custom = await agentA
      .post(TEMPLATES)
      .send({ partyKind: 'CUSTOMER', name: 'Short', subject: '{{organization_name}}: {{overdue_amount}} overdue', body: 'Pay up.' });
    await sendOne({ templateId: custom.body.template.id });
    const [row] = await outboxFor('ap@northwind.test', 'party_statement');
    expect(row?.template_data.subject).toBe('Harbor Point: USD 1,250.00 overdue');

    const vendorTemplate = await agentA
      .post(TEMPLATES)
      .send({ partyKind: 'VENDOR', name: 'V', subject: 's', body: 'b' });
    expect((await sendOne({ templateId: vendorTemplate.body.template.id })).status).toBe(422);
  });

  it('preview-email returns what the party would receive; the list shows lastSentAt', async () => {
    const preview = await agentA
      .post(`${STATEMENTS}/customers/preview-email`)
      .send({ partyId: customerId, type: 'OUTSTANDING', asOf: '2026-07-10' });
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({ toEmail: 'ap@northwind.test', subject: 'Statement from Harbor Point' });
    expect(preview.body.preview.body).toContain('Overdue: USD 1,250.00');

    await sendOne();
    const list = await agentA.get(`${STATEMENTS}/customers?asOf=2026-07-10`);
    expect(list.body.parties[0].lastSentAt).not.toBeNull();
    const sends = await agentA.get(`${STATEMENTS}/customers/${customerId}/sends`);
    expect(sends.body.sends).toEqual([
      expect.objectContaining({ statementType: 'OUTSTANDING', asOf: '2026-07-10', toEmail: 'ap@northwind.test', revokedAt: null }),
    ]);
  });
});

describe('GET /public/statements/:token', () => {
  it('shows the statement as sent and what is open today, with no session; stamps lastViewedAt', async () => {
    await sendOne();
    const token = await linkToken();

    const res = await request(app).get(`${PUBLIC}/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.merchant).toMatchObject({ name: 'Harbor Point', hasLogo: false });
    expect(res.body.partyName).toBe('Northwind Traders');
    expect(res.body.statement).toMatchObject({ type: 'OUTSTANDING', statementDate: '2026-07-10', outstandingCents: 125000 });
    expect(res.body.current.items).toHaveLength(1);
    expect(res.body.payment).toEqual({ enabled: false, publishableKey: null });

    const sends = await agentA.get(`${STATEMENTS}/customers/${customerId}/sends`);
    expect(sends.body.sends[0].lastViewedAt).not.toBeNull();
  });

  it('unknown, revoked and expired tokens are the same 404', async () => {
    expect((await request(app).get(`${PUBLIC}/not-a-real-token-at-all-xxxxxxxxx`)).status).toBe(404);

    const sent = await sendOne();
    const token = await linkToken();
    const revoke = await agentA.post(`/api/v1/statement-sends/${sent.body.sent[0].sendId}/revoke`).send({});
    expect(revoke.status).toBe(200);
    const revoked = await request(app).get(`${PUBLIC}/${token}`);
    expect(revoked.status).toBe(404);
    expect(revoked.body.error).toBe('This statement link is not valid or has expired');

    await sendOne();
    const token2 = await linkToken();
    await pool.query("UPDATE statement_sends SET created_at = now() - interval '61 days', expires_at = now() - interval '1 day' WHERE revoked_at IS NULL");
    expect((await request(app).get(`${PUBLIC}/${token2}`)).status).toBe(404);
  });

  it('logo is 404 when the organization has none', async () => {
    await sendOne();
    expect((await request(app).get(`${PUBLIC}/${await linkToken()}/logo`)).status).toBe(404);
  });
});

describe('cross-tenant isolation', () => {
  it("org B cannot send to, preview, list sends of, or revoke org A's statements; A's token shows only A", async () => {
    const userB = await createUserWithOrg({ label: 'mail-b', orgName: 'Bravo' });
    const agentB = await loginAgent(app, userB);
    const sent = await sendOne();

    expect((await agentB.post(`${STATEMENTS}/customers/send`).send({ partyIds: [customerId] })).status).toBe(404);
    expect(
      (await agentB.post(`${STATEMENTS}/customers/preview-email`).send({ partyId: customerId })).status,
    ).toBe(404);
    expect((await agentB.get(`${STATEMENTS}/customers/${customerId}/sends`)).status).toBe(404);
    expect((await agentB.post(`/api/v1/statement-sends/${sent.body.sent[0].sendId}/revoke`).send({})).status).toBe(404);

    const templateA = await agentA.post(TEMPLATES).send({ partyKind: 'CUSTOMER', name: 'A only', subject: 's', body: 'b' });
    const customerB = await createCustomer(agentB, 'Bravo Customer', 'b@bravo.test');
    expect(
      (await agentB.post(`${STATEMENTS}/customers/send`).send({ partyIds: [customerB], templateId: templateA.body.template.id }))
        .status,
    ).toBe(404);
    expect((await agentB.patch(`${TEMPLATES}/${templateA.body.template.id}`).send({ name: 'x' })).status).toBe(404);
    expect((await agentB.delete(`${TEMPLATES}/${templateA.body.template.id}`)).status).toBe(404);

    const view = await request(app).get(`${PUBLIC}/${await linkToken()}`);
    expect(view.body.merchant.name).toBe('Harbor Point');
  });
});
