import { env } from '../../config/env.js';
import {
  TAXGUARD_EMBEDDING_BATCH_SIZE,
  TAXGUARD_EMBEDDING_DIMENSIONS,
  TAXGUARD_EMBEDDING_MAX_BATCH_TOKENS,
  TAXGUARD_EMBEDDING_RETRY_BASE_MS,
  TAXGUARD_EMBEDDING_RETRY_MAX_MS,
  TAXGUARD_EMBEDDING_TIMEOUT_MS,
  TAXGUARD_GEMINI_EMBEDDING_MODEL,
  TAXGUARD_GEMINI_EMBEDDING_URL,
  TAXGUARD_VOYAGE_EMBEDDING_MODEL,
  TAXGUARD_VOYAGE_EMBEDDING_URL,
} from '../../config/constants.js';
import { ApiError } from '../../utils/apiError.js';
import { estimateTokens } from '../../utils/taxActParse.js';

/**
 * TaxGuard AI (Phase 16) — embeddings. Touches no database — this file must
 * never import db/connect.js. Every network call goes through the
 * injectable `EmbeddingsClient` seam so tests never reach the network
 * (guardrails rule 14 — plain `fetch`, no new npm package).
 *
 * Two providers, selected by TAXGUARD_EMBEDDING_PROVIDER: Voyage AI
 * (Anthropic ships no embeddings endpoint; Voyage is its own documented
 * recommendation) and Gemini (`gemini-embedding-001` on the GEMINI_API_KEY
 * AP-Flow already uses — its free tier embeds a 50-page act in seconds, where
 * Voyage's no-payment-method tier takes ~15 minutes). Both return 1024 dims,
 * but their vector spaces are unrelated: a corpus must be embedded by the
 * provider that later embeds its queries. See docs/taxguard.md.
 */

export interface EmbeddingsClient {
  embed(texts: string[], inputType: 'document' | 'query'): Promise<number[][]>;
}

interface VoyageEmbeddingDatum {
  embedding: number[];
  index: number;
}

interface VoyageEmbeddingResponse {
  data: VoyageEmbeddingDatum[];
}

interface GeminiEmbeddingResponse {
  embeddings: { values: number[] }[];
}

const PROVIDER_DETAIL_MAX_CHARS = 300;

/**
 * A failed call to the embeddings provider. `retryable` is true for a rate
 * limit (429), a provider-side 5xx, or a network/timeout failure — the cases
 * where the same request may succeed later. The message carries the HTTP
 * status and the provider's own explanation, because it is stored verbatim
 * as the corpus row's error_message and is the only diagnosis the user sees.
 */
export class EmbeddingsProviderError extends ApiError {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(502, message);
    this.name = 'EmbeddingsProviderError';
    this.retryable = retryable;
  }
}

/** Voyage returns `{ detail }`, Gemini `{ error: { message } }`; fall back to the raw body. */
async function readProviderDetail(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: { message?: unknown } };
    if (typeof parsed.detail === 'string') detail = parsed.detail;
    else if (typeof parsed.error?.message === 'string') detail = parsed.error.message;
  } catch {
    // Not JSON — keep the raw text.
  }
  return detail.trim().slice(0, PROVIDER_DETAIL_MAX_CHARS);
}

function httpFailureMessage(status: number, detail: string): string {
  const label =
    status === 429
      ? 'Embeddings provider rate limit exceeded'
      : status === 401 || status === 403
        ? 'Embeddings provider rejected the API key'
        : 'Embeddings provider request failed';
  return detail === '' ? `${label} (HTTP ${status})` : `${label} (HTTP ${status}): ${detail}`;
}

/** POSTs a JSON body; maps network and HTTP failures onto EmbeddingsProviderError. */
async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TAXGUARD_EMBEDDING_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw new EmbeddingsProviderError(`Embeddings provider could not be reached: ${reason}`, true);
  }

  if (!response.ok) {
    const detail = await readProviderDetail(response);
    const retryable = response.status === 429 || response.status >= 500;
    throw new EmbeddingsProviderError(httpFailureMessage(response.status, detail), retryable);
  }
  return response.json();
}

function unexpectedResponse(): EmbeddingsProviderError {
  return new EmbeddingsProviderError('Embeddings provider returned an unexpected response', false);
}

export function voyageEmbeddingsClient(apiKey: string): EmbeddingsClient {
  return {
    async embed(texts, inputType) {
      const json = (await postJson(
        TAXGUARD_VOYAGE_EMBEDDING_URL,
        { Authorization: `Bearer ${apiKey}` },
        {
          input: texts,
          model: TAXGUARD_VOYAGE_EMBEDDING_MODEL,
          input_type: inputType,
          output_dimension: TAXGUARD_EMBEDDING_DIMENSIONS,
        },
      )) as VoyageEmbeddingResponse;
      if (!Array.isArray(json.data)) throw unexpectedResponse();

      return [...json.data].sort((a, b) => a.index - b.index).map((datum) => datum.embedding);
    },
  };
}

