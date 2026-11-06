import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import {
  drainEmailOutbox,
  enqueueEmailOnClient,
  type AttachmentResolver,
} from '../../services/mail/emailOutboxService.js';
import { createBrevoTransport, createMailpitTransport, type MailTransport } from '../../services/mail/transports.js';
import { renderEmail } from '../../services/mail/templates.js';
import { ApiError } from '../../utils/apiError.js';
import type { OutgoingEmail } from '../../types/email.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 48 slice B — the outbox carries an attachment as a reference and the
 * drain resolves it at send time. An email that promises a PDF never goes out
 * without it, so every resolver failure is either a retry or a permanent FAILED,
 * never a silent send.
 */

let alice: SeededUser;

beforeEach(async () => {
  await resetTables();
  alice = await createUserWithOrg({ label: 'attach', orgName: 'Alpha Ltd' });
  await pool.query('DELETE FROM email_outbox');
});

afterAll(closePool);

const PDF = Buffer.from('%PDF-1.4 fake');

function fakeTransport() {
  const sent: OutgoingEmail[] = [];
  const transport: MailTransport = {
    name: 'log',
    send(message) {
      sent.push(message);
      return Promise.resolve({ providerMessageId: 'm-1' });
    },
  };
  return { transport, sent };
}

async function enqueueWithAttachment(refId = randomUUID()): Promise<string> {
  const client = await pool.connect();
  try {
    return await enqueueEmailOnClient(client, {
      orgId: alice.orgId,
      to: 'ap@example.com',
      template: 'invoice_sent',
      data: { organizationName: 'Alpha Ltd', invoiceNumber: 'INV-1', total: 'USD 1.00', amountDue: 'USD 1.00', dueDate: '2026-12-01' },
      link: 'http://x/invoice/tok',
      attachment: { kind: 'INVOICE_PDF', refId },
    });
  } finally {
    client.release();
  }
}

async function rowOf(id: string) {
  const { rows } = await pool.query<{ status: string; attempts: number; last_error: string | null }>(
    'SELECT status, attempts, last_error FROM email_outbox WHERE id = $1',
    [id],
  );
  return rows[0];
}

describe('drainEmailOutbox with attachments', () => {
  it('hands the transport the resolved buffer and filename', async () => {
    const refId = randomUUID();
    const id = await enqueueWithAttachment(refId);
    const { transport, sent } = fakeTransport();
    const seen: unknown[] = [];
    const resolveAttachment: AttachmentResolver = (kind, orgId, ref) => {
      seen.push([kind, orgId, ref]);
      return Promise.resolve({ filename: 'INV-1.pdf', contentType: 'application/pdf', content: PDF });
    };

    const result = await drainEmailOutbox({ transport, resolveAttachment });

    expect(result.sent).toBe(1);
    expect(seen).toEqual([['INVOICE_PDF', alice.orgId, refId]]);
    expect(sent[0]?.attachments).toHaveLength(1);
    expect(Buffer.isBuffer(sent[0]?.attachments?.[0]?.content)).toBe(true);
    expect(sent[0]?.attachments?.[0]?.filename).toBe('INV-1.pdf');
    expect((await rowOf(id))?.status).toBe('SENT');
  });

  it('no resolver: the row FAILS permanently and the transport is not called', async () => {
    const id = await enqueueWithAttachment();
    const { transport, sent } = fakeTransport();

    const result = await drainEmailOutbox({ transport });

    expect(result.failed).toBe(1);
    expect(sent).toHaveLength(0);
    const row = await rowOf(id);
    expect(row?.status).toBe('FAILED');
    expect(row?.last_error).toBe('No attachment resolver is configured');
  });

  it('a plain resolver error goes back to PENDING with attempts = 1', async () => {
    const id = await enqueueWithAttachment();
    const { transport, sent } = fakeTransport();

    const result = await drainEmailOutbox({
      transport,
      resolveAttachment: () => Promise.reject(new Error('render blew up')),
    });

    expect(result.retried).toBe(1);
    expect(sent).toHaveLength(0);
    const row = await rowOf(id);
    expect(row?.status).toBe('PENDING');
    expect(row?.attempts).toBe(1);
  });

  it('a resolver ApiError(404) FAILS the row permanently', async () => {
    const id = await enqueueWithAttachment();
    const { transport, sent } = fakeTransport();

    const result = await drainEmailOutbox({
      transport,
      resolveAttachment: () => Promise.reject(new ApiError(404, 'Invoice not found')),
    });

    expect(result.failed).toBe(1);
    expect(sent).toHaveLength(0);
    const row = await rowOf(id);
    expect(row?.status).toBe('FAILED');
    expect(row?.last_error).toBe('Attachment source no longer exists');
  });

  it('a message without an attachment carries no attachments key', async () => {
    const client = await pool.connect();
    try {
      await enqueueEmailOnClient(client, { orgId: null, to: 'a@example.com', template: 'password_reset', link: 'http://x/r?t=1' });
    } finally {
      client.release();
    }
    const { transport, sent } = fakeTransport();
    await drainEmailOutbox({ transport });
    expect(sent).toHaveLength(1);
    expect('attachments' in (sent[0] ?? {})).toBe(false);
  });
});

