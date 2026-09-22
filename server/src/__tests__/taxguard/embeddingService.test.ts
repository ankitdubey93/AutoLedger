import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EmbeddingsProviderError,
  batchTexts,
  embedTexts,
  geminiEmbeddingsClient,
  voyageEmbeddingsClient,
} from '../../services/taxguard/embeddingService.js';
import type { EmbeddingsClient } from '../../services/taxguard/embeddingService.js';
import {
  TAXGUARD_EMBEDDING_BATCH_SIZE,
  TAXGUARD_EMBEDDING_DIMENSIONS,
  TAXGUARD_EMBEDDING_MAX_BATCH_TOKENS,
  TAXGUARD_EMBEDDING_RETRY_BASE_MS,
  TAXGUARD_EMBEDDING_RETRY_MAX_MS,
  TAXGUARD_GEMINI_EMBEDDING_URL,
} from '../../config/constants.js';

/**
 * embeddingService's batching, retry and error-reporting — pure, no
 * database, no network. The real clients are exercised against a stubbed
 * global fetch so its HTTP-failure messages are pinned exactly: that message
 * is stored as the corpus row's error_message and is all the user sees.
 */

const vector = (): number[] => new Array<number>(TAXGUARD_EMBEDDING_DIMENSIONS).fill(0.1);

/** A text taxActParse's estimateTokens scores at exactly `tokens`. */
const textOfTokens = (tokens: number): string => 'a'.repeat(tokens * 4);

function recordingClient(calls: string[][]): EmbeddingsClient {
  return {
    embed: (texts) => {
      calls.push(texts);
      return Promise.resolve(texts.map(vector));
    },
  };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('batchTexts', () => {
  it('splits on the token budget, not only the input count', () => {
    const half = textOfTokens(TAXGUARD_EMBEDDING_MAX_BATCH_TOKENS / 2);
    const batches = batchTexts([half, half, half]);
    expect(batches.map((b) => b.length)).toEqual([2, 1]);
  });

  it('still caps a batch at the input count when texts are tiny', () => {
    const texts = new Array<string>(TAXGUARD_EMBEDDING_BATCH_SIZE + 1).fill('x');
    expect(batchTexts(texts).map((b) => b.length)).toEqual([TAXGUARD_EMBEDDING_BATCH_SIZE, 1]);
  });

  it('sends a single over-budget text alone rather than dropping it', () => {
    const huge = textOfTokens(TAXGUARD_EMBEDDING_MAX_BATCH_TOKENS + 1);
    expect(batchTexts(['x', huge, 'y'])).toEqual([['x'], [huge], ['y']]);
  });

  it('returns no batches for no texts', () => {
    expect(batchTexts([])).toEqual([]);
  });
});

describe('embedTexts', () => {
  it('returns one vector per input, in order, across token-budget batches', async () => {
    const calls: string[][] = [];
    const half = textOfTokens(TAXGUARD_EMBEDDING_MAX_BATCH_TOKENS / 2);
    const vectors = await embedTexts([half, half, half], 'document', recordingClient(calls));
    expect(calls).toHaveLength(2);
    expect(vectors).toHaveLength(3);
  });

  it('retries a retryable failure with capped exponential backoff, then succeeds', async () => {
    let attempts = 0;
    const client: EmbeddingsClient = {
      embed: (texts) => {
        attempts += 1;
        if (attempts <= 3) return Promise.reject(new EmbeddingsProviderError('rate limited', true));
        return Promise.resolve(texts.map(vector));
      },
    };
    const sleeps: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    };

    const vectors = await embedTexts(['a'], 'document', client, { maxRetries: 6, sleep });
    expect(vectors).toHaveLength(1);
    expect(sleeps).toEqual([
      TAXGUARD_EMBEDDING_RETRY_BASE_MS,
      Math.min(TAXGUARD_EMBEDDING_RETRY_MAX_MS, TAXGUARD_EMBEDDING_RETRY_BASE_MS * 2),
      Math.min(TAXGUARD_EMBEDDING_RETRY_MAX_MS, TAXGUARD_EMBEDDING_RETRY_BASE_MS * 4),
    ]);
  });

  it('gives up after maxRetries and rethrows the provider error', async () => {
    let attempts = 0;
    const client: EmbeddingsClient = {
      embed: () => {
        attempts += 1;
        return Promise.reject(new EmbeddingsProviderError('rate limited', true));
      },
    };
    await expect(embedTexts(['a'], 'document', client, { maxRetries: 2, sleep: noSleep })).rejects.toThrow(
      'rate limited',
    );
    expect(attempts).toBe(3);
  });

  it('does not retry by default — a query embedding must fail fast', async () => {
    let attempts = 0;
    const client: EmbeddingsClient = {
      embed: () => {
        attempts += 1;
        return Promise.reject(new EmbeddingsProviderError('rate limited', true));
      },
    };
    await expect(embedTexts(['q'], 'query', client)).rejects.toThrow('rate limited');
    expect(attempts).toBe(1);
  });

  it('does not retry a non-retryable failure', async () => {
    let attempts = 0;
    const client: EmbeddingsClient = {
      embed: () => {
        attempts += 1;
        return Promise.reject(new EmbeddingsProviderError('bad key', false));
      },
    };
    await expect(embedTexts(['a'], 'document', client, { maxRetries: 6, sleep: noSleep })).rejects.toThrow('bad key');
    expect(attempts).toBe(1);
  });

  it('rejects a vector of the wrong dimension', async () => {
    const client: EmbeddingsClient = { embed: (texts) => Promise.resolve(texts.map(() => [0.1, 0.2])) };
    await expect(embedTexts(['a'], 'document', client)).rejects.toThrow(
      'Embeddings provider returned an unexpected response',
    );
  });
});

