import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/apiError.js';
import { logger } from '../../utils/logger.js';

/**
 * The slice of Stripe's REST API that statement payments need (Phase 39c):
 * create a PaymentIntent, read one back, verify a webhook signature.
 *
 * No SDK, by the same reasoning as Brevo, Gemini and Drive: three calls do
 * not justify a dependency, and `fetch` + `node:crypto` are enough. Stripe's
 * API is form-encoded in and JSON out; the API version is pinned so a change
 * to the account's default version cannot change these response shapes.
 *
 * SECRET HYGIENE: no log line, error or return value here ever includes the
 * secret key, the webhook secret, or a PaymentIntent's client secret.
 */

export type FetchLike = typeof fetch;

export interface StripeConfig {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
}

export interface StripeDeps {
  config?: StripeConfig | null;
  fetchImpl?: FetchLike;
  /** Seconds since the epoch — injectable so signature-age tests are deterministic. */
  nowSeconds?: () => number;
}

const API = 'https://api.stripe.com/v1';
const STRIPE_VERSION = '2024-06-20';
/** Stripe's own default tolerance for a webhook's timestamp. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** The deployment's Stripe keys, or null when online payment is not configured. */
export function stripeConfig(deps?: StripeDeps): StripeConfig | null {
  if (deps?.config !== undefined) return deps.config;
  if (env.STRIPE_SECRET_KEY === '' || env.STRIPE_PUBLISHABLE_KEY === '') return null;
  return {
    secretKey: env.STRIPE_SECRET_KEY,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
  };
}

export interface PaymentIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  clientSecret: string | null;
  metadata: Record<string, string>;
  lastErrorMessage: string | null;
}

function toIntent(body: unknown): PaymentIntent {
  if (typeof body !== 'object' || body === null) throw new ApiError(502, 'Unexpected response from the payment provider');
  const o = body as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.status !== 'string' || typeof o.amount !== 'number' || typeof o.currency !== 'string') {
    throw new ApiError(502, 'Unexpected response from the payment provider');
  }
  const lastError = o.last_payment_error as { message?: unknown } | null | undefined;
  return {
    id: o.id,
    status: o.status,
    amount: o.amount,
    currency: o.currency.toUpperCase(),
    clientSecret: typeof o.client_secret === 'string' ? o.client_secret : null,
    metadata: (typeof o.metadata === 'object' && o.metadata !== null ? o.metadata : {}) as Record<string, string>,
    lastErrorMessage: typeof lastError?.message === 'string' ? lastError.message : null,
  };
}

async function call(
  config: StripeConfig,
  method: 'GET' | 'POST',
  path: string,
  form: URLSearchParams | null,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        'Stripe-Version': STRIPE_VERSION,
        ...(form === null ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
        ...headers,
      },
      ...(form === null ? {} : { body: form.toString() }),
    });
  } catch {
    throw new ApiError(502, 'The payment provider could not be reached');
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body.error as { message?: unknown }).message ?? '')
        : '';
    logger.warn({ status: response.status, path: path.split('/').slice(0, 2).join('/') }, 'stripe request failed');
    throw new ApiError(502, message === '' ? 'The payment provider refused the request' : `Payment provider: ${message}`);
  }
  return body;
}

export async function createPaymentIntent(
  input: {
    amountCents: number;
    currencyCode: string;
    description: string;
    metadata: Record<string, string>;
    /** Stripe dedupes a retried create with the same key — our online payment id. */
    idempotencyKey: string;
  },
  deps?: StripeDeps,
): Promise<PaymentIntent> {
  const config = stripeConfig(deps);
  if (config === null) throw new ApiError(503, 'Online payment is not configured');
  const form = new URLSearchParams({
    amount: String(input.amountCents),
    currency: input.currencyCode.toLowerCase(),
    description: input.description,
    'automatic_payment_methods[enabled]': 'true',
  });
  for (const [key, value] of Object.entries(input.metadata)) form.set(`metadata[${key}]`, value);
  const body = await call(config, 'POST', '/payment_intents', form, { 'Idempotency-Key': input.idempotencyKey }, deps?.fetchImpl ?? fetch);
  return toIntent(body);
}

export async function retrievePaymentIntent(intentId: string, deps?: StripeDeps): Promise<PaymentIntent> {
  const config = stripeConfig(deps);
  if (config === null) throw new ApiError(503, 'Online payment is not configured');
  if (!/^pi_[A-Za-z0-9]+$/.test(intentId)) throw new ApiError(404, 'Payment not found');
  const body = await call(config, 'GET', `/payment_intents/${intentId}`, null, {}, deps?.fetchImpl ?? fetch);
  return toIntent(body);
}

export interface StripeEvent {
  id: string;
  type: string;
  objectId: string | null;
}

/**
 * Verifies `Stripe-Signature` over the RAW request body and parses the event.
 *
 * The header is `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`; the signature is
 * HMAC-SHA256 of `${t}.${rawBody}` keyed with the endpoint's whole `whsec_…`
 * secret. Any v1 may match (Stripe sends several while a secret is rolled).
 * The body must be the exact bytes received — re-serialising parsed JSON
 * changes them, which is why the webhook route takes `express.raw`. The
 * timestamp check bounds replay of a captured request.
 */
export function verifyWebhook(rawBody: Buffer, header: string | undefined, deps?: StripeDeps): StripeEvent {
  const config = stripeConfig(deps);
  if (config === null || config.webhookSecret === '') throw new ApiError(503, 'Stripe webhooks are not configured');
  if (header === undefined || header === '') throw new ApiError(400, 'Missing Stripe-Signature');

  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && value !== undefined && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && value !== undefined) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) throw new ApiError(400, 'Malformed Stripe-Signature');

  const now = deps?.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS) throw new ApiError(400, 'Stripe-Signature is too old');

  const expected = createHmac('sha256', config.webhookSecret)
    .update(`${String(timestamp)}.`)
    .update(rawBody)
    .digest();
  const matches = signatures.some((hex) => {
    if (!/^[0-9a-f]{64}$/.test(hex)) return false;
    return timingSafeEqual(Buffer.from(hex, 'hex'), expected);
  });
  if (!matches) throw new ApiError(400, 'Stripe-Signature does not match');

  let event: unknown;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Webhook body is not JSON');
  }
  const o = event as { id?: unknown; type?: unknown; data?: { object?: { id?: unknown } } };
  if (typeof o.id !== 'string' || typeof o.type !== 'string') throw new ApiError(400, 'Webhook body is not a Stripe event');
  const objectId = o.data?.object?.id;
  return { id: o.id, type: o.type, objectId: typeof objectId === 'string' ? objectId : null };
}
