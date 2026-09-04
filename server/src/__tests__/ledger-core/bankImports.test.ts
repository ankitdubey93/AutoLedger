import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — bank statement import (Phase 6). Integration tier, real
 * PostgreSQL. Includes this module's own cross-tenant isolation suite
 * (rule 15).
 */

const app = createApp();
const BANK_IMPORTS = '/api/v1/ledger-core/bank-imports';
const BANK_TRANSACTIONS = '/api/v1/ledger-core/bank-transactions';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;

type Agent = Awaited<ReturnType<typeof loginAgent>>;
let agentA: Agent;
let cashAccountId: string;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'bankimp-a', orgName: 'Bank Import Org A' });
  userB = await createUserWithOrg({ label: 'bankimp-b', orgName: 'Bank Import Org B' });
  orgA = userA.orgId;

  agentA = await loginAgent(app, userA);
  cashAccountId = await accountId(orgA, '1110');
});

afterAll(closePool);

describe('POST /bank-imports', () => {
  it('imports a clean ISO statement', async () => {
    const content = ['Date,Description,Amount', '2026-06-01,Payment received,100.00', '2026-06-02,Office supplies,-40.00', '2026-06-03,Bank fee,-5.00'].join(
      '\n',
    );

    const res = await agentA.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'statement.csv',
      content,
      dateFormat: 'ISO',
    });

    expect(res.status).toBe(201);
    expect(res.body.importedCount).toBe(3);

    const listRes = await agentA.get(`${BANK_TRANSACTIONS}?accountId=${cashAccountId}`);
    expect(listRes.body.count).toBe(3);
  });

  it('the same statement imported twice yields one set of rows', async () => {
    const content = ['Date,Description,Amount', '2026-06-01,A,10.00', '2026-06-02,B,20.00', '2026-06-03,C,30.00'].join('\n');
    const body = { accountId: cashAccountId, fileName: 'statement.csv', content, dateFormat: 'ISO' };

    const first = await agentA.post(BANK_IMPORTS).send(body);
    expect(first.status).toBe(201);
    expect(first.body.importedCount).toBe(3);

    const second = await agentA.post(BANK_IMPORTS).send(body);
    expect(second.status).toBe(201);
    expect(second.body.importedCount).toBe(0);
    expect(second.body.duplicateCount).toBe(3);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM bank_transactions WHERE org_id = $1',
      [orgA],
    );
    expect(rows[0]?.count).toBe('3');
  });

  it('two identical lines in one file both survive, and re-import still dedupes', async () => {
    const content = ['Date,Description,Amount', '2026-06-01,Test Payment,50.00', '2026-06-01,Test Payment,50.00'].join('\n');
    const body = { accountId: cashAccountId, fileName: 'statement.csv', content, dateFormat: 'ISO' };

    const first = await agentA.post(BANK_IMPORTS).send(body);
    expect(first.status).toBe(201);
    expect(first.body.importedCount).toBe(2);

    const second = await agentA.post(BANK_IMPORTS).send(body);
    expect(second.status).toBe(201);
    expect(second.body.importedCount).toBe(0);
    expect(second.body.duplicateCount).toBe(2);
  });

  it('parses a DMY statement with quoted commas and a BOM', async () => {
    const content = '﻿Date,Description,Amount\n09/03/2026,"Smith, John payment",75.00';

    const res = await agentA.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'statement.csv',
      content,
      dateFormat: 'DMY',
    });

    expect(res.status).toBe(201);
    expect(res.body.importedCount).toBe(1);

    const { rows } = await pool.query<{ txn_date: string; description: string }>(
      'SELECT txn_date, description FROM bank_transactions WHERE org_id = $1',
      [orgA],
    );
    expect(rows[0]?.txn_date).toBe('2026-03-09');
    expect(rows[0]?.description).toBe('Smith, John payment');
  });

  it('derives a signed amount from a debit/credit pair', async () => {
    const content = [
      'Date,Description,Debit,Credit',
      '2026-06-01,Deposit,,100.00',
      '2026-06-02,Withdrawal,40.00,',
    ].join('\n');

    const res = await agentA.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'statement.csv',
      content,
      dateFormat: 'ISO',
    });

    expect(res.status).toBe(201);
    expect(res.body.importedCount).toBe(2);

    const { rows } = await pool.query<{ description: string; amount_cents: string }>(
      'SELECT description, amount_cents FROM bank_transactions WHERE org_id = $1 ORDER BY txn_date ASC',
      [orgA],
    );
    expect(rows[0]?.amount_cents).toBe('10000');
    expect(rows[1]?.amount_cents).toBe('-4000');
  });

  it('rejects the whole file when one row has a bad date', async () => {
    const content = ['Date,Description,Amount', '2026-06-01,A,10.00', 'not-a-date,B,20.00'].join('\n');

    const res = await agentA.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'statement.csv',
      content,
      dateFormat: 'ISO',
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('row 3');

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM bank_transactions WHERE org_id = $1',
      [orgA],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('rejects a header account', async () => {
    const headerAccountId = await accountId(orgA, '1000');
    const content = 'Date,Description,Amount\n2026-06-01,A,10.00';

    const res = await agentA.post(BANK_IMPORTS).send({
      accountId: headerAccountId,
      fileName: 'statement.csv',
      content,
      dateFormat: 'ISO',
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('header account');
  });

  it('rejects a non-Asset account', async () => {
    const revenueAccountId = await accountId(orgA, '4100');
    const content = 'Date,Description,Amount\n2026-06-01,A,10.00';

    const res = await agentA.post(BANK_IMPORTS).send({
      accountId: revenueAccountId,
      fileName: 'statement.csv',
      content,
      dateFormat: 'ISO',
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('not an Asset account');
  });

  it('rejects a file with no recognisable date column', async () => {
    const content = 'Foo,Bar,Amount\nx,y,10.00';

    const res = await agentA.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'statement.csv',
      content,
      dateFormat: 'ISO',
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('date column');
  });

  it('rejects an ACCOUNTANT-less role', async () => {
    const viewer = await createUserWithOrg({ label: 'bankimp-viewer', orgName: 'unused' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const viewerAgent = await loginAgent(app, viewer);
    await viewerAgent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const content = 'Date,Description,Amount\n2026-06-01,A,10.00';
    const res = await viewerAgent.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'statement.csv',
      content,
      dateFormat: 'ISO',
    });

    expect(res.status).toBe(403);
  });
});

describe('cross-tenant isolation', () => {
  it("org B cannot read org A's import", async () => {
    const content = 'Date,Description,Amount\n2026-06-01,A,10.00';
    const created = await agentA.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'statement.csv',
      content,
      dateFormat: 'ISO',
    });
    const importId = created.body.import.id as string;

    const agentB = await loginAgent(app, userB);
    const res = await agentB.get(`${BANK_IMPORTS}/${importId}`);
    expect(res.status).toBe(404);
  });

  it("org B cannot import into org A's account", async () => {
    const agentB = await loginAgent(app, userB);
    const content = 'Date,Description,Amount\n2026-06-01,A,10.00';

    const res = await agentB.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'statement.csv',
      content,
      dateFormat: 'ISO',
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Bank account not found');
  });
});
