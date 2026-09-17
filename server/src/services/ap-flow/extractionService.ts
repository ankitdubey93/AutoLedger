import { AP_FLOW_VISION_MAX_TOKENS, AP_FLOW_VISION_TIMEOUT_MS } from '../../config/constants.js';
import { ApiError } from '../../utils/apiError.js';
import { parseMoneyText } from '../../utils/money.js';
import { extractionToolInputSchema } from '../../schemas/ap-flow/extractionSchema.js';
import type { ApFlowLineItem } from '../../types/ap-flow.js';
import type { ModelCallRecord } from '../../types/aiUsage.js';
import {
  anthropicModelClient,
  resolveModelClient,
  type MessagesClient,
  type StructuredModelClient,
} from './modelClient.js';

/**
 * AP-Flow's vision extraction (Phase 10, multi-provider since Phase 19).
 * Touches no database — this file must never import db/connect.js. Every
 * network call goes through the injectable `StructuredModelClient` seam
 * (modelClient.ts) so tests never reach the network.
 */

/** Kept as an alias so every existing test-stub import keeps compiling unchanged. */
export type VisionClient = MessagesClient;

/**
 * Phase 19.1's metering seam. This file must never import `db/connect.js`
 * (see the file-level comment above) — a callback lets it report a call it
 * cannot record itself, including one that failed, without acquiring a
 * database dependency.
 */
export type OnModelCall = (record: ModelCallRecord) => void;

/**
 * `err.status` when `err` is an `ApiError` (e.g. '502'), else the error's
 * constructor name, truncated to 100 chars. Never the error message — a
 * provider-supplied message must not reach a stored column.
 */
function errorCodeOf(err: unknown): string {
  const code = err instanceof ApiError ? String(err.status) : (err as { constructor: { name: string } }).constructor.name;
  return code.slice(0, 100);
}

/**
 * The model is forced into a tool call, never asked for free-form JSON — a
 * tool's `input_schema` is validated by the API before the response is
 * returned, which removes the "model wrapped its JSON in prose" failure
 * mode entirely. On Gemini this is expressed instead as `responseSchema` +
 * `responseMimeType: 'application/json'` (see modelClient.ts).
 */
export const EXTRACTION_TOOL = {
  name: 'record_invoice',
  description: 'Record the structured contents of the invoice or receipt shown in the images.',
  input_schema: {
    type: 'object',
    properties: {
      vendor_name: { type: ['string', 'null'] },
      invoice_number: { type: ['string', 'null'] },
      invoice_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      currency: { type: ['string', 'null'], description: 'ISO 4217, e.g. USD' },
      subtotal: { type: ['string', 'null'], description: 'Decimal STRING exactly as printed, e.g. "450.00"' },
      tax: { type: ['string', 'null'], description: 'Decimal STRING exactly as printed' },
      total: { type: ['string', 'null'], description: 'Decimal STRING exactly as printed' },
      line_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            amount: { type: 'string', description: 'Decimal STRING exactly as printed' },
          },
          required: ['description', 'amount'],
        },
      },
      field_confidence: {
        type: 'object',
        description: '0-1 per field name',
        additionalProperties: { type: 'number' },
      },
    },
    required: ['line_items', 'field_confidence'],
  },
} as const;

const nullableString = (description?: string): Record<string, unknown> => ({
  type: 'STRING',
  nullable: true,
  ...(description === undefined ? {} : { description }),
});
const nullableNumber = { type: 'NUMBER', nullable: true } as const;

/**
 * Gemini's `responseSchema` — an OpenAPI subset: uppercase type names, no
 * `additionalProperties`. That last restriction is why `field_confidence`
 * is a fixed object here rather than the open map Anthropic's JSON Schema
 * allows.
 */
export const GEMINI_EXTRACTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    vendor_name: nullableString(),
    invoice_number: nullableString(),
    invoice_date: nullableString('YYYY-MM-DD'),
    due_date: nullableString('YYYY-MM-DD'),
    currency: nullableString('ISO 4217, e.g. USD'),
    subtotal: nullableString('Decimal STRING exactly as printed, e.g. "450.00"'),
    tax: nullableString('Decimal STRING exactly as printed'),
    total: nullableString('Decimal STRING exactly as printed'),
    line_items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING' },
          amount: { type: 'STRING', description: 'Decimal STRING exactly as printed' },
        },
        required: ['description', 'amount'],
      },
    },
    field_confidence: {
      type: 'OBJECT',
      description: '0-1 confidence per field',
      properties: {
        vendor_name: nullableNumber,
        invoice_number: nullableNumber,
        invoice_date: nullableNumber,
        due_date: nullableNumber,
        currency: nullableNumber,
        subtotal: nullableNumber,
        tax: nullableNumber,
        total: nullableNumber,
      },
    },
  },
  required: ['line_items', 'field_confidence'],
} as const;

export interface ExtractionResult {
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  lineItems: ApFlowLineItem[];
  fieldConfidence: Record<string, number>;
  arithmeticOk: boolean;
  validationErrors: string[];
  model: string;
}

/** Parses one decimal-string amount field; null + a recorded error on failure. */
function tryParseAmount(
  raw: string | null | undefined,
  fieldName: string,
  errors: string[],
): number | null {
  if (raw === null || raw === undefined) return null;
  try {
    return Number(parseMoneyText(raw));
  } catch {
    errors.push(`Could not parse ${fieldName} as an amount`);
    return null;
  }
}

/**
 * Parses one YYYY-MM-DD date field; null + a recorded error on anything
 * else, including a value that merely looks close (e.g. day/month
 * transposed) — the UTC round-trip through Date catches an invalid
 * calendar date like '2026-02-30' that the regex alone would accept.
 */
