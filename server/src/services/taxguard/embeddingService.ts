import { env } from '../../config/env.js';
import {
  TAXGUARD_EMBEDDING_BATCH_SIZE,
  TAXGUARD_EMBEDDING_DIMENSIONS,
  TAXGUARD_EMBEDDING_MODEL,
  TAXGUARD_EMBEDDING_TIMEOUT_MS,
  TAXGUARD_EMBEDDING_URL,
} from '../../config/constants.js';
import { ApiError } from '../../utils/apiError.js';

/**
 * TaxGuard AI (Phase 16) — embeddings. Touches no database — this file must
 * never import db/connect.js. Every network call goes through the
 * injectable `EmbeddingsClient` seam so tests never reach the network
 * (guardrails rule 14 — Voyage AI over plain `fetch`, no new npm package).
 *
 * Anthropic ships no embeddings endpoint; Voyage AI is its own documented
 * recommendation. Using built-in `fetch` rather than an SDK keeps this a
 * zero-dependency addition. See docs/taxguard.md.
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

export function realEmbeddingsClient(): EmbeddingsClient {
  return {
    async embed(texts, inputType) {
      const response = await fetch(TAXGUARD_EMBEDDING_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: texts,
          model: TAXGUARD_EMBEDDING_MODEL,
          input_type: inputType,
          output_dimension: TAXGUARD_EMBEDDING_DIMENSIONS,
        }),
        signal: AbortSignal.timeout(TAXGUARD_EMBEDDING_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new ApiError(502, 'Embeddings provider returned an unexpected response');
      }

      const json = (await response.json()) as VoyageEmbeddingResponse;
      if (!Array.isArray(json.data)) {
        throw new ApiError(502, 'Embeddings provider returned an unexpected response');
      }

      return [...json.data].sort((a, b) => a.index - b.index).map((datum) => datum.embedding);
    },
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/** Batches at TAXGUARD_EMBEDDING_BATCH_SIZE; returns one vector per input, in order. */
export async function embedTexts(
  texts: string[],
  inputType: 'document' | 'query',
  client?: EmbeddingsClient,
): Promise<number[][]> {
  if (client === undefined && env.VOYAGE_API_KEY === '') {
    throw new ApiError(503, 'Embeddings are not configured');
  }
  const activeClient = client ?? realEmbeddingsClient();

  const results: number[][] = [];
  for (const batch of chunkArray(texts, TAXGUARD_EMBEDDING_BATCH_SIZE)) {
    const vectors = await activeClient.embed(batch, inputType);
    if (vectors.length !== batch.length) {
      throw new ApiError(502, 'Embeddings provider returned an unexpected response');
    }
    for (const vector of vectors) {
      if (vector.length !== TAXGUARD_EMBEDDING_DIMENSIONS) {
        throw new ApiError(502, 'Embeddings provider returned an unexpected response');
      }
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
