import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { SYSTEM_ACCOUNT_ROLES, type SystemAccountRole } from '../../config/systemAccounts.js';
import * as depositService from '../../services/accounting/depositService.js';
import * as invoiceService from '../../services/accounting/invoiceService.js';
import * as paymentService from '../../services/accounting/paymentService.js';
import * as settingsService from '../../services/accounting/settingsService.js';
import {
  resolveSystemAccountsOnClient,
  rolesForAccountsOnClient,
} from '../../services/accounting/systemAccountService.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 46a — system accounts. Integration tier, real PostgreSQL. The parity
 * block proves the derived registry names the same account every posting
 * resolver would use.
 */

const app = createApp();

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

type Agent = Awaited<ReturnType<typeof loginAgent>>;

async function onboard(agent: Agent, name: string): Promise<void> {
  const res = await agent.post('/api/v1/settings/onboarding').send({
    organizationName: name,
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
  });
  if (res.status !== 200) throw new Error(`fixture: onboarding failed ${res.status}`);
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
});

afterAll(async () => {
  await closePool();
});

describe('system account resolution', () => {
  it('fresh org resolves every role to its default code', async () => {
    const resolved = await resolveSystemAccountsOnClient(pool, orgA);
    for (const def of SYSTEM_ACCOUNT_ROLES) {
      expect(resolved.get(def.role)?.code, def.role).toBe(def.defaultCode);
    }
  });

  it('the registry agrees with every posting resolver (default chart)', async () => {
    await withTransaction(async (client) => {
      const reg = await resolveSystemAccountsOnClient(client, orgA);
      const id = (role: SystemAccountRole): string | undefined => reg.get(role)?.accountId;

      const ar = await invoiceService.resolvePostingAccounts(client, orgA, true);
      expect(ar.receivableAccountId).toBe(id('RECEIVABLE'));
      expect(ar.taxAccountId).toBe(id('TAX_OUTPUT'));

      const ap = await settingsService.resolveApPostingAccountsOnClient(client, orgA, true);
      expect(ap.payableAccountId).toBe(id('PAYABLE'));
      expect(ap.taxAccountId).toBe(id('TAX_INPUT'));

      const inv = await settingsService.resolveInventoryPostingAccountsOnClient(client, orgA);
      expect(inv.inventoryAccountId).toBe(id('INVENTORY'));
      expect(inv.cogsAccountId).toBe(id('COGS'));
      expect(inv.adjustmentAccountId).toBe(id('INVENTORY_ADJUSTMENT'));
      expect(inv.openingAccountId).toBe(id('STOCK_OPENING'));

      expect((await paymentService.resolveControlAccount(client, orgA, 'RECEIVE')).id).toBe(id('RECEIVABLE'));
      expect((await paymentService.resolveControlAccount(client, orgA, 'PAY')).id).toBe(id('PAYABLE'));

      expect((await depositService.resolveDepositAccountsOnClient(client, orgA, 'SALES')).depositAccountId).toBe(
        id('CUSTOMER_DEPOSITS'),
      );
      expect((await depositService.resolveDepositAccountsOnClient(client, orgA, 'PURCHASE')).depositAccountId).toBe(
        id('SUPPLIER_PREPAYMENTS'),
      );
    });
  });

  it('…and after remapping', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent, 'Org Alpha');
    const asset = await agent.post('/api/v1/accounts').send({ code: '1125', name: 'Debtors', type: 'Asset' });
    expect(asset.status).toBe(201);
    const expense = await agent.post('/api/v1/accounts').send({ code: '6825', name: 'FX Reval', type: 'Expense' });
    expect(expense.status).toBe(201);
    const newAr = asset.body.account.id as string;
    const newFx = expense.body.account.id as string;

    const inv = await agent.patch('/api/v1/settings/invoicing').send({ receivableAccountId: newAr });
    expect(inv.status).toBe(200);
    const set = await agent.patch('/api/v1/settings').send({ unrealizedFxAccountId: newFx });
    expect(set.status).toBe(200);

    const resolved = await resolveSystemAccountsOnClient(pool, orgA);
    expect(resolved.get('RECEIVABLE')?.accountId).toBe(newAr);
    expect(resolved.get('UNREALIZED_FX')?.accountId).toBe(newFx);
    const roles = await rolesForAccountsOnClient(pool, orgA);
    expect(roles.has(await accountId(orgA, '1120'))).toBe(false);

    await withTransaction(async (client) => {
      expect((await paymentService.resolveControlAccount(client, orgA, 'RECEIVE')).id).toBe(newAr);
    });
  });

  it('cross-tenant: never returns an account id belonging to another org', async () => {
    const resolved = await resolveSystemAccountsOnClient(pool, orgB);
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1', [orgA]);
    const orgAIds = new Set(rows.map((r) => r.id));
    for (const account of resolved.values()) {
      if (account !== null) expect(orgAIds.has(account.accountId)).toBe(false);
    }
    expect(resolved.get('RECEIVABLE')?.accountId).toBe(await accountId(orgB, '1120'));
  });

  it('OPENING_BALANCE and STOCK_OPENING share 3400', async () => {
    const roles = await rolesForAccountsOnClient(pool, orgA);
    const held = roles.get(await accountId(orgA, '3400'));
    expect(held?.map((r) => r.role)).toEqual(['OPENING_BALANCE', 'STOCK_OPENING']);
  });
});

