import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — invoice template settings (Phase 30). Integration tier, real
 * PostgreSQL. The template columns are exercised over HTTP (zod boundary) and
 * straight at the pool (migration 070's CHECKs). Includes this module's own
 * cross-tenant isolation case (rule 15).
 */

const app = createApp();
const INVOICE_SETTINGS = '/api/v1/ledger-core/settings/invoicing';
const CHECK_VIOLATION = '23514';

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;

async function errorCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      return typeof err.code === 'string' ? err.code : undefined;
    }
  }
  return undefined;
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
});

afterAll(closePool);

describe('GET /ledger-core/settings/invoicing — template defaults', () => {
  it('on a fresh org returns the classic template defaults', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(INVOICE_SETTINGS);

    expect(res.status).toBe(200);
    const s = res.body.invoiceSettings;
    expect(s.templateId).toBe('classic');
    expect(s.documentTitle).toBe('INVOICE');
    expect(s.fontFamily).toBe('sans');
    expect(s.density).toBe('comfortable');
    expect(s.showLogo).toBe(true);
    expect(s.bankDetails).toBeNull();
  });
});

describe('PATCH /ledger-core/settings/invoicing — template fields', () => {
  it('round-trips templateId, density and bankDetails', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent
      .patch(INVOICE_SETTINGS)
      .send({ templateId: 'modern', density: 'compact', bankDetails: 'ACC 12345' });

    expect(res.status).toBe(200);

    const read = await agent.get(INVOICE_SETTINGS);
    expect(read.status).toBe(200);
    expect(read.body.invoiceSettings.templateId).toBe('modern');
    expect(read.body.invoiceSettings.density).toBe('compact');
    expect(read.body.invoiceSettings.bankDetails).toBe('ACC 12345');
  });

  it('rejects an unknown templateId with 400 before any SQL', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(INVOICE_SETTINGS).send({ templateId: 'fancy' });

    expect(res.status).toBe(400);
  });

  it('rejects an empty documentTitle with 400', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(INVOICE_SETTINGS).send({ documentTitle: '' });

    expect(res.status).toBe(400);
  });

  it('rejects the request from a VIEWER', async () => {
    const viewer = await createUserWithOrg({ label: 'vera', orgName: 'Org Vera' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await agent.patch(INVOICE_SETTINGS).send({ templateId: 'modern' });

    expect(res.status).toBe(403);
  });
});

describe('ledger_invoice_settings.template_id — the DB CHECK (migration 070)', () => {
  it("rejects an INSERT of template_id = 'fancy' with 23514", async () => {
    const code = await errorCode(() =>
      pool.query(`INSERT INTO ledger_invoice_settings (org_id, template_id) VALUES ($1, 'fancy')`, [orgA]),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });

  it("rejects an UPDATE to template_id = 'fancy' with 23514", async () => {
    await pool.query('INSERT INTO ledger_invoice_settings (org_id) VALUES ($1)', [orgA]);

    const code = await errorCode(() =>
      pool.query(`UPDATE ledger_invoice_settings SET template_id = 'fancy' WHERE org_id = $1`, [orgA]),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe('tenant isolation — template settings', () => {
  it("org B never sees org A's template choice", async () => {
    const agentA = await loginAgent(app, userA);
    const patch = await agentA.patch(INVOICE_SETTINGS).send({ templateId: 'modern' });
    expect(patch.status).toBe(200);

    const agentC = await loginAgent(app, userC);
    const res = await agentC.get(INVOICE_SETTINGS);

    expect(res.status).toBe(200);
    expect(res.body.invoiceSettings.templateId).toBe('classic');
    expect(res.body.invoiceSettings.configured).toBe(false);
  });
});