describe('transport wire formats', () => {
  const base: OutgoingEmail = {
    subject: 's',
    html: '<p>h</p>',
    text: 't',
    to: { email: 'to@example.com', name: null },
    from: { email: 'from@example.com', name: 'From' },
    replyTo: null,
  };
  const attachment = { filename: 'INV-1.pdf', contentType: 'application/pdf', content: PDF };

  function capture(responseBody: unknown) {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = ((_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Promise.resolve(new Response(JSON.stringify(responseBody), { status: 200 }));
    }) as typeof fetch;
    return { bodies, fetchImpl };
  }

  it('Mailpit sends Attachments[0].Content as base64', async () => {
    const { bodies, fetchImpl } = capture({ ID: 'x' });
    await createMailpitTransport('http://mailpit.test', fetchImpl).send({ ...base, attachments: [attachment] });
    const first = (bodies[0]?.Attachments as { Content: string; Filename: string; ContentType: string }[])[0];
    expect(first?.Content).toBe(PDF.toString('base64'));
    expect(first?.Filename).toBe('INV-1.pdf');
    expect(first?.ContentType).toBe('application/pdf');
  });

  it('Brevo sends attachment[0].name and .content as base64', async () => {
    const { bodies, fetchImpl } = capture({ messageId: 'x' });
    await createBrevoTransport('key', fetchImpl).send({ ...base, attachments: [attachment] });
    const first = (bodies[0]?.attachment as { content: string; name: string }[])[0];
    expect(first?.name).toBe('INV-1.pdf');
    expect(first?.content).toBe(PDF.toString('base64'));
  });

  it('neither transport includes the key when there is no attachment', async () => {
    const mailpit = capture({ ID: 'x' });
    await createMailpitTransport('http://mailpit.test', mailpit.fetchImpl).send(base);
    expect('Attachments' in (mailpit.bodies[0] ?? {})).toBe(false);
    const brevo = capture({ messageId: 'x' });
    await createBrevoTransport('key', brevo.fetchImpl).send(base);
    expect('attachment' in (brevo.bodies[0] ?? {})).toBe(false);
  });
});

describe('ck_email_outbox_attachment', () => {
  it('rejects an attachment_kind on a row with no org_id (23514)', async () => {
    await expect(
      pool.query(
        `INSERT INTO email_outbox (org_id, to_email, template, attachment_kind, attachment_ref_id)
         VALUES (NULL, 'a@example.com', 'invoice_sent', 'INVOICE_PDF', $1)`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('invoice email templates', () => {
  const data = {
    organizationName: 'Alpha Ltd',
    customerName: 'Acme',
    invoiceNumber: 'INV-0001',
    total: 'USD 110.00',
    amountDue: 'USD 100.00',
    dueDate: '2026-12-01',
    message: null,
    canPayOnline: false,
    overdue: false,
  };
  const url = 'https://app.example/invoice/tok';

  it('escapes the sender message in the html part', () => {
    const out = renderEmail('invoice_sent', { ...data, message: '<script>alert(1)</script>' }, url);
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('builds the subject for sent, overdue and not-yet-due reminders', () => {
    expect(renderEmail('invoice_sent', data, url).subject).toBe('Invoice INV-0001 from Alpha Ltd');
    expect(renderEmail('invoice_reminder', { ...data, overdue: true }, url).subject).toBe(
      'Reminder: invoice INV-0001 is overdue',
    );
    expect(renderEmail('invoice_reminder', data, url).subject).toBe(
      'Reminder: invoice INV-0001 is due on 2026-12-01',
    );
  });

  it('labels the action by whether card payment is available', () => {
    expect(renderEmail('invoice_sent', { ...data, canPayOnline: true }, url).html).toContain('View and pay');
    const plain = renderEmail('invoice_sent', { ...data, canPayOnline: false }, url);
    expect(plain.html).toContain('View invoice');
    expect(plain.html).not.toContain('View and pay');
  });
});
