import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { drainEmailOutbox, enqueueEmailOnClient } from '../../services/mail/emailOutboxService.js';
import { renderEmail } from '../../services/mail/templates.js';
import {
  createBrevoTransport,
  createMailpitTransport,
  MailSendError,
  type MailTransport,
} from '../../services/mail/transports.js';
import type { OutgoingEmail } from '../../types/email.js';
import { addMember, createUserWithOrg, loginAgent, resetTables, uniqueEmail } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { latestEmailToken, outboxFor } from '../helpers/email.js';

/**
 * Phase 38b — email: the transactional outbox and its drain, the three
 * transports, templates, verification, change of sign-in email,
 * organization sender settings and notification preferences.
 */

const app = createApp();

let alice: SeededUser;

beforeEach(async () => {
  await resetTables();
  alice = await createUserWithOrg({ label: 'alice', orgName: 'Alpha Ltd' });
});

afterAll(closePool);

/** A transport that records what it was asked to send, or fails as told. */
function fakeTransport(behaviour: 'ok' | 'retryable' | 'permanent' = 'ok') {
  const sent: OutgoingEmail[] = [];
  const transport: MailTransport = {
    name: 'log',
    send(message) {
      if (behaviour === 'retryable') return Promise.reject(new MailSendError('503 try later', false));
      if (behaviour === 'permanent') return Promise.reject(new MailSendError('400 invalid sender', true));
      sent.push(message);
      return Promise.resolve({ providerMessageId: `msg-${String(sent.length)}` });
    },
  };
  return { transport, sent };
}

async function enqueueOne(template: 'password_reset' | 'invitation' = 'password_reset', link: string | null = 'http://x/reset?token=t') {
  const client = await pool.connect();
  try {
    return await enqueueEmailOnClient(client, { orgId: null, to: 'Someone@Example.com', template, link });
  } finally {
    client.release();
  }
}