describe('voyageEmbeddingsClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubFetch(status: number, body: string): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(body, { status })));
  }

  async function embedError(): Promise<EmbeddingsProviderError> {
    try {
      await voyageEmbeddingsClient('test-key').embed(['a'], 'document');
    } catch (err) {
      if (err instanceof EmbeddingsProviderError) return err;
      throw err;
    }
    throw new Error('expected embed to throw');
  }

  it('reports a 429 as a retryable rate limit carrying the provider detail', async () => {
    stubFetch(429, JSON.stringify({ detail: 'reduced rate limits of 3 RPM and 10K TPM' }));
    const err = await embedError();
    expect(err.retryable).toBe(true);
    expect(err.message).toBe(
      'Embeddings provider rate limit exceeded (HTTP 429): reduced rate limits of 3 RPM and 10K TPM',
    );
  });

  it('reports a 401 as a non-retryable rejected key', async () => {
    stubFetch(401, JSON.stringify({ detail: 'Provided API key is invalid.' }));
    const err = await embedError();
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('Embeddings provider rejected the API key (HTTP 401): Provided API key is invalid.');
  });

  it('reports a 5xx as retryable, falling back to the raw body when it is not JSON', async () => {
    stubFetch(503, 'upstream unavailable');
    const err = await embedError();
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('Embeddings provider request failed (HTTP 503): upstream unavailable');
  });

  it('reports a network failure as retryable', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    const err = await embedError();
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('Embeddings provider could not be reached: fetch failed');
  });
});

describe('geminiEmbeddingsClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends one request per text with the task type and 1024 dims, and keeps request order', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            embeddings: [{ values: new Array<number>(TAXGUARD_EMBEDDING_DIMENSIONS).fill(1) }, { values: vector() }],
          }),
          { status: 200 },
        ),
      ),
    );

    const vectors = await geminiEmbeddingsClient('test-key').embed(['first', 'second'], 'query');

    expect(vectors[0]?.[0]).toBe(1);
    expect(vectors[1]?.[0]).toBe(0.1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(TAXGUARD_GEMINI_EMBEDDING_URL);
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
    const body = JSON.parse(init?.body as string) as {
      requests: { content: { parts: { text: string }[] }; taskType: string; outputDimensionality: number }[];
    };
    expect(body.requests.map((r) => r.content.parts[0]?.text)).toEqual(['first', 'second']);
    expect(body.requests.every((r) => r.taskType === 'RETRIEVAL_QUERY')).toBe(true);
    expect(body.requests.every((r) => r.outputDimensionality === TAXGUARD_EMBEDDING_DIMENSIONS)).toBe(true);
  });

  it('marks document embeddings RETRIEVAL_DOCUMENT', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ embeddings: [{ values: vector() }] }), { status: 200 })),
      );
    await geminiEmbeddingsClient('test-key').embed(['a'], 'document');
    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string) as { requests: { taskType: string }[] };
    expect(body.requests[0]?.taskType).toBe('RETRIEVAL_DOCUMENT');
  });

  it("reports a 429 with Gemini's own error message", async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }), {
          status: 429,
        }),
      ),
    );
    const err = await geminiEmbeddingsClient('test-key')
      .embed(['a'], 'document')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingsProviderError);
    expect((err as EmbeddingsProviderError).retryable).toBe(true);
    expect((err as EmbeddingsProviderError).message).toBe(
      'Embeddings provider rate limit exceeded (HTTP 429): Quota exceeded',
    );
  });

  it('rejects a 200 without an embeddings array', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
    await expect(geminiEmbeddingsClient('test-key').embed(['a'], 'document')).rejects.toThrow(
      'Embeddings provider returned an unexpected response',
    );
  });
});
