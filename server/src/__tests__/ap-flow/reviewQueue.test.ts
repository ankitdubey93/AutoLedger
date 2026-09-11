import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import {
  addMember,
  clearStorage,
  createUserWithOrg,
  loginAgent,
  resetTables,
} from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

const app = createApp();
const AP_FLOW_BASE = '/api/v1/ap-flow/documents';
const REVIEW_QUEUE = '/api/v1/ap-flow/review-queue';

async function switchTo(agent: Awaited<ReturnType<typeof loginAgent>>, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

describe('ap-flow review queue and line-item override API', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let orgA: string;
  let orgB: string;
  let userAccountant: SeededUser;
  let userViewer: SeededUser;

  beforeEach(async () => {
    await resetTables();
    await clearStorage();

    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;

    const carol = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
    orgB = carol.orgId;

    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bobs Own' });
    await addMember(orgA, userB.id, 'ADMIN');
    await addMember(orgB, userB.id, 'ADMIN');

    userAccountant = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann Solo' });
    await addMember(orgA, userAccountant.id, 'ACCOUNTANT');

    userViewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, userViewer.id, 'VIEWER');
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

  /**
   * Seeds a fully EXTRACTED ap_flow_document with an extraction and line
   * items, raw SQL — there is no worker in this test process, so an
   * EXTRACTED document is built directly rather than through the pipeline.
   */
  async function seedExtractedDocument(
    orgId: string,
    createdBy: string,
    options: {
      arithmeticOk?: boolean;
      lowestConfidence?: number;
      lineItemAccountId?: string | null;
    } = {},
  ): Promise<string> {
    const { rows: docRows } = await pool.query<{ id: string }>(
      `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
       VALUES ($1, $2, 10, 'application/pdf', 'invoice.pdf', $3)
       RETURNING id`,
      [orgId, Math.random().toString(16).slice(2).padEnd(64, '0'), createdBy],
    );
    const vaultDocId = docRows[0]?.id;
    if (vaultDocId === undefined) throw new Error('fixture: no vault document id');

    const { rows: apFlowRows } = await pool.query<{ id: string }>(
      `INSERT INTO ap_flow_documents (org_id, document_id, created_by, status, page_count, processed_at)
       VALUES ($1, $2, $3, 'EXTRACTED', 1, now())
       RETURNING id`,
      [orgId, vaultDocId, createdBy],
    );
    const apFlowDocId = apFlowRows[0]?.id;
    if (apFlowDocId === undefined) throw new Error('fixture: no ap_flow_documents id');

    const fieldConfidence =
      options.lowestConfidence === undefined ? {} : { total: options.lowestConfidence };

    await pool.query(
      `INSERT INTO ap_flow_extractions
         (org_id, ap_flow_document_id, vendor_name, invoice_number, invoice_date, currency,
          subtotal_cents, tax_cents, total_cents, arithmetic_ok, model, field_confidence)
       VALUES ($1, $2, 'Acme Vendor', 'INV-1', '2026-08-01', 'USD', 1000, 0, 1000, $3, 'claude-sonnet-5', $4::jsonb)`,
      [orgId, apFlowDocId, options.arithmeticOk ?? true, JSON.stringify(fieldConfidence)],
    );

    const accountId =
      options.lineItemAccountId === undefined ? await accountIdByCode(orgId, '6130') : options.lineItemAccountId;
    await pool.query(
      `INSERT INTO ap_flow_line_items (org_id, ap_flow_document_id, line_index, description, amount_cents, account_id)
       VALUES ($1, $2, 0, 'Office Supplies', 1000, $3)`,
      [orgId, apFlowDocId, accountId],
    );

    return apFlowDocId;
  }

  // ------------------------------------------------------------ review queue

  it('returns only EXTRACTED documents', async () => {
    await seedExtractedDocument(orgA, userA.id);
    // A PENDING document (via the ordinary registration path).
    const { rows: docRows } = await pool.query<{ id: string }>(
      `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
       VALUES ($1, $2, 10, 'application/pdf', 'pending.pdf', $3) RETURNING id`,
      [orgA, 'b'.repeat(64), userA.id],
    );
    await pool.query('INSERT INTO ap_flow_documents (org_id, document_id, created_by) VALUES ($1, $2, $3)', [
      orgA,
      docRows[0]?.id,
      userA.id,
    ]);
    // A FAILED document.
    const { rows: failedDocRows } = await pool.query<{ id: string }>(
      `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
       VALUES ($1, $2, 10, 'application/pdf', 'failed.pdf', $3) RETURNING id`,
      [orgA, 'c'.repeat(64), userA.id],
    );
    await pool.query(
      `INSERT INTO ap_flow_documents (org_id, document_id, created_by, status, failure_reason)
       VALUES ($1, $2, $3, 'FAILED', 'boom')`,
      [orgA, failedDocRows[0]?.id, userA.id],
    );

    const agent = await loginAgent(app, userA);
    const res = await agent.get(REVIEW_QUEUE);

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
  });

  it('puts an arithmetic failure first', async () => {
    await seedExtractedDocument(orgA, userA.id, { arithmeticOk: true, lowestConfidence: 0.5 });
    const badId = await seedExtractedDocument(orgA, userA.id, { arithmeticOk: false });

    const agent = await loginAgent(app, userA);
    const res = await agent.get(REVIEW_QUEUE);

    expect(res.status).toBe(200);
    expect(res.body.entries[0]?.id).toBe(badId);
  });

  it('orders lower confidence before higher', async () => {
    await seedExtractedDocument(orgA, userA.id, { lowestConfidence: 0.88 });
    const lowConfId = await seedExtractedDocument(orgA, userA.id, { lowestConfidence: 0.31 });

    const agent = await loginAgent(app, userA);
    const res = await agent.get(REVIEW_QUEUE);

    expect(res.status).toBe(200);
    expect(res.body.entries[0]?.id).toBe(lowConfId);
  });

  it('never shows another organization\'s documents', async () => {
    await seedExtractedDocument(orgB, userB.id);

    const agent = await loginAgent(app, userA);
    const res = await agent.get(REVIEW_QUEUE);

    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(0);
    expect(res.body.entries).toEqual([]);
  });

  it('is open to a VIEWER', async () => {
    await seedExtractedDocument(orgA, userA.id);
    const agent = await loginAgent(app, userViewer);
    await switchTo(agent, orgA);

    const res = await agent.get(REVIEW_QUEUE);
    expect(res.status).toBe(200);
  });

  // --------------------------------------------------------- line-item PATCH

  it('sets the account and marks the source MANUAL', async () => {
    const docId = await seedExtractedDocument(orgA, userA.id);
    const newAccountId = await accountIdByCode(orgA, '6140');

    const agent = await loginAgent(app, userA);
    const getRes = await agent.get(`${AP_FLOW_BASE}/${docId}`);
    const lineItemId = getRes.body.document.lineItems[0].id as string;

    const res = await agent
      .patch(`${AP_FLOW_BASE}/${docId}/line-items/${lineItemId}`)
      .send({ accountId: newAccountId });

    expect(res.status).toBe(200);
    const updated = res.body.document.lineItems[0];
    expect(updated.accountId).toBe(newAccountId);
    expect(updated.mappingSource).toBe('MANUAL');
  });

  it('rejects a header account with 422', async () => {
    const docId = await seedExtractedDocument(orgA, userA.id);
    // 1000 Assets is a header account in the default chart (not postable).
    const headerAccountId = await accountIdByCode(orgA, '1000');

    const agent = await loginAgent(app, userA);
    const getRes = await agent.get(`${AP_FLOW_BASE}/${docId}`);
    const lineItemId = getRes.body.document.lineItems[0].id as string;

    const res = await agent
      .patch(`${AP_FLOW_BASE}/${docId}/line-items/${lineItemId}`)
      .send({ accountId: headerAccountId });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('header');
  });

  it("rejects an account from another organization with 404", async () => {
    const docId = await seedExtractedDocument(orgA, userA.id);
    const otherOrgAccountId = await accountIdByCode(orgB, '6130');

    const agent = await loginAgent(app, userA);
    const getRes = await agent.get(`${AP_FLOW_BASE}/${docId}`);
    const lineItemId = getRes.body.document.lineItems[0].id as string;

    const res = await agent
      .patch(`${AP_FLOW_BASE}/${docId}/line-items/${lineItemId}`)
      .send({ accountId: otherOrgAccountId });

    expect(res.status).toBe(404);
  });

  it('rejects a line item belonging to another document with 404', async () => {
    const docId = await seedExtractedDocument(orgA, userA.id);
    const otherDocId = await seedExtractedDocument(orgA, userA.id);
    const newAccountId = await accountIdByCode(orgA, '6140');

    const agent = await loginAgent(app, userA);
    const otherDoc = await agent.get(`${AP_FLOW_BASE}/${otherDocId}`);
    const otherLineItemId = otherDoc.body.document.lineItems[0].id as string;

    const res = await agent
      .patch(`${AP_FLOW_BASE}/${docId}/line-items/${otherLineItemId}`)
      .send({ accountId: newAccountId });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Line item not found');
  });

  it("returns 404 for another organization's document", async () => {
    const docId = await seedExtractedDocument(orgB, userB.id);
    const newAccountId = await accountIdByCode(orgA, '6140');

    const agent = await loginAgent(app, userA);
    // Fabricate a line item id shape — org A has no visibility into org B's
    // document at all, so this must 404 before even looking at line items.
    const res = await agent
      .patch(`${AP_FLOW_BASE}/${docId}/line-items/00000000-0000-0000-0000-000000000000`)
      .send({ accountId: newAccountId });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('AP-Flow document not found');
  });

  it('is refused for a VIEWER with 403', async () => {
    const docId = await seedExtractedDocument(orgA, userA.id);
    const newAccountId = await accountIdByCode(orgA, '6140');

    const agent = await loginAgent(app, userViewer);
    await switchTo(agent, orgA);
    const getAsA = await loginAgent(app, userA);
    const getRes = await getAsA.get(`${AP_FLOW_BASE}/${docId}`);
    const lineItemId = getRes.body.document.lineItems[0].id as string;

    const res = await agent
      .patch(`${AP_FLOW_BASE}/${docId}/line-items/${lineItemId}`)
      .send({ accountId: newAccountId });

    expect(res.status).toBe(403);
  });

  it('rejects a non-UUID accountId with 400', async () => {
    const docId = await seedExtractedDocument(orgA, userA.id);

    const agent = await loginAgent(app, userA);
    const getRes = await agent.get(`${AP_FLOW_BASE}/${docId}`);
    const lineItemId = getRes.body.document.lineItems[0].id as string;

    const res = await agent
      .patch(`${AP_FLOW_BASE}/${docId}/line-items/${lineItemId}`)
      .send({ accountId: 'not-a-uuid' });

    expect(res.status).toBe(400);
  });
});