describe('the outbox drain', () => {
  // Registering alice in the outer beforeEach queued her verification email;
  // these cases count rows, so they start from an empty outbox.
  beforeEach(async () => {
    await pool.query('DELETE FROM email_outbox');
  });

  it('sends a due row, marks it SENT and clears its link', async () => {
    const id = await enqueueOne();
    const { transport, sent } = fakeTransport();

    const result = await drainEmailOutbox({ transport });

    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0, retried: 0 });
    expect(sent[0]?.to.email).toBe('someone@example.com');
    expect(sent[0]?.text).toContain('http://x/reset?token=t');
    const { rows } = await pool.query('SELECT status, secret_link, provider_message_id FROM email_outbox WHERE id = $1', [id]);
    expect(rows[0]).toMatchObject({ status: 'SENT', secret_link: null, provider_message_id: 'msg-1' });

    // Nothing left to do on the next pass.
    expect((await drainEmailOutbox({ transport })).claimed).toBe(0);
  });

  it('backs off a retryable failure and keeps the link', async () => {
    const id = await enqueueOne();
    const result = await drainEmailOutbox({ transport: fakeTransport('retryable').transport });

    expect(result.retried).toBe(1);
    const { rows } = await pool.query<{ status: string; attempts: number; secret_link: string | null; due_later: boolean }>(
      'SELECT status, attempts, secret_link, next_attempt_at > now() AS due_later FROM email_outbox WHERE id = $1',
      [id],
    );
    expect(rows[0]).toMatchObject({ status: 'PENDING', attempts: 1, due_later: true });
    expect(rows[0]?.secret_link).not.toBeNull();
    // Not due yet, so the next pass does not touch it.
    expect((await drainEmailOutbox({ transport: fakeTransport().transport })).claimed).toBe(0);
  });

  it('fails a permanent error at once and clears the link', async () => {
    const id = await enqueueOne();
    const result = await drainEmailOutbox({ transport: fakeTransport('permanent').transport });
    expect(result.failed).toBe(1);
    const { rows } = await pool.query('SELECT status, secret_link, last_error FROM email_outbox WHERE id = $1', [id]);
    expect(rows[0]).toMatchObject({ status: 'FAILED', secret_link: null });
    expect(rows[0].last_error).toContain('invalid sender');
  });

  it('gives up after the last attempt', async () => {
    const id = await enqueueOne();
    await pool.query('UPDATE email_outbox SET attempts = 4 WHERE id = $1', [id]);
    const result = await drainEmailOutbox({ transport: fakeTransport('retryable').transport });
    expect(result.failed).toBe(1);
  });

  it('reclaims a row a crashed worker left in SENDING (at-least-once)', async () => {
    const id = await enqueueOne();
    await pool.query(
      "UPDATE email_outbox SET status = 'SENDING', claimed_at = now() - interval '10 minutes', attempts = 1 WHERE id = $1",
      [id],
    );
    const { transport, sent } = fakeTransport();
    const result = await drainEmailOutbox({ transport });
    expect(result.reclaimed).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('never lets two concurrent drains send the same row', async () => {
    for (let i = 0; i < 6; i += 1) await enqueueOne();
    const a = fakeTransport();
    const b = fakeTransport();
    await Promise.all([drainEmailOutbox({ transport: a.transport }), drainEmailOutbox({ transport: b.transport })]);
    expect(a.sent.length + b.sent.length).toBe(6);
  });

  it('refuses, in the database, a finished row that still carries its link', async () => {
    const id = await enqueueOne();
    await expect(
      pool.query("UPDATE email_outbox SET status = 'FAILED' WHERE id = $1", [id]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('transports', () => {
  const message: OutgoingEmail = {
    to: { email: 'to@example.com', name: 'To Person' },
    from: { email: 'from@example.com', name: 'Alpha Ltd' },
    replyTo: 'books@alpha.test',
    subject: 'Hello',
    html: '<p>Hi</p>',
    text: 'Hi',
  };

  it('Brevo: POSTs /v3/smtp/email with the api-key header and the documented body', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = ((url: string, init: RequestInit) => {
      captured = { url, init };
      return Promise.resolve(new Response(JSON.stringify({ messageId: '<abc@relay>' }), { status: 201 }));
    }) as unknown as typeof fetch;

    const result = await createBrevoTransport('test-key', fetchImpl).send(message);

    expect(result.providerMessageId).toBe('<abc@relay>');
    const call = captured as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((call.init.headers as Record<string, string>)['api-key']).toBe('test-key');
    expect(JSON.parse(String(call.init.body))).toEqual({
      sender: { email: 'from@example.com', name: 'Alpha Ltd' },
      to: [{ email: 'to@example.com', name: 'To Person' }],
      replyTo: { email: 'books@alpha.test' },
      subject: 'Hello',
      htmlContent: '<p>Hi</p>',
      textContent: 'Hi',
    });
  });

  it('Brevo: a 400 is permanent, a 429 or 5xx is retryable, a network error is retryable', async () => {
    const respond = (status: number) =>
      (() => Promise.resolve(new Response('{"code":"x"}', { status }))) as unknown as typeof fetch;
    await expect(createBrevoTransport('k', respond(400)).send(message)).rejects.toMatchObject({ permanent: true });
    await expect(createBrevoTransport('k', respond(429)).send(message)).rejects.toMatchObject({ permanent: false });
    await expect(createBrevoTransport('k', respond(502)).send(message)).rejects.toMatchObject({ permanent: false });
    const offline = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    await expect(createBrevoTransport('k', offline).send(message)).rejects.toMatchObject({ permanent: false });
  });

  it("Mailpit: POSTs /api/v1/send with Mailpit's field names", async () => {
    let body: unknown = null;
    let url = '';
    const fetchImpl = ((u: string, init: RequestInit) => {
      url = u;
      body = JSON.parse(String(init.body));
      return Promise.resolve(new Response(JSON.stringify({ ID: 'mp-1' }), { status: 200 }));
    }) as unknown as typeof fetch;
    const result = await createMailpitTransport('http://localhost:8025/', fetchImpl).send(message);
    expect(url).toBe('http://localhost:8025/api/v1/send');
    expect(result.providerMessageId).toBe('mp-1');
    expect(body).toMatchObject({
      From: { Email: 'from@example.com', Name: 'Alpha Ltd' },
      To: [{ Email: 'to@example.com', Name: 'To Person' }],
      ReplyTo: [{ Email: 'books@alpha.test' }],
      Subject: 'Hello',
    });
  });
});

describe('templates', () => {
  it('escapes user-controlled values in the HTML part', () => {
    const rendered = renderEmail(
      'invitation',
      { organizationName: '<img src=x onerror=alert(1)>', inviterName: 'Eve', roleLabel: 'VIEWER' },
      'http://localhost/invite/t',
    );
    expect(rendered.html).not.toContain('<img src=x');
    expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(rendered.text).toContain('http://localhost/invite/t');
  });
});

describe('producers write on the same transaction', () => {
  it('forgot-password for an unknown address writes nothing', async () => {
    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'nobody@example.com' }).expect(202);
    expect(await outboxFor('nobody@example.com')).toHaveLength(0);
  });

  it('an invitation is emailed with the organization sender settings; a refused one emails nothing', async () => {
    const agent = await loginAgent(app, alice);
    await agent
      .patch('/api/v1/organizations/email-settings')
      .send({ senderName: 'Alpha Books', replyTo: 'Books@Alpha.test' })
      .expect(200);

    await agent.post('/api/v1/organizations/invitations').send({ email: 'new@example.com', role: 'VIEWER' }).expect(201);
    const [row] = await outboxFor('new@example.com', 'invitation');
    expect(row).toMatchObject({
      org_id: alice.orgId,
      sender_name: 'Alpha Books',
      reply_to: 'books@alpha.test',
    });
    expect(row?.template_data).toMatchObject({ organizationName: 'Alpha Ltd', roleLabel: 'VIEWER' });

    // Already a member → 409, and the rollback takes the email with it.
    await agent.post('/api/v1/organizations/invitations').send({ email: alice.email, role: 'VIEWER' }).expect(409);
    expect(await outboxFor(alice.email, 'invitation')).toHaveLength(0);
  });
});

describe('email verification', () => {
  it('register sends a verification email; the link verifies once', async () => {
    const email = uniqueEmail('verify');
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'a-perfectly-fine-password', organizationName: 'Verify Co' })
      .expect(201);
    const token = await latestEmailToken(email, 'verify_email');

    expect((await request(app).post('/api/v1/auth/verify-email').send({ token })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/verify-email').send({ token })).status).toBe(400);

    const login = await request(app).post('/api/v1/auth/login').send({ email, password: 'a-perfectly-fine-password' });
    expect(login.body.user.emailVerified).toBe(true);
  });

  it('resend: a one-minute cooldown, and 409 once verified', async () => {
    const agent = await loginAgent(app, alice);
    // createUserWithOrg registered alice a moment ago, so a token is fresh.
    expect((await agent.post('/api/v1/auth/verify-email/resend')).status).toBe(429);

    await pool.query("UPDATE user_email_tokens SET created_at = now() - interval '2 minutes'");
    expect((await agent.post('/api/v1/auth/verify-email/resend')).status).toBe(202);
    expect(await outboxFor(alice.email, 'verify_email')).toHaveLength(2);

    await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [alice.id]);
    expect((await agent.post('/api/v1/auth/verify-email/resend')).status).toBe(409);
  });
});

describe('changing the sign-in email', () => {
  it('needs the current password, refuses a taken address, and swaps only after confirmation', async () => {
    const agent = await loginAgent(app, alice);
    const bob = await createUserWithOrg({ label: 'bob' });
    const newEmail = uniqueEmail('alice-new');

    expect(
      (await agent.post('/api/v1/auth/me/email').send({ newEmail, currentPassword: 'wrong-password' })).status,
    ).toBe(400);
    expect(
      (await agent.post('/api/v1/auth/me/email').send({ newEmail: bob.email, currentPassword: alice.password })).status,
    ).toBe(409);

    await agent.post('/api/v1/auth/me/email').send({ newEmail, currentPassword: alice.password }).expect(202);
    // Nothing changes until the new address confirms.
    expect((await agent.get('/api/v1/auth/check')).body.user.email).toBe(alice.email);

    const token = await latestEmailToken(newEmail, 'confirm_email_change');
    await request(app).post('/api/v1/auth/confirm-email-change').send({ token }).expect(200);

    const check = await agent.get('/api/v1/auth/check');
    expect(check.body.user.email).toBe(newEmail);
    expect(check.body.user.emailVerified).toBe(true);
    // The old address hears about it.
    const [notice] = await outboxFor(alice.email, 'email_changed_notice');
    expect(notice?.template_data).toMatchObject({ newEmail });
    // And the old address no longer signs in; the new one does.
    expect((await request(app).post('/api/v1/auth/login').send({ email: alice.email, password: alice.password })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: newEmail, password: alice.password })).status).toBe(200);
  });

  it('a verification link for the old address cannot verify the new one', async () => {
    const agent = await loginAgent(app, alice);
    const staleToken = await latestEmailToken(alice.email, 'verify_email');
    const newEmail = uniqueEmail('alice-moved');
    await agent.post('/api/v1/auth/me/email').send({ newEmail, currentPassword: alice.password }).expect(202);
    await pool.query("UPDATE users SET email = $2, email_verified = false WHERE id = $1", [alice.id, newEmail]);

    const res = await request(app).post('/api/v1/auth/verify-email').send({ token: staleToken });
    expect(res.status).toBe(400);
  });
});