/** batchEmbedContents returns `embeddings` in request order — no index field to sort by. */
export function geminiEmbeddingsClient(apiKey: string): EmbeddingsClient {
  return {
    async embed(texts, inputType) {
      const taskType = inputType === 'document' ? 'RETRIEVAL_DOCUMENT' : 'RETRIEVAL_QUERY';
      const json = (await postJson(
        TAXGUARD_GEMINI_EMBEDDING_URL,
        { 'x-goog-api-key': apiKey },
        {
          requests: texts.map((text) => ({
            model: `models/${TAXGUARD_GEMINI_EMBEDDING_MODEL}`,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: TAXGUARD_EMBEDDING_DIMENSIONS,
          })),
        },
      )) as GeminiEmbeddingResponse;
      if (!Array.isArray(json.embeddings)) throw unexpectedResponse();

      return json.embeddings.map((embedding) => embedding.values);
    },
  };
}

function configuredApiKey(): string {
  return env.TAXGUARD_EMBEDDING_PROVIDER === 'gemini' ? env.GEMINI_API_KEY : env.VOYAGE_API_KEY;
}

/** The client for TAXGUARD_EMBEDDING_PROVIDER. */
export function realEmbeddingsClient(): EmbeddingsClient {
  const apiKey = configuredApiKey();
  return env.TAXGUARD_EMBEDDING_PROVIDER === 'gemini'
    ? geminiEmbeddingsClient(apiKey)
    : voyageEmbeddingsClient(apiKey);
}

/**
 * Groups texts into batches of at most TAXGUARD_EMBEDDING_BATCH_SIZE inputs
 * and TAXGUARD_EMBEDDING_MAX_BATCH_TOKENS estimated tokens. A single text
 * over the token budget still goes out, alone — splitting it is the
 * chunker's job, not this one's.
 */
export function batchTexts(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const text of texts) {
    const tokens = estimateTokens(text);
    const full =
      current.length >= TAXGUARD_EMBEDDING_BATCH_SIZE || currentTokens + tokens > TAXGUARD_EMBEDDING_MAX_BATCH_TOKENS;
    if (full && current.length > 0) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(text);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface EmbedOptions {
  /** Retries per batch on a retryable provider failure. Default 0 — a
   *  question-time query embedding runs inside an HTTP request and must fail
   *  fast; only background ingestion opts in. */
  maxRetries?: number;
  /** Injectable so tests never actually wait out a backoff. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelayMs(attempt: number): number {
  return Math.min(TAXGUARD_EMBEDDING_RETRY_MAX_MS, TAXGUARD_EMBEDDING_RETRY_BASE_MS * 2 ** attempt);
}

async function embedBatchWithRetry(
  client: EmbeddingsClient,
  batch: string[],
  inputType: 'document' | 'query',
  maxRetries: number,
  sleep: (ms: number) => Promise<void>,
): Promise<number[][]> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.embed(batch, inputType);
    } catch (err) {
      if (!(err instanceof EmbeddingsProviderError) || !err.retryable || attempt >= maxRetries) throw err;
      await sleep(retryDelayMs(attempt));
    }
  }
}

/** Batches by count and token budget; returns one vector per input, in order. */
export async function embedTexts(
  texts: string[],
  inputType: 'document' | 'query',
  client?: EmbeddingsClient,
  options: EmbedOptions = {},
): Promise<number[][]> {
  if (client === undefined && configuredApiKey() === '') {
    throw new ApiError(503, 'Embeddings are not configured');
  }
  const activeClient = client ?? realEmbeddingsClient();
  const maxRetries = options.maxRetries ?? 0;
  const sleep = options.sleep ?? realSleep;

  const results: number[][] = [];
  for (const batch of batchTexts(texts)) {
    const vectors = await embedBatchWithRetry(activeClient, batch, inputType, maxRetries, sleep);
    if (vectors.length !== batch.length) throw unexpectedResponse();
    for (const vector of vectors) {
      if (!Array.isArray(vector) || vector.length !== TAXGUARD_EMBEDDING_DIMENSIONS) throw unexpectedResponse();
    }
    results.push(...vectors);
  }
  return results;
}

/** pgvector's text input format: '[0.1,0.2,...]'. */
export function toVectorLiteral(embedding: number[]): string {
  if (embedding.length !== TAXGUARD_EMBEDDING_DIMENSIONS) {
    throw new Error('toVectorLiteral: wrong dimension');
  }
  return `[${embedding.join(',')}]`;
}
