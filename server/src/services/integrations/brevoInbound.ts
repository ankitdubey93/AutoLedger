import { z } from 'zod';
import { env } from '../../config/env.js';
import { MAX_UPLOAD_BYTES } from '../../config/constants.js';
import { ApiError } from '../../utils/apiError.js';

/**
 * Phase 43d — Brevo's inbound-parsing webhook: payload parsing and the
 * attachment download. No SDK; plain fetch with the same `api-key` header the
 * transactional mail transport uses.
 *
 * Everything in a payload is untrusted input from the open internet (the
 * webhook is unauthenticated apart from the secret in its path): the shape is
 * validated, unknown keys are ignored, and nothing here is ever logged —
 * addresses, subjects and download tokens are all attacker-influenced or
 * credential-like.
 *
 * Verified against developers.brevo.com (inbound parsing webhook,
 * GET /v3/inbound/attachments/{downloadToken}) on 2026-10-15.
 */

const attachmentSchema = z.object({
  Name: z.string().min(1).max(500),
  ContentType: z.string().max(200),
  ContentLength: z.number().int().nonnegative(),
  DownloadToken: z.string().min(1).max(2000),
});

const itemSchema = z.object({
  MessageId: z.string().min(1).max(998),
  From: z.object({ Address: z.string().min(1).max(320) }),
  Recipients: z.array(z.string().max(320)).max(200).default([]),
  Subject: z.string().max(1000).nullish(),
  Attachments: z.array(attachmentSchema).max(50).nullish(),
});

const batchSchema = z.object({ items: z.array(itemSchema).max(100) });

export interface InboundAttachment {
  downloadToken: string;
  name: string;
  contentType: string;
  contentLength: number;
}

export interface ParsedInboundEmail {
  messageId: string;
  fromAddress: string;
  recipients: string[];
  subject: string | null;
  attachments: InboundAttachment[];
}

export function parseBatch(body: unknown): ParsedInboundEmail[] {
  const result = batchSchema.safeParse(body);
  if (!result.success) throw new ApiError(400, 'Unrecognised inbound mail payload');
  return result.data.items.map((item) => ({
    messageId: item.MessageId,
    fromAddress: item.From.Address.toLowerCase(),
    recipients: item.Recipients.map((r) => r.trim().toLowerCase()),
    subject: item.Subject ?? null,
    attachments: (item.Attachments ?? []).map((a) => ({
      downloadToken: a.DownloadToken,
      name: a.Name,
      contentType: a.ContentType.toLowerCase().split(';')[0]?.trim() ?? '',
      contentLength: a.ContentLength,
    })),
  }));
}

/**
 * Downloads one attachment. A non-200 throws (the caller's job retry covers a
 * transient failure); the body is read as a stream with a running byte count
 * so a lying Content-Length cannot make us buffer more than MAX_UPLOAD_BYTES.
 */
export async function downloadAttachment(token: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const response = await fetchImpl(
    `https://api.brevo.com/v3/inbound/attachments/${encodeURIComponent(token)}`,
    { headers: { 'api-key': env.BREVO_API_KEY }, signal: AbortSignal.timeout(15_000) },
  );
  if (response.status !== 200) {
    // Status only: the body and the token stay out of messages and logs.
    throw new Error(`Attachment download failed (${String(response.status)})`);
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_UPLOAD_BYTES) throw new Error('Attachment too large');
  if (response.body === null) throw new Error('Attachment download returned no body');

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UPLOAD_BYTES) {
      await reader.cancel();
      throw new Error('Attachment too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