describe('organization email settings', () => {
  it('reads defaults, updates, and resets a field with null', async () => {
    const agent = await loginAgent(app, alice);
    const initial = await agent.get('/api/v1/organizations/email-settings');
    expect(initial.body.settings).toMatchObject({ senderName: null, replyTo: null, transport: 'log' });

    await agent.patch('/api/v1/organizations/email-settings').send({ senderName: 'Alpha Books' }).expect(200);
    const cleared = await agent.patch('/api/v1/organizations/email-settings').send({ senderName: null });
    expect(cleared.body.settings.senderName).toBeNull();
  });

  it('is isolated per organization and closed to accountants', async () => {
    const aliceAgent = await loginAgent(app, alice);
    await aliceAgent.patch('/api/v1/organizations/email-settings').send({ senderName: 'Alpha Books' }).expect(200);

    const carol = await createUserWithOrg({ label: 'carol', orgName: 'Carol Co' });
    const carolAgent = await loginAgent(app, carol);
    const res = await carolAgent.get('/api/v1/organizations/email-settings');
    expect(res.body.settings.senderName).toBeNull();
    expect(res.text).not.toContain('Alpha Books');

    const dave = await createUserWithOrg({ label: 'dave' });
    await addMember(alice.orgId, dave.id, 'ACCOUNTANT');
    const daveAgent = await loginAgent(app, dave);
    await daveAgent.post('/api/v1/auth/switch-org').send({ orgId: alice.orgId }).expect(200);
    expect((await daveAgent.get('/api/v1/organizations/email-settings')).status).toBe(403);
  });
});