function tryParseDate(raw: string | null | undefined, fieldName: string, errors: string[]): string | null {
  if (raw === null || raw === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    errors.push(`Could not parse ${fieldName} as a date`);
    return null;
  }
  const roundTrip = new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10);
  if (roundTrip !== raw) {
    errors.push(`Could not parse ${fieldName} as a date`);
    return null;
  }
  return raw;
}

function clampConfidence(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || Number.isNaN(value)) continue;
    out[key] = Math.max(0, Math.min(1, value));
  }
  return out;
}

/**
 * Pure. Integer cents only — no epsilon, no floats. Flags, never rejects:
 * an arithmetic contradiction sets `arithmeticOk: false` and records the
 * error, but the document still reaches EXTRACTED so a reviewer sees the
 * problem. Phase 10 posts nothing, so there is nothing to refuse.
 */
export function validateArithmetic(
  lineItems: ApFlowLineItem[],
  subtotalCents: number | null,
  taxCents: number | null,
  totalCents: number | null,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (subtotalCents !== null && lineItems.length > 0) {
    const sum = lineItems.reduce((acc, item) => acc + item.amountCents, 0);
    if (sum !== subtotalCents) {
      errors.push(`Line items sum to ${String(sum)} but the subtotal reads ${String(subtotalCents)}`);
    }
  }

  if (subtotalCents !== null && taxCents !== null && totalCents !== null) {
    const sum = subtotalCents + taxCents;
    if (sum !== totalCents) {
      errors.push(`Subtotal plus tax is ${String(sum)} but the total reads ${String(totalCents)}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * @param pages redacted PNGs ONLY. Passing an unredacted buffer here is the
 *   single failure this app exists to prevent — the caller is
 *   redactionService's output, never rasterize's.
 * @param client injected so tests never reach the network (Anthropic path).
 * @param modelClient injected so a test — or a caller wanting a specific
 *   provider — can supply the full seam directly, bypassing `client`
 *   entirely. Resolution order: `modelClient` > `client` wrapped as
 *   Anthropic > the configured provider (env.AP_FLOW_AI_PROVIDER).
 */
export async function extractFromPages(
  pages: Buffer[],
  client?: VisionClient,
  modelClient?: StructuredModelClient,
  onModelCall?: OnModelCall,
): Promise<ExtractionResult> {
  // Resolved BEFORE the timer starts: a 503 "not configured" throws here,
  // before any HTTP request, and must record no call (decision D5).
  const effectiveClient = modelClient ?? (client !== undefined ? anthropicModelClient('extract', client) : resolveModelClient('extract'));

  const request = {
    images: pages,
    prompt:
      'Extract the vendor, invoice number, invoice date, due date, currency, subtotal, tax, total and line items from this document using the record_invoice tool. Report field_confidence keys using the same snake_case field names.',
    schema: {
      name: EXTRACTION_TOOL.name,
      description: EXTRACTION_TOOL.description,
      jsonSchema: EXTRACTION_TOOL.input_schema,
      geminiSchema: GEMINI_EXTRACTION_SCHEMA,
    },
    maxTokens: AP_FLOW_VISION_MAX_TOKENS,
    timeoutMs: AP_FLOW_VISION_TIMEOUT_MS,
  };

  const startedAt = Date.now();
  let raw: Awaited<ReturnType<StructuredModelClient['generateStructured']>>;
  try {
    raw = await effectiveClient.generateStructured(request);
  } catch (err) {
    onModelCall?.({
      appSlug: 'ap-flow',
      purpose: 'EXTRACT',
      provider: effectiveClient.provider,
      model: effectiveClient.model,
      entityType: null,
      entityId: null,
      usage: null,
      status: 'ERROR',
      errorCode: errorCodeOf(err),
      latencyMs: Date.now() - startedAt,
      createdBy: null,
    });
    throw err;
  }
  onModelCall?.({
    appSlug: 'ap-flow',
    purpose: 'EXTRACT',
    provider: effectiveClient.provider,
    model: effectiveClient.model,
    entityType: null,
    entityId: null,
    usage: raw.usage,
    status: 'OK',
    errorCode: null,
    latencyMs: Date.now() - startedAt,
    createdBy: null,
  });

  if (raw.value === null) {
    throw new ApiError(502, 'Vision model returned no structured result');
  }

  // The model's output is untrusted input — parsed exactly as a request
  // body is parsed, never spread into a query.
  const parsed = extractionToolInputSchema.parse(raw.value);

  const errors: string[] = [];
  const subtotalCents = tryParseAmount(parsed.subtotal, 'subtotal', errors);
  const taxCents = tryParseAmount(parsed.tax, 'tax', errors);
  const totalCents = tryParseAmount(parsed.total, 'total', errors);
  const invoiceDate = tryParseDate(parsed.invoice_date, 'invoice_date', errors);
  const dueDate = tryParseDate(parsed.due_date, 'due_date', errors);

  const lineItems: ApFlowLineItem[] = parsed.line_items.map((item) => ({
    description: item.description,
    amountCents: tryParseAmount(item.amount, `line item "${item.description}"`, errors) ?? 0,
  }));

  const arithmetic = validateArithmetic(lineItems, subtotalCents, taxCents, totalCents);

  return {
    vendorName: parsed.vendor_name ?? null,
    invoiceNumber: parsed.invoice_number ?? null,
    invoiceDate,
    dueDate,
    currency: parsed.currency ?? null,
    subtotalCents,
    taxCents,
    totalCents,
    lineItems,
    fieldConfidence: clampConfidence(parsed.field_confidence),
    arithmeticOk: arithmetic.ok,
    validationErrors: [...errors, ...arithmetic.errors],
    model: effectiveClient.model,
  };
}
