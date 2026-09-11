import type { PoolClient } from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { pool } from '../../db/connect.js';
import { env } from '../../config/env.js';
import {
  AP_FLOW_CLASSIFY_MAX_TOKENS,
  AP_FLOW_CLASSIFY_MODEL,
  AP_FLOW_CLASSIFY_TIMEOUT_MS,
} from '../../config/constants.js';
import { normalizeForMatching } from '../../utils/matchScore.js';
import { similarity } from '../../utils/levenshtein.js';
import * as accountService from '../ledger-core/accountService.js';
import { classificationToolInputSchema } from '../../schemas/ap-flow/mappingSchema.js';
import type { ApFlowLineItem, ApFlowMappingSource } from '../../types/ap-flow.js';
import type { Account } from '../../types/ledger-core.js';

/**
 * AP-Flow's account classification (Phase 11) — GL coding inferred in a
 * deliberate order, cheapest and most explainable first: the organization's
 * own posting history for this vendor, then a name match against its own
 * chart, then a model as a last resort. Every function takes `orgId` first
 * and every statement carries an `org_id` predicate (guardrails rule 1).
 *
 * This file reads LedgerCore's chart of accounts exclusively through
 * `accountService`'s exported functions — never a query against `accounts`
 * — because AP-Flow does not own that table (guardrails rule 16).
 */

/** Chart-name match below this similarity is not a signal. Tuned by hand against the default chart, not measured against a labelled corpus. */
export const CHART_MATCH_MIN_SIMILARITY = 0.62;

export interface LineItemClassification {
  lineIndex: number;
  description: string;
  amountCents: number;
  suggestedAccountId: string | null;
  mappingSource: ApFlowMappingSource;
  mappingConfidence: number | null;
}

export interface ClassificationClient {
  messages: {
    create(body: unknown, options?: { timeout?: number }): Promise<unknown>;
  };
}

/**
 * The model is forced into a tool call, never asked for free-form JSON —
 * the same discipline `extractionService.EXTRACTION_TOOL` uses, and for the
 * same reason: a tool's `input_schema` is validated by the API before the
 * response is returned.
 */
export const CLASSIFICATION_TOOL = {
  name: 'suggest_accounts',
  description: 'Assign each invoice line item to one expense account from the supplied chart.',
  input_schema: {
    type: 'object',
    properties: {
      assignments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line_index: { type: 'number' },
            account_code: { type: 'string', description: 'Must be one of the codes listed in the prompt' },
            confidence: { type: 'number', description: '0-1' },
          },
          required: ['line_index', 'account_code', 'confidence'],
        },
      },
    },
    required: ['assignments'],
  },
} as const;