describe('notifications', () => {
  async function submitABill(submitter: SeededUser): Promise<void> {
    const agent = await loginAgent(app, submitter);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: alice.orgId }).expect(200);
    const vendor = await agent.post('/api/v1/vendors').send({ name: 'Acme Supplies' });
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM accounts WHERE org_id = $1 AND code = '6130'", [
      alice.orgId,
    ]);
    const bill = await agent.post('/api/v1/bills').send({
      vendorId: vendor.body.vendor.id,
      vendorReference: 'INV-77',
      billDate: '2026-06-01',
      dueDate: '2026-06-30',
      notes: null,
      paymentTerms: null,
      lines: [{ description: 'Paper', quantityMilli: 1000, unitPriceCents: 12345, expenseAccountId: rows[0]?.id, taxRateBp: 0 }],
    });
    await agent.post(`/api/v1/bills/${String(bill.body.bill.id)}/submit`).send({}).expect(200);
  }

  it('a submitted bill emails every approver except the submitter', async () => {
    const admin = await createUserWithOrg({ label: 'admin' });
    const clerk = await createUserWithOrg({ label: 'clerk' });
    await addMember(alice.orgId, admin.id, 'ADMIN');
    await addMember(alice.orgId, clerk.id, 'ACCOUNTANT');

    await submitABill(admin);

    const [toAlice] = await outboxFor(alice.email, 'bill_awaiting_approval');
    expect(toAlice?.template_data).toMatchObject({ vendorName: 'Acme Supplies', billNumber: 'INV-77', organizationName: 'Alpha Ltd' });
    expect(String(toAlice?.template_data.amount)).toContain('123.45');
    expect(await outboxFor(admin.email, 'bill_awaiting_approval')).toHaveLength(0); // the submitter
    expect(await outboxFor(clerk.email, 'bill_awaiting_approval')).toHaveLength(0); // cannot approve
  });

  it('an opted-out approver is not emailed', async () => {
    const aliceAgent = await loginAgent(app, alice);
    const prefs = await aliceAgent
      .put('/api/v1/auth/me/notifications')
      .send({ preferences: [{ event: 'bill_awaiting_approval', enabled: false }] });
    expect(prefs.body.preferences).toEqual([
      { event: 'bill_awaiting_approval', enabled: false },
      { event: 'invitation_accepted', enabled: true },
    ]);

    const admin = await createUserWithOrg({ label: 'admin' });
    await addMember(alice.orgId, admin.id, 'ADMIN');
    await submitABill(admin);
    expect(await outboxFor(alice.email, 'bill_awaiting_approval')).toHaveLength(0);
  });

  it('the inviter hears when an invitation is accepted', async () => {
    const bob = await createUserWithOrg({ label: 'bob' });
    const aliceAgent = await loginAgent(app, alice);
    await aliceAgent.post('/api/v1/organizations/invitations').send({ email: bob.email, role: 'VIEWER' }).expect(201);
    const token = await latestEmailToken(bob.email, 'invitation');

    const bobAgent = await loginAgent(app, bob);
    await bobAgent.post(`/api/v1/auth/invitations/${token}/accept`).expect(200);

    const [notice] = await outboxFor(alice.email, 'invitation_accepted');
    expect(notice?.template_data).toMatchObject({ organizationName: 'Alpha Ltd' });
  });
});