describe('system account locks', () => {
  const BASE = '/api/v1/accounts';

  it('refuses to retire Accounts Receivable', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(`${BASE}/${await accountId(orgA, '1120')}`).send({ isActive: false });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Accounts Receivable is a system account and cannot be retired');
  });

  it('names every role an account holds', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(`${BASE}/${await accountId(orgA, '3400')}`).send({ isActive: false });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(
      'Historical adjustment and Opening stock is a system account and cannot be retired',
    );
  });

  it('refuses to flag a system account as a bank account', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(`${BASE}/${await accountId(orgA, '1140')}`).send({ bankAccountKind: 'BANK' });
    expect(res.status).toBe(422);
  });

  it('allows renaming a system account and returns its roles', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(`${BASE}/${await accountId(orgA, '1120')}`).send({ name: 'Debtors' });
    expect(res.status).toBe(200);
    expect(res.body.account.systemRoles[0].role).toBe('RECEIVABLE');
  });

  it('allows retiring the old account once the role is remapped', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent, 'Org Alpha');
    const created = await agent.post(BASE).send({ code: '1125', name: 'Debtors', type: 'Asset' });
    expect(created.status).toBe(201);
    const remap = await agent
      .patch('/api/v1/settings/invoicing')
      .send({ receivableAccountId: created.body.account.id });
    expect(remap.status).toBe(200);
    const res = await agent.patch(`${BASE}/${await accountId(orgA, '1120')}`).send({ isActive: false });
    expect(res.status).toBe(200);
  });

  it('refuses a setting that points at a retired account', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent, 'Org Alpha');
    const id = await accountId(orgA, '6100');
    const retired = await agent.patch(`${BASE}/${id}`).send({ isActive: false });
    expect(retired.status).toBe(200);
    const res = await agent.patch('/api/v1/settings').send({ realizedFxLossAccountId: id });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Account 6100 is retired — activate it before using it here');
  });

  it('GET /accounts carries systemRoles on every row', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(BASE);
    expect(res.status).toBe(200);
    const accounts = res.body.accounts as { code: string; systemRoles: { role: string; label: string }[] }[];
    expect(accounts.every((a) => Array.isArray(a.systemRoles))).toBe(true);
    expect(accounts.find((a) => a.code === '6830')?.systemRoles).toEqual([{ role: 'ROUNDING', label: 'Rounding' }]);
    expect(accounts.find((a) => a.code === '6100')?.systemRoles).toEqual([]);
  });

  it('cross-tenant: another org account is a 404', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(`${BASE}/${await accountId(orgB, '1120')}`).send({ isActive: false });
    expect(res.status).toBe(404);
  });
});

describe('system account listing (GET /accounts/system)', () => {
  it('lists one view per role, with ROUNDING on 6830 and not remappable', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent, 'Org Alpha');
    const res = await agent.get('/api/v1/accounts/system');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(16);
    const rounding = (res.body.systemAccounts as { role: string; code: string | null; remappable: boolean }[])
      .find((row) => row.role === 'ROUNDING');
    expect(rounding?.code).toBe('6830');
    expect(rounding?.remappable).toBe(false);
  });
});
