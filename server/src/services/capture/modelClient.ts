import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.js';
import { CAPTURE_GEMINI_BASE_URL } from '../../config/constants.js';
import { CAPTURE_VISION_MODEL, CAPTURE_CLASSIFY_MODEL } from '../../config/constants.js';
import { ApiError } from '../../utils/apiError.js';
import type { ModelUsage } from '../../types/aiUsage.js';

/**
 * Capture's multi-provider structured-model seam (Phase 19). Extraction and
 * classification both go through one `StructuredModelClient` interface, so
 * `CAPTURE_AI_PROVIDER=gemini` works with zero changes to either caller.
 *
 * Touches no database — this file must never import db/connect.js.
 *
 * Anthropic is called through the SDK (already a Phase 10 dependency,
 * unchanged shape: forced tool_choice). Gemini is called over plain
 * `fetch` — no new package (guardrails rule 14): Capture is inside the LLM
 * carve-out, and the TaxGuard/Voyage precedent (embeddingService.ts) is
 * fetch over an SDK.
 */

export type CaptureAiProvider = 'anthropic' | 'gemini';
export type ModelPurpose = 'extract' | 'classify';

/** The Anthropic messages surface both existing test stubs already implement. */
export interface MessagesClient {
  messages: {
    create(body: unknown, options?: { timeout?: number }): Promise<unknown>;
  };
}

export interface StructuredSchema {
  /** Anthropic tool name. */
  name: string;
  description: string;
  /** Anthropic's tool input_schema (JSON Schema). */
  jsonSchema: Record<string, unknown>;
  /** Gemini's responseSchema (OpenAPI subset — no additionalProperties, uppercase types). */
  geminiSchema: Record<string, unknown>;
}

export interface StructuredRequest {
  /** Redacted PNGs ONLY. */
  images: Buffer[];
  prompt: string;
  schema: StructuredSchema;
  maxTokens: number;
  timeoutMs: number;
}

export interface StructuredResult {
  /** The structured object, or null when the model produced none. */
  value: unknown;
  /** null when the provider returned no usage block. */
  usage: ModelUsage | null;
}

export interface StructuredModelClient {
  readonly provider: CaptureAiProvider;
  readonly model: string;
  generateStructured(request: StructuredRequest): Promise<StructuredResult>;
}

export interface ModelConfig {
  provider: CaptureAiProvider;
  anthropicApiKey: string;
  geminiApiKey: string;
  geminiModel: string;
}

interface ToolUseBlockLike {
  type: 'tool_use';
  input: unknown;
}

/** Extracts the tool_use block's `input` from an Anthropic Messages response, or null. */
export function findToolUseInput(response: unknown): unknown {
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
      return (block as ToolUseBlockLike).input;
    }
  }
  return null;
}

/**
 * Reads `response.usage` and normalizes it. `null` when the response carries
 * no usage block at all. Anthropic already counts thinking tokens inside
 * `output_tokens`, so `reasoningTokens` is always 0 here. A cache WRITE
 * (`cache_creation_input_tokens`) is billed as input, so it is folded into
 * `inputTokens`; a cache READ (`cache_read_input_tokens`) is reported
 * separately in `cachedInputTokens`. Every field is read defensively —
 * non-numeric becomes 0 — so a changed provider shape degrades to "tokens
 * unknown" rather than throwing.
 */
