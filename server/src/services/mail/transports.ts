import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { OutgoingEmail } from '../../types/email.js';

/**
 * Phase 38b — where an email actually goes. Three transports, all plain
 * `fetch` (no SDK, no SMTP library — the same posture as the Gemini and
 * Drive clients; docs/development.md):
 *
 * - `log`     — writes the message to the log. Development default. In
 *               production it logs only that a message was due, never its
 *               body: the body can carry a reset or invitation link.
 * - `mailpit` — POSTs to a local Mailpit container's HTTP send API, so a
 *               developer reads real rendered emails at http://localhost:8025.
 * - `brevo`   — Brevo's transactional API, `POST /v3/smtp/email` with an
 *               `api-key` header; 201 `{ messageId }` on success. Verified
 *               against developers.brevo.com on 2026-10-01.
 */

export interface SendResult {
  /** The provider's id for the message, when it gives one. */
  providerMessageId: string | null;
}

/**
 * A failed send. `permanent` failures (a rejected address, a bad API key,
 * an unverified sender) are not retried — retrying cannot fix them and only
 * burns the free daily quota. Network errors, 429 and 5xx are retried.
 */
export class MailSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'MailSendError';
  }
}

export interface MailTransport {
  readonly name: 'log' | 'mailpit' | 'brevo';
  send(message: OutgoingEmail): Promise<SendResult>;
}

type FetchImpl = typeof fetch;

/** 4xx other than 408/429 means the request itself is wrong: not retryable. */
function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function errorText(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  return `${String(response.status)} ${body}`.slice(0, 400);
}

export function createLogTransport(): MailTransport {
  return {
    name: 'log',
    send(message) {
      if (env.isProduction) {
        logger.warn({ to: message.to.email, subject: message.subject }, 'email due, but MAIL_TRANSPORT=log sends nothing');
      } else {
        logger.info(
          { to: message.to.email, subject: message.subject, text: message.text },
          'email (development only — MAIL_TRANSPORT=log)',
        );
      }
      return Promise.resolve({ providerMessageId: null });
    },
  };
}

export function createMailpitTransport(baseUrl = env.MAILPIT_URL, fetchImpl: FetchImpl = fetch): MailTransport {
  return {
    name: 'mailpit',
    async send(message) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/v1/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            From: { Email: message.from.email, Name: message.from.name },
            To: [{ Email: message.to.email, Name: message.to.name ?? '' }],
            ...(message.replyTo === null ? {} : { ReplyTo: [{ Email: message.replyTo }] }),
            Subject: message.subject,
            Text: message.text,
            HTML: message.html,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        throw new MailSendError(`Mailpit unreachable: ${err instanceof Error ? err.message : String(err)}`, false);
      }
      if (!response.ok) throw new MailSendError(`Mailpit: ${await errorText(response)}`, isPermanentStatus(response.status));
      const body = (await response.json().catch(() => null)) as { ID?: unknown } | null;
      return { providerMessageId: typeof body?.ID === 'string' ? body.ID : null };
    },
  };
}

export function createBrevoTransport(apiKey = env.BREVO_API_KEY, fetchImpl: FetchImpl = fetch): MailTransport {
  return {
    name: 'brevo',
    async send(message) {
      let response: Response;
      try {
        response = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-key': apiKey },
          body: JSON.stringify({
            sender: { email: message.from.email, name: message.from.name },
            to: [message.to.name === null ? { email: message.to.email } : { email: message.to.email, name: message.to.name }],
            ...(message.replyTo === null ? {} : { replyTo: { email: message.replyTo } }),
            subject: message.subject,
            htmlContent: message.html,
            textContent: message.text,
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        throw new MailSendError(`Brevo unreachable: ${err instanceof Error ? err.message : String(err)}`, false);
      }
      if (!response.ok) throw new MailSendError(`Brevo: ${await errorText(response)}`, isPermanentStatus(response.status));
      const body = (await response.json().catch(() => null)) as { messageId?: unknown } | null;
      return { providerMessageId: typeof body?.messageId === 'string' ? body.messageId : null };
    },
  };
}

/** The transport this deployment is configured for (MAIL_TRANSPORT). */
export function transportFromEnv(): MailTransport {
  switch (env.MAIL_TRANSPORT) {
    case 'brevo':
      return createBrevoTransport();
    case 'mailpit':
      return createMailpitTransport();
    case 'log':
      return createLogTransport();
  }
}
