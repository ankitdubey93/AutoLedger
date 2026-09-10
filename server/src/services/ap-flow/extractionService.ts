import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.js';
import { AP_FLOW_VISION_MAX_TOKENS, AP_FLOW_VISION_MODEL, AP_FLOW_VISION_TIMEOUT_MS } from '../../config/constants.js';
import { ApiError } from '../../utils/apiError.js';
import { parseMoneyText } from '../../utils/money.js';
import { extractionToolInputSchema } from '../../schemas/ap-flow/extractionSchema.js';
import type { ApFlowLineItem } from '../../types/ap-flow.js';

/**
 * AP-Flow's vision extraction (Phase 10). Touches no database — this file
 * must never import db/connect.js. Every network call goes through the
 * injectable `VisionClient` seam so tests never reach the network
 * (guardrails rule 14 — @anthropic-ai/sdk is this phase's fourth and last
 * approved dependency).
 */

/**
 * The model is forced into a tool call, never asked for free-form JSON — a
 * tool's `input_schema` is validated by the API before the response is
 * returned, which removes the "model wrapped its JSON in prose" failure
 * mode entirely.
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

/**
 * The injectable seam every consumer takes instead of importing the SDK
 * directly, so a test injects a deterministic stub and never reaches the
 * network. The real client (below) is a narrow adapter over the SDK,
 * satisfying this shape by construction rather than by assignability.
 */
export interface VisionClient {
  messages: {
    create(body: unknown, options?: { timeout?: number }): Promise<unknown>;
  };
}

function realClient(): VisionClient {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return {
    messages: {
      create: (body, options) =>
        anthropic.messages.create(
          body as Anthropic.Messages.MessageCreateParamsNonStreaming,
          options,
        ),
    },
  };
}

export interface ExtractionResult {
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
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

interface ToolUseBlockLike {
  type: 'tool_use';
  input: unknown;
}

function findToolUseBlock(response: unknown): ToolUseBlockLike | null {
  if (typeof response !== 'object' || response === null || !('content' in response)) return null;
  const content = (response as { content: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      (block as { type: unknown }).type === 'tool_use'
    ) {
      return block as ToolUseBlockLike;
    }
  }
  return null;
}

/**
 * @param pages redacted PNGs ONLY. Passing an unredacted buffer here is the
 *   single failure this app exists to prevent — the caller is
 *   redactionService's output, never rasterize's.
 * @param client injected so tests never reach the network.
 */
export async function extractFromPages(
  pages: Buffer[],
  client?: VisionClient,
): Promise<ExtractionResult> {
  if (client === undefined && env.ANTHROPIC_API_KEY === '') {
    throw new ApiError(503, 'Vision extraction is not configured (ANTHROPIC_API_KEY is unset)');
  }
  const effectiveClient = client ?? realClient();

  const body = {
    model: AP_FLOW_VISION_MODEL,
    max_tokens: AP_FLOW_VISION_MAX_TOKENS,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: 'tool', name: 'record_invoice' },
    messages: [
      {
        role: 'user',
        content: [
          ...pages.map((png) => ({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
          })),
          {
            type: 'text',
            text: 'Extract the vendor, invoice number, date, currency, subtotal, tax, total and line items from this document using the record_invoice tool.',
          },
        ],
      },
    ],
  };

  const response = await effectiveClient.messages.create(body, { timeout: AP_FLOW_VISION_TIMEOUT_MS });

  const toolUse = findToolUseBlock(response);
  if (toolUse === null) {
    throw new ApiError(502, 'Vision model returned no structured result');
  }

  // The model's output is untrusted input — parsed exactly as a request
  // body is parsed, never spread into a query.
  const parsed = extractionToolInputSchema.parse(toolUse.input);

  const errors: string[] = [];
  const subtotalCents = tryParseAmount(parsed.subtotal, 'subtotal', errors);
  const taxCents = tryParseAmount(parsed.tax, 'tax', errors);
  const totalCents = tryParseAmount(parsed.total, 'total', errors);

  const lineItems: ApFlowLineItem[] = parsed.line_items.map((item) => ({
    description: item.description,
    amountCents: tryParseAmount(item.amount, `line item "${item.description}"`, errors) ?? 0,
  }));

  const arithmetic = validateArithmetic(lineItems, subtotalCents, taxCents, totalCents);

  return {
    vendorName: parsed.vendor_name ?? null,
    invoiceNumber: parsed.invoice_number ?? null,
    invoiceDate: parsed.invoice_date ?? null,
    currency: parsed.currency ?? null,
    subtotalCents,
    taxCents,
    totalCents,
    lineItems,
    fieldConfidence: clampConfidence(parsed.field_confidence),
    arithmeticOk: arithmetic.ok,
    validationErrors: [...errors, ...arithmetic.errors],
    model: AP_FLOW_VISION_MODEL,
  };
}
