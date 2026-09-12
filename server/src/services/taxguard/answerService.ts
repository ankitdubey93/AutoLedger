import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.js';
import { TAXGUARD_ANSWER_MAX_TOKENS, TAXGUARD_ANSWER_MODEL, TAXGUARD_ANSWER_TIMEOUT_MS } from '../../config/constants.js';
import { ApiError } from '../../utils/apiError.js';
import type { RetrievedChunk, TaxGuardCitation } from '../../types/taxguard.js';

/**
 * TaxGuard AI (Phase 16) — cited answering. Touches no database — this file
 * must never import db/connect.js. Every network call goes through the
 * injectable `AnswerClient` seam so tests never reach the network
 * (guardrails rule 14 — @anthropic-ai/sdk is already installed, Phase 10).
 */

const SYSTEM_PROMPT =
  'You answer tax questions using ONLY the numbered sources provided. If the sources do ' +
  'not contain the answer, say so plainly and do not speculate. Cite every claim inline as ' +
  '[n]. Never invent a section number that does not appear in the sources.';

/**
 * The model is forced into a tool call, never asked for free-form JSON — a
 * tool's `input_schema` is validated by the API before the response is
 * returned, the same pattern AP-Flow's EXTRACTION_TOOL established.
 */
export const ANSWER_TOOL = {
  name: 'record_answer',
  description: 'Record the answer to the tax question, grounded in the numbered sources provided.',
  input_schema: {
    type: 'object',
    properties: {
      answer: {
        type: 'string',
        description: 'The answer in plain prose. Cite sources inline as [1], [2].',
      },
      cited_sources: {
        type: 'array',
        items: { type: 'integer' },
        description: '1-based indices of the provided sources actually relied on.',
      },
    },
    required: ['answer', 'cited_sources'],
  },
} as const;

export interface AnswerClient {
  messages: {
    create(body: unknown, options?: { timeout?: number }): Promise<unknown>;
  };
}

export function realAnswerClient(): AnswerClient {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return {
    messages: {
      create: (body, options) =>
        anthropic.messages.create(body as Anthropic.Messages.MessageCreateParamsNonStreaming, options),
    },
  };
}

export interface AnswerResult {
  answerText: string;
  citations: TaxGuardCitation[];
  model: string;
}

interface RecordAnswerInput {
  answer: string;
  cited_sources: number[];
}

function isRecordAnswerInput(value: unknown): value is RecordAnswerInput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.answer === 'string' &&
    Array.isArray(candidate.cited_sources) &&
    candidate.cited_sources.every((n) => typeof n === 'number')
  );
}

interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  input: unknown;
}

function isToolUseBlock(value: unknown): value is ToolUseBlock {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'tool_use' && typeof candidate.name === 'string';
}

export async function answer(
  redactedQuestion: string,
  chunks: RetrievedChunk[],
  client?: AnswerClient,
): Promise<AnswerResult> {
  if (chunks.length === 0) {
    throw new ApiError(422, 'No relevant source material found');
  }
  if (client === undefined && env.ANTHROPIC_API_KEY === '') {
    throw new ApiError(503, 'Answering is not configured');
  }
  const activeClient = client ?? realAnswerClient();

  const sourcesText = chunks.map((chunk, i) => `[${i + 1}] ${chunk.citation}\n${chunk.content}`).join('\n\n');
  const userMessage = `${sourcesText}\n\nQuestion: ${redactedQuestion}`;

  const response = await activeClient.messages.create(
    {
      model: TAXGUARD_ANSWER_MODEL,
      max_tokens: TAXGUARD_ANSWER_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [ANSWER_TOOL],
      tool_choice: { type: 'tool', name: ANSWER_TOOL.name },
      messages: [{ role: 'user', content: userMessage }],
    },
    { timeout: TAXGUARD_ANSWER_TIMEOUT_MS },
  );

  const content = (response as { content?: unknown[] }).content ?? [];
  const toolUse = content.find(isToolUseBlock);
  if (toolUse === undefined || !isRecordAnswerInput(toolUse.input)) {
    throw new ApiError(502, 'Answer model returned an unexpected response');
  }

  const citations: TaxGuardCitation[] = [];
  for (const index of toolUse.input.cited_sources) {
    const chunk = chunks[index - 1];
    if (chunk === undefined) continue; // out-of-range index dropped silently
    citations.push({
      chunkId: chunk.id,
      citation: chunk.citation,
      corpusDocumentTitle: chunk.corpusDocumentTitle,
      score: chunk.score,
    });
  }

  return { answerText: toolUse.input.answer, citations, model: TAXGUARD_ANSWER_MODEL };
}
