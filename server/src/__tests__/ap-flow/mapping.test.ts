import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import {
  classifyLineItems,
  saveLineItemsOnClient,
  vendorKeyOf,
  CHART_MATCH_MIN_SIMILARITY,
} from '../../services/ap-flow/mappingService.js';
import type { ClassificationClient } from '../../services/ap-flow/mappingService.js';
import { withTransaction } from '../../db/transaction.js';

/**
 * mappingService's three classification tiers, proven in isolation. No case
 * here makes a network call or needs ANTHROPIC_API_KEY — every tier-3 case
 * injects a stub classifier, mirroring extractionService's test discipline.
 */

function stubClassifier(assignments: { line_index: number; account_code: string; confidence: number }[]): ClassificationClient {
  return {
    messages: {
      create: () =>
        Promise.resolve({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'suggest_accounts', input: { assignments } }],
        }),
    },
  };
}

function throwingClassifier(): ClassificationClient {
  return {
    messages: {
      create: () => Promise.reject(new Error('model unavailable')),
    },
  };
}

let userA: SeededUser;
let orgA: string;
let userB: SeededUser;
let orgB: string;

describe('mappingService.vendorKeyOf', () => {
  it('normalizes case and punctuation', () => {
    expect(vendorKeyOf('AWS Cloud Services, Inc.')).toBe('aws cloud services inc');
  });

  it('returns empty string for a null vendor', () => {
    expect(vendorKeyOf(null)).toBe('');
  });
});