function realClassifierClient(): ClassificationClient {
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

/** normalizeForMatching(vendorName), truncated to 200 chars — this table's key length. '' when the name is null or blank. */
export function vendorKeyOf(vendorName: string | null): string {
  if (vendorName === null) return '';
  return normalizeForMatching(vendorName).slice(0, 200);
}

/** Rounds a 0-1 score to 3 decimal places, matching mapping_confidence's NUMERIC(4,3). */
function round3(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

/**
 * Classifies every line item on one document. Tier 1 (history) wins
 * outright and returns immediately when it hits — tiers 2 and 3 never run.
 * Otherwise tier 2 (chart name match) classifies what it can, and any line
 * still unmapped is left `'NONE'` here for the caller to pass to tier 3
 * (`classifyWithModel`, Step 6) if it wants to try further.
 */
export async function classifyLineItems(
  orgId: string,
  input: { vendorName: string | null; lineItems: ApFlowLineItem[] },
  deps?: { classifier?: ClassificationClient },
): Promise<LineItemClassification[]> {
  const vendorKey = vendorKeyOf(input.vendorName);

  // Tier 1 — history. An organization's own past posting for this vendor is
  // ground truth, not a guess, so it wins outright: nothing downstream runs.
  if (vendorKey !== '') {
    const { rows } = await pool.query<{ account_id: string; hit_count: number }>(
      'SELECT account_id, hit_count FROM ap_flow_vendor_account_map WHERE org_id = $1 AND vendor_key = $2',
      [orgId, vendorKey],
    );
    const historyRow = rows[0];
    if (historyRow !== undefined) {
      const confidence = round3(0.6 + 0.05 * historyRow.hit_count);
      return input.lineItems.map((item, lineIndex) => ({
        lineIndex,
        description: item.description,
        amountCents: item.amountCents,
        suggestedAccountId: historyRow.account_id,
        mappingSource: 'HISTORY',
        mappingConfidence: confidence,
      }));
    }
  }

  // Tier 2 — chart. Read through accountService, never a direct query
  // against `accounts` (rule 16). Only postable expense accounts are
  // eligible candidates — a header account cannot receive a posting.
  const chart = await accountService.listAccounts(orgId);
  const expenseAccounts = chart.filter((account) => account.isPostable && account.type === 'Expense');

  const classifications: LineItemClassification[] = input.lineItems.map((item, lineIndex) => {
    let bestAccountId: string | null = null;
    let bestScore = 0;
    for (const account of expenseAccounts) {
      const score = similarity(normalizeForMatching(item.description), normalizeForMatching(account.name));
      if (score > bestScore) {
        bestScore = score;
        bestAccountId = account.id;
      }
    }

    if (bestAccountId !== null && bestScore >= CHART_MATCH_MIN_SIMILARITY) {
      return {
        lineIndex,
        description: item.description,
        amountCents: item.amountCents,
        suggestedAccountId: bestAccountId,
        mappingSource: 'CHART' as ApFlowMappingSource,
        mappingConfidence: round3(bestScore),
      };
    }

    return {
      lineIndex,
      description: item.description,
      amountCents: item.amountCents,
      suggestedAccountId: null,
      mappingSource: 'NONE' as ApFlowMappingSource,
      mappingConfidence: null,
    };
  });

  // Tier 3 — the model, only for whatever tier 2 left 'NONE'. A convenience,
  // not a guarantee: unlike extraction, a classification failure here must
  // never fail the document — it degrades to 'NONE' and the reviewer maps
  // it by hand instead.
  const unmapped = classifications.filter((c) => c.mappingSource === 'NONE');
  if (unmapped.length === 0) return classifications;

  const modelResults = await classifyWithModel(unmapped, expenseAccounts, deps?.classifier);
  for (const classification of classifications) {
    const result = modelResults.get(classification.lineIndex);
    if (result === undefined) continue;
    classification.suggestedAccountId = result.accountId;
    classification.mappingSource = 'MODEL';
    classification.mappingConfidence = result.confidence;
  }

  return classifications;
}

/**
 * Tier 3. Called only with the lines tier 2 left unmapped. Degrades to an
 * empty map — leaving every line 'NONE' — on a missing API key or any
 * thrown error; classification is a convenience, and a model outage must
 * not fail a document that extracted fine.
 */
async function classifyWithModel(
  unmapped: LineItemClassification[],
  candidates: Account[],
  client?: ClassificationClient,
): Promise<Map<number, { accountId: string; confidence: number }>> {
  const results = new Map<number, { accountId: string; confidence: number }>();

  if (client === undefined && env.ANTHROPIC_API_KEY === '') {
    console.warn('[ap-flow] account classification unavailable: ANTHROPIC_API_KEY is unset');
    return results;
  }

  try {
    const effectiveClient = client ?? realClassifierClient();
    const codeToId = new Map(candidates.map((account) => [account.code, account.id]));

    const chartLines = candidates.map((account) => `${account.code} — ${account.name}`).join('\n');
    const lineLines = unmapped.map((item) => `${String(item.lineIndex)}: ${item.description}`).join('\n');

    const body = {
      model: AP_FLOW_CLASSIFY_MODEL,
      max_tokens: AP_FLOW_CLASSIFY_MAX_TOKENS,
      tools: [CLASSIFICATION_TOOL],
      tool_choice: { type: 'tool', name: 'suggest_accounts' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Chart of accounts:\n${chartLines}\n\nUnmapped line items:\n${lineLines}\n\nAssign each line item to the single best-fitting account code from the chart above using the suggest_accounts tool.`,
            },
          ],
        },
      ],
    };

    const response = await effectiveClient.messages.create(body, { timeout: AP_FLOW_CLASSIFY_TIMEOUT_MS });
    const toolUse = findToolUseBlock(response);
    if (toolUse === null) return results;

    const parsed = classificationToolInputSchema.parse(toolUse.input);
    for (const assignment of parsed.assignments) {
      // A model-named account code outside the candidate list is discarded
      // — the model naming an account that does not exist must not
      // silently become a suggestion.
      const accountId = codeToId.get(assignment.account_code);
      if (accountId === undefined) continue;
      results.set(assignment.line_index, { accountId, confidence: round3(assignment.confidence) });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.warn(`[ap-flow] account classification unavailable: ${message}`);
  }

  return results;
}

/**
 * Replaces this document's line items wholesale — DELETE-then-INSERT,
 * mirroring `apFlowDocumentService.savePipelineResult`'s treatment of pages
 * and extractions, because a re-extraction is a new read of the document
 * and an old override was an opinion about the old read. Every statement on
 * `client` (rule 5) — this must run inside the caller's transaction.
 */
export async function saveLineItemsOnClient(
  client: PoolClient,
  orgId: string,
  apFlowDocumentId: string,
  classifications: LineItemClassification[],
): Promise<void> {
  await client.query(
    'DELETE FROM ap_flow_line_items WHERE org_id = $1 AND ap_flow_document_id = $2',
    [orgId, apFlowDocumentId],
  );

  if (classifications.length === 0) return;

  await client.query(
    `INSERT INTO ap_flow_line_items
       (org_id, ap_flow_document_id, line_index, description, amount_cents,
        account_id, suggested_account_id, mapping_source, mapping_confidence)
     SELECT $1, $2, v.line_index, v.description, v.amount_cents,
            v.suggested_account_id, v.suggested_account_id, v.mapping_source, v.mapping_confidence
       FROM unnest($3::int[], $4::text[], $5::bigint[], $6::uuid[], $7::text[], $8::numeric[])
            AS v(line_index, description, amount_cents, suggested_account_id, mapping_source, mapping_confidence)`,
    [
      orgId,
      apFlowDocumentId,
      classifications.map((c) => c.lineIndex),
      classifications.map((c) => c.description),
      classifications.map((c) => c.amountCents),
      classifications.map((c) => c.suggestedAccountId),
      classifications.map((c) => c.mappingSource),
      classifications.map((c) => c.mappingConfidence),
    ],
  );
}

/**
 * Records (or bumps) which account this organization posted a vendor to.
 * Called once, at posting time (Step 13), never at classification time —
 * classification only reads this table.
 */
export async function recordVendorMappingOnClient(
  client: PoolClient,
  orgId: string,
  vendorKey: string,
  accountId: string,
): Promise<void> {
  if (vendorKey === '') return;

  await client.query(
    `INSERT INTO ap_flow_vendor_account_map (org_id, vendor_key, account_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (org_id, vendor_key)
     DO UPDATE SET account_id = EXCLUDED.account_id,
                   hit_count = ap_flow_vendor_account_map.hit_count + 1,
                   last_used_at = now()`,
    [orgId, vendorKey, accountId],
  );
}