export function normalizeAnthropicUsage(response: unknown): ModelUsage | null {
  if (typeof response !== 'object' || response === null || !('usage' in response)) return null;
  const usage = (response as { usage: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return null;

  const u = usage as Record<string, unknown>;
  const numberOr0 = (value: unknown): number => (typeof value === 'number' ? value : 0);

  const inputTokens = numberOr0(u.input_tokens) + numberOr0(u.cache_creation_input_tokens);
  const outputTokens = numberOr0(u.output_tokens);
  const cachedInputTokens = numberOr0(u.cache_read_input_tokens);

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens + cachedInputTokens,
  };
}

function realAnthropicClient(apiKey: string): MessagesClient {
  const anthropic = new Anthropic({ apiKey });
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

/**
 * `messages` defaults to a real Anthropic client — inject a stub in tests to
 * never reach the network. `model` is fixed by `purpose`, matching the
 * per-purpose constants Phase 10/11 already established.
 */
export function anthropicModelClient(
  purpose: ModelPurpose,
  messages?: MessagesClient,
  apiKey?: string,
): StructuredModelClient {
  const model = purpose === 'extract' ? CAPTURE_VISION_MODEL : CAPTURE_CLASSIFY_MODEL;
  const effectiveMessages = messages ?? realAnthropicClient(apiKey ?? env.ANTHROPIC_API_KEY);

  return {
    provider: 'anthropic',
    model,
    async generateStructured(request: StructuredRequest): Promise<StructuredResult> {
      const body = {
        model,
        max_tokens: request.maxTokens,
        tools: [
          {
            name: request.schema.name,
            description: request.schema.description,
            input_schema: request.schema.jsonSchema,
          },
        ],
        tool_choice: { type: 'tool', name: request.schema.name },
        messages: [
          {
            role: 'user',
            content: [
              ...request.images.map((png) => ({
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
              })),
              { type: 'text', text: request.prompt },
            ],
          },
        ],
      };

      const response = await effectiveMessages.messages.create(body, { timeout: request.timeoutMs });
      return { value: findToolUseInput(response), usage: normalizeAnthropicUsage(response) };
    },
  };
}

interface GeminiPart {
  text?: string;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[];
  usageMetadata?: GeminiUsageMetadata;
}

/**
 * Reads `json.usageMetadata` and normalizes it. `null` when the response
 * carries no usage block at all. Gemini bills `thoughtsTokenCount` as
 * OUTPUT, so it is folded into `outputTokens` here AND reported separately
 * in `reasoningTokens` for visibility — never add `reasoningTokens` to a
 * cost a second time. Field names verified against Google's
 * `generateContent` reference, 2026-09-17. Every field read defensively —
 * non-numeric becomes 0 — so a changed provider shape degrades to "tokens
 * unknown" rather than throwing.
 */
export function normalizeGeminiUsage(json: unknown): ModelUsage | null {
  if (typeof json !== 'object' || json === null || !('usageMetadata' in json)) return null;
  const usage = (json as { usageMetadata: unknown }).usageMetadata;
  if (typeof usage !== 'object' || usage === null) return null;

  const u = usage as GeminiUsageMetadata;
  const numberOr0 = (value: number | undefined): number => (typeof value === 'number' ? value : 0);

  const inputTokens = numberOr0(u.promptTokenCount);
  const reasoningTokens = numberOr0(u.thoughtsTokenCount);
  const outputTokens = numberOr0(u.candidatesTokenCount) + reasoningTokens;
  const cachedInputTokens = numberOr0(u.cachedContentTokenCount);
  const totalTokens =
    typeof u.totalTokenCount === 'number'
      ? u.totalTokenCount
      : inputTokens + outputTokens + cachedInputTokens;

  return { inputTokens, outputTokens, cachedInputTokens, reasoningTokens, totalTokens };
}

/**
 * Google's error `status` field is a fixed enum (e.g. `NOT_FOUND`,
 * `INVALID_ARGUMENT`, `PERMISSION_DENIED`) — a vocabulary, not free text.
 * Extracting only that field (never `error.message`) restores the
 * actionable half of a failed-call diagnosis (a 404's status distinguishes
 * "model retired" from any other reason a call can 404) without echoing
 * provider-supplied prose. Any parse failure, missing field, or value
 * outside the enum shape returns null and the caller falls back to its
 * existing bare-status message.
 */
const GEMINI_ERROR_STATUS_PATTERN = /^[A-Z_]{1,40}$/;

async function readGeminiErrorStatus(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { status?: unknown } };
    const status = body.error?.status;
    if (typeof status === 'string' && GEMINI_ERROR_STATUS_PATTERN.test(status)) {
      return status;
    }
    return null;
  } catch {
    return null;
  }
}

export type GeminiThinkingConfig = { thinkingBudget: number } | { thinkingLevel: 'low' };

