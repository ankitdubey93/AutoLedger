import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, type Agent } from '../helpers/accountingFixtures.js';
import { outboxFor } from '../helpers/email.js';

/**
 * Phase 42 slice C — editable quote email templates. Integration tier, real
 * PostgreSQL: defaults, send-time rendering, preview, one default per
 * direction, and tenant isolation.
 */

const app = createApp();
const TEMPLATES = '/api/v1/settings/quote-email-templates';
const QUOTES = '/api/v1/quotes';

const TODAY = new Date().toISOString().slice(0, 10);

let userA: SeededUser;
let userB: SeededUser;
let agentA: Agent;
let agentB: Agent;
let customerA: string;

async function draftQuote(): Promise<string> {
  const res = await agentA.post(QUOTES).send({
    partyId: customerA,
    quoteDate: TODAY,
    title: 'Fit-out',
    lines: [
      {
        description: 'Work',
        quantityMilli: 1000,
        unitPriceCents: 10000,
        accountId: await accountId(userA.orgId, '4100'),
        taxRateBp: 0,
      },
    ],
  });
  if (res.status !== 201) throw new Error(`fixture: quote create failed ${res.status} ${res.text}`);
  return res.body.quote.id as string;
}

async function createTemplate(agent: Agent, extra: Record<string, unknown> = {}) {
  return agent.post(TEMPLATES).send({
    direction: 'SALES',
    name: 'Friendly',
    subject: 'Your quote [Quote Number]',
    body: 'Hello [Contact Name], total [Quote Total].',
    isDefault: false,
    ...extra,
  });
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  customerA = await createCustomer(agentA, 'Acme Fitouts', 'buyer@acme.test');
});

afterAll(closePool);

describe('quote email templates', () => {
  it('GET ?direction=SALES with nothing stored returns the built-in', async () => {
    const res = await agentA.get(`${TEMPLATES}?direction=SALES`);
    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(1);
    expect(res.body.templates[0]).toMatchObject({
      id: null,
      direction: 'SALES',
      name: 'Standard quote',
      builtIn: true,
      isDefault: true,
    });
  });

  it('create a default SALES template; sending a quote uses it — outbox template_data.subject is filled', async () => {
    const created = await createTemplate(agentA, { isDefault: true, subject: 'Quote [Quote Number] from [Organisation Name]' });
    expect(created.status).toBe(201);
    const id = await draftQuote();
    const sent = await agentA.post(`${QUOTES}/${id}/send`).send({ delivery: 'EMAIL', toEmail: 'buyer@acme.test' });
    expect(sent.status).toBe(200);
    const emails = await outboxFor('buyer@acme.test', 'quote_sent');
    expect(emails).toHaveLength(1);
    expect(emails[0]!.template_data).toMatchObject({ subject: 'Quote QU-000001 from Org Alpha' });
    expect((emails[0]!.template_data as { body: string }).body).toContain('Hello Acme Fitouts');
  });

  it('templateId on send picks a non-default template', async () => {
    await createTemplate(agentA, { name: 'Default one', subject: 'Default [Quote Number]', isDefault: true });
    const other = await createTemplate(agentA, { name: 'Other', subject: 'Other [Quote Number]' });
    expect(other.status).toBe(201);
    const id = await draftQuote();
    const sent = await agentA
      .post(`${QUOTES}/${id}/send`)
      .send({ delivery: 'EMAIL', toEmail: 'buyer@acme.test', templateId: other.body.template.id });
    expect(sent.status).toBe(200);
    const emails = await outboxFor('buyer@acme.test', 'quote_sent');
    expect(emails[0]!.template_data).toMatchObject({ subject: 'Other QU-000001' });
  });

  it('an unknown placeholder in a template body → 422 on create', async () => {
    const res = await createTemplate(agentA, { body: 'Hi {{x}}' });
    expect(res.status).toBe(422);
    const { rows } = await pool.query('SELECT 1 FROM quote_email_templates WHERE org_id = $1', [userA.orgId]);
    expect(rows).toHaveLength(0);
  });

  it('email-preview returns the filled subject and body without sending (outbox empty)', async () => {
    const id = await draftQuote();
    const res = await agentA.post(`${QUOTES}/${id}/email-preview`).send({ templateId: null });
    expect(res.status).toBe(200);
    expect(res.body.subject).toContain('from Org Alpha');
    expect(res.body.body).toContain('Hi Acme Fitouts');
    expect(res.body.body).not.toContain('[Contact Name]');
    const { rows } = await pool.query("SELECT 1 FROM email_outbox WHERE template = 'quote_sent'");
    expect(rows).toHaveLength(0);
  });

  it('making a second default unsets the first (one default per direction)', async () => {
    const first = await createTemplate(agentA, { name: 'First', isDefault: true });
    const second = await createTemplate(agentA, { name: 'Second', isDefault: true });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM quote_email_templates WHERE org_id = $1 AND direction = 'SALES' AND is_default`,
      [userA.orgId],
    );
    expect(rows.map((r) => r.name)).toEqual(['Second']);
  });

  it("org B cannot read, patch or delete org A's template → 404", async () => {
    const created = await createTemplate(agentA, { isDefault: true });
    const id = created.body.template.id as string;
    const listB = await agentB.get(`${TEMPLATES}?direction=SALES`);
    expect(listB.body.templates.every((t: { id: string | null }) => t.id !== id)).toBe(true);
    expect((await agentB.patch(`${TEMPLATES}/${id}`).send({ name: 'Hijack' })).status).toBe(404);
    expect((await agentB.delete(`${TEMPLATES}/${id}`)).status).toBe(404);
    const { rows } = await pool.query<{ name: string }>('SELECT name FROM quote_email_templates WHERE id = $1', [id]);
    expect(rows[0]!.name).toBe('Friendly');
  });

  it("org B's templateId on org A's send → 422 Email template not found", async () => {
    const theirs = await createTemplate(agentB, { isDefault: true });
    expect(theirs.status).toBe(201);
    const id = await draftQuote();
    const res = await agentA
      .post(`${QUOTES}/${id}/send`)
      .send({ delivery: 'EMAIL', toEmail: 'buyer@acme.test', templateId: theirs.body.template.id });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('Email template not found');
    const status = await pool.query<{ status: string }>('SELECT status FROM quotes WHERE id = $1', [id]);
    expect(status.rows[0]!.status).toBe('DRAFT');
  });
});