describe('mappingService.classifyLineItems', () => {
  beforeEach(async () => {
    await resetTables();
    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;
    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    orgB = userB.orgId;
  });

  afterAll(closePool);

  async function accountIdByCode(orgId: string, code: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
      [orgId, code],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`fixture: no account ${code} for org ${orgId}`);
    return id;
  }

  it('history wins outright and the model is never called', async () => {
    const accountId = await accountIdByCode(orgA, '6120');
    await pool.query(
      'INSERT INTO ap_flow_vendor_account_map (org_id, vendor_key, account_id, hit_count) VALUES ($1, $2, $3, 1)',
      [orgA, 'aws cloud services', accountId],
    );

    const classifierSpy = vi.fn();
    const classifier: ClassificationClient = { messages: { create: classifierSpy } };

    const results = await classifyLineItems(
      orgA,
      {
        vendorName: 'AWS Cloud Services',
        lineItems: [
          { description: 'EC2 Compute Instances', amountCents: 35000 },
          { description: 'S3 Storage Usage', amountCents: 10000 },
        ],
      },
      { classifier },
    );

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.mappingSource).toBe('HISTORY');
      expect(r.suggestedAccountId).toBe(accountId);
    }
    expect(classifierSpy).not.toHaveBeenCalled();
  });

  it('history confidence rises with hit count', async () => {
    const accountId = await accountIdByCode(orgA, '6120');

    await pool.query(
      'INSERT INTO ap_flow_vendor_account_map (org_id, vendor_key, account_id, hit_count) VALUES ($1, $2, $3, 1)',
      [orgA, 'vendor one', accountId],
    );
    const [low] = await classifyLineItems(orgA, {
      vendorName: 'Vendor One',
      lineItems: [{ description: 'x', amountCents: 100 }],
    });
    expect(low?.mappingConfidence).toBe(0.65);

    await pool.query('UPDATE ap_flow_vendor_account_map SET hit_count = 8 WHERE org_id = $1', [orgA]);
    const [high] = await classifyLineItems(orgA, {
      vendorName: 'Vendor One',
      lineItems: [{ description: 'x', amountCents: 100 }],
    });
    expect(high?.mappingConfidence).toBe(1);
  });

  it('chart matching maps a line by account name', async () => {
    const officeSuppliesId = await accountIdByCode(orgA, '6130');

    const [result] = await classifyLineItems(orgA, {
      vendorName: 'Some New Vendor',
      lineItems: [{ description: 'Office Supplies', amountCents: 5000 }],
    });

    expect(result?.mappingSource).toBe('CHART');
    expect(result?.suggestedAccountId).toBe(officeSuppliesId);
    expect(result?.mappingConfidence).toBeGreaterThanOrEqual(CHART_MATCH_MIN_SIMILARITY);
  });

  it('chart matching leaves an unrelated description unmapped', async () => {
    const [result] = await classifyLineItems(orgA, {
      vendorName: 'Some New Vendor',
      lineItems: [{ description: 'zzzzzzzz qqqq', amountCents: 5000 }],
    });

    expect(result?.mappingSource).toBe('NONE');
    expect(result?.suggestedAccountId).toBeNull();
  });

  it('the model fills only what the chart missed', async () => {
    const softwareId = await accountIdByCode(orgA, '6120');

    const classifier = stubClassifier([{ line_index: 1, account_code: '6120', confidence: 0.7 }]);

    const results = await classifyLineItems(
      orgA,
      {
        vendorName: 'Some New Vendor',
        lineItems: [
          { description: 'Office Supplies', amountCents: 1000 },
          { description: 'zzzzzzzz qqqq', amountCents: 2000 },
        ],
      },
      { classifier },
    );

    expect(results.map((r) => r.mappingSource)).toEqual(['CHART', 'MODEL']);
    expect(results[1]?.suggestedAccountId).toBe(softwareId);
    expect(results[1]?.mappingConfidence).toBe(0.7);
  });

  it('a model-named account code outside the chart is discarded', async () => {
    const classifier = stubClassifier([{ line_index: 0, account_code: '9999', confidence: 0.9 }]);

    const [result] = await classifyLineItems(
      orgA,
      { vendorName: 'Some New Vendor', lineItems: [{ description: 'zzzzzzzz qqqq', amountCents: 1000 }] },
      { classifier },
    );

    expect(result?.mappingSource).toBe('NONE');
    expect(result?.suggestedAccountId).toBeNull();
  });

  it('a throwing classifier degrades to NONE rather than failing', async () => {
    const classifier = throwingClassifier();

    const [result] = await classifyLineItems(
      orgA,
      { vendorName: 'Some New Vendor', lineItems: [{ description: 'zzzzzzzz qqqq', amountCents: 1000 }] },
      { classifier },
    );

    expect(result?.mappingSource).toBe('NONE');
  });

  it('classification is scoped to the organization', async () => {
    const accountIdA = await accountIdByCode(orgA, '6120');
    await pool.query(
      'INSERT INTO ap_flow_vendor_account_map (org_id, vendor_key, account_id) VALUES ($1, $2, $3)',
      [orgA, 'shared vendor', accountIdA],
    );

    const results = await classifyLineItems(orgB, {
      vendorName: 'Shared Vendor',
      lineItems: [{ description: 'Office Supplies', amountCents: 1000 }],
    });

    for (const r of results) {
      expect(r.mappingSource).not.toBe('HISTORY');
    }
  });

  it('saveLineItemsOnClient replaces prior rows', async () => {
    const { rows: docRows } = await pool.query<{ id: string }>(
      `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
       VALUES ($1, $2, 10, 'application/pdf', 'invoice.pdf', $3)
       RETURNING id`,
      [orgA, 'a'.repeat(64), userA.id],
    );
    const vaultDocId = docRows[0]?.id;
    if (vaultDocId === undefined) throw new Error('fixture: no vault document id');
    const { rows: apFlowRows } = await pool.query<{ id: string }>(
      `INSERT INTO ap_flow_documents (org_id, document_id, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [orgA, vaultDocId, userA.id],
    );
    const apFlowDocId = apFlowRows[0]?.id;
    if (apFlowDocId === undefined) throw new Error('fixture: no ap_flow_documents id');

    await withTransaction((client) =>
      saveLineItemsOnClient(client, orgA, apFlowDocId, [
        { lineIndex: 0, description: 'a', amountCents: 100, suggestedAccountId: null, mappingSource: 'NONE', mappingConfidence: null },
        { lineIndex: 1, description: 'b', amountCents: 200, suggestedAccountId: null, mappingSource: 'NONE', mappingConfidence: null },
        { lineIndex: 2, description: 'c', amountCents: 300, suggestedAccountId: null, mappingSource: 'NONE', mappingConfidence: null },
      ]),
    );
    const { rows: firstSave } = await pool.query('SELECT id FROM ap_flow_line_items WHERE org_id = $1', [orgA]);
    expect(firstSave).toHaveLength(3);

    await withTransaction((client) =>
      saveLineItemsOnClient(client, orgA, apFlowDocId, [
        { lineIndex: 0, description: 'x', amountCents: 100, suggestedAccountId: null, mappingSource: 'NONE', mappingConfidence: null },
        { lineIndex: 1, description: 'y', amountCents: 200, suggestedAccountId: null, mappingSource: 'NONE', mappingConfidence: null },
      ]),
    );
    const { rows: secondSave } = await pool.query('SELECT id FROM ap_flow_line_items WHERE org_id = $1', [orgA]);
    expect(secondSave).toHaveLength(2);
  });
});