/**
 * Gemini 2.5 takes `thinkingBudget` (an integer token allowance, 0 = off);
 * Gemini 3.x replaced it with `thinkingLevel` and REJECTS `thinkingBudget`
 * with 400 INVALID_ARGUMENT on some models (verified: gemini-3.6-flash,
 * 2026-09-14). Both branches express the same intent — structured
 * extraction from an image is perception, not multi-step reasoning, so
 * extended thinking buys nothing here.
 */
export function geminiThinkingConfig(model: string): GeminiThinkingConfig {
  return model.startsWith('gemini-2.5') ? { thinkingBudget: 0 } : { thinkingLevel: 'low' };
}

/**
 * Gemini's structured-output path: `responseMimeType: 'application/json'` +
 * `responseSchema` (constrained decoding), rather than Anthropic's forced
 * tool call. Extended thinking is disabled for this call via
 * `geminiThinkingConfig` — this is a structured extraction, not a
 * reasoning task, and thinking tokens would only add latency and cost here.
 * The shape of that config is chosen per model family — see
 * `geminiThinkingConfig`'s own comment.
 */
export function geminiModelClient(options: {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}): StructuredModelClient {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    provider: 'gemini',
    model: options.model,
    async generateStructured(request: StructuredRequest): Promise<StructuredResult> {
      const url = `${CAPTURE_GEMINI_BASE_URL}/models/${options.model}:generateContent`;
      const body = {
        contents: [
          {
            role: 'user',
            parts: [
              ...request.images.map((png) => ({
                inline_data: { mime_type: 'image/png', data: png.toString('base64') },
              })),
              { text: request.prompt },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: request.schema.geminiSchema,
          maxOutputTokens: request.maxTokens,
          temperature: 0,
          thinkingConfig: geminiThinkingConfig(options.model),
        },
      };

      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': options.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(request.timeoutMs),
      });

      if (!response.ok) {
        // Never echo the response body — it is untrusted and may carry
        // provider-side error detail (e.g. request content) we do not want
        // surfaced to a caller. The one exception is Google's own error
        // STATUS ENUM (e.g. NOT_FOUND, INVALID_ARGUMENT) — a fixed,
        // small vocabulary, never free text — which is appended only when
        // it matches that shape; anything else falls back to the bare
        // status code exactly as before.
        const enumStatus = await readGeminiErrorStatus(response);
        const suffix = enumStatus === null ? '' : ` (${enumStatus})`;
        throw new ApiError(502, `Gemini request failed with status ${String(response.status)}${suffix}`);
      }

      let json: GeminiResponse;
      try {
        json = (await response.json()) as GeminiResponse;
      } catch {
        return { value: null, usage: null };
      }

      const usage = normalizeGeminiUsage(json);

      const parts = json.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) return { value: null, usage };
      const textPart = parts.find((part) => typeof part.text === 'string');
      if (textPart?.text === undefined) return { value: null, usage };

      try {
        return { value: JSON.parse(textPart.text) as unknown, usage };
      } catch {
        return { value: null, usage };
      }
    },
  };
}

function defaultConfig(): ModelConfig {
  return {
    provider: env.CAPTURE_AI_PROVIDER,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.CAPTURE_GEMINI_MODEL,
  };
}

/** True when the selected provider's key is configured. */
export function isModelConfigured(config?: ModelConfig): boolean {
  const effective = config ?? defaultConfig();
  return effective.provider === 'anthropic' ? effective.anthropicApiKey !== '' : effective.geminiApiKey !== '';
}

/**
 * Resolves the configured provider's client. Throws 503 — same shape as
 * Phase 10's original inline check — when the selected provider's key is
 * unset.
 */
export function resolveModelClient(purpose: ModelPurpose, config?: ModelConfig): StructuredModelClient {
  const effective = config ?? defaultConfig();

  if (effective.provider === 'gemini') {
    if (effective.geminiApiKey === '') {
      throw new ApiError(503, 'Vision extraction is not configured (GEMINI_API_KEY is unset)');
    }
    return geminiModelClient({ apiKey: effective.geminiApiKey, model: effective.geminiModel });
  }

  if (effective.anthropicApiKey === '') {
    throw new ApiError(503, 'Vision extraction is not configured (ANTHROPIC_API_KEY is unset)');
  }
  return anthropicModelClient(purpose, undefined, effective.anthropicApiKey);
}
