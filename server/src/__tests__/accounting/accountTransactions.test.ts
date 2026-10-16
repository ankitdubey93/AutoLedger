import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, issueInvoice, receivePayment } from '../helpers/accountingFixtures.js';
import type { Agent } from '../helpers/accountingFixtures.js';

/**
 * Phase 45 — account transactions report. Integration tier, real PostgreSQL.
 *
 * Org Alpha: customer Acme; invoice A 100.00 (2026-08-20, before the window),
 * invoice B 250.00 (2026-09-05) and a 250.00 payment against B (2026-09-12).
 * Org Bravo holds nothing and must never see any of it.
 */

const app = createApp();
const URL_ = '/api/v1/reports/account-transactions';
const WINDOW = 'from=2026-09-01&to=2026-09-30';

let userA: SeededUser;
let agentA: Agent;
let agentB: Agent;
let orgA: string;
let invoiceBNumber: string;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  const userB = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  orgA = userA.orgId;
  const customerId = await createCustomer(agentA, 'Acme');
  await issueInvoice(agentA, orgA, customerId, 10000, '2026-08-20', '2026-09-20');
  const b = await issueInvoice(agentA, orgA, customerId, 25000, '2026-09-05', '2026-10-05');
  invoiceBNumber = b.number;
  await receivePayment(agentA, orgA, customerId, '2026-09-12', [{ invoiceId: b.id, amountCents: 25000 }]);
});

afterAll(closePool);

describe('account transactions report', () => {
  it('groups by account with opening and running balance', async () => {
    const ar = await accountId(orgA, '1120');
    const res = await agentA.get(`${URL_}?accountIds=${ar}&${WINDOW}`);
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    const group = res.body.groups[0];
    expect(group.openingBalanceCents).toBe(10000);
    expect(group.closingBalanceCents).toBe(10000);
    expect(group.lines.map((l: { debitCents: number; creditCents: number }) => [l.debitCents, l.creditCents])).toEqual([
      [25000, 0],
      [0, 25000],
    ]);
    expect(group.lines.map((l: { runningBalanceCents: number }) => l.runningBalanceCents)).toEqual([35000, 10000]);
    expect(group.lines[0].contactName).toBe('Acme');
    expect(group.lines[0].reference).toBe(invoiceBNumber);
    expect(group.lines[0].sourceLabel).toBe('Invoice');
  });

  it('all accounts', async () => {
    const res = await agentA.get(`${URL_}?${WINDOW}`);
    expect(res.status).toBe(200);
    expect(res.body.groups.map((g: { label: string }) => g.label.split(' ')[0])).toEqual(['1110', '1120', '4100']);
    expect(res.body.totalDebitCents).toBe(res.body.totalCreditCents);
  });

  it('group by contact', async () => {
    const res = await agentA.get(`${URL_}?${WINDOW}&groupBy=contact`);
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].label).toBe('Acme');
    expect(res.body.groups[0].lines).toHaveLength(4);
  });

  it('group by month', async () => {
    const res = await agentA.get(`${URL_}?from=2026-08-01&to=2026-09-30&groupBy=month`);
    expect(res.status).toBe(200);
    expect(res.body.groups.map((g: { key: string }) => g.key)).toEqual(['2026-08', '2026-09']);
    expect(res.body.groups.map((g: { label: string }) => g.label)).toEqual(['August 2026', 'September 2026']);
  });

  it('summary mode', async () => {
    const res = await agentA.get(`${URL_}?${WINDOW}&groupBy=sourceType&mode=summary`);
    expect(res.status).toBe(200);
    const groups = res.body.groups as {
      label: string;
      debitCents: number;
      creditCents: number;
      lineCount: number;
      lines: unknown[];
    }[];
    const invoice = groups.find((g) => g.label === 'Invoice');
    expect(invoice).toBeDefined();
    expect(invoice?.debitCents).toBe(25000);
    expect(invoice?.creditCents).toBe(25000);
    expect(invoice?.lineCount).toBe(2);
    expect(groups.some((g) => g.label === 'Payment')).toBe(true);
    for (const g of groups) expect(g.lines).toEqual([]);
  });

  it('source filter drops running balance', async () => {
    const cash = await accountId(orgA, '1110');
    const res = await agentA.get(`${URL_}?accountIds=${cash}&${WINDOW}&sourceTypes=payment`);
    expect(res.status).toBe(200);
    const group = res.body.groups[0];
    expect(group.openingBalanceCents).toBeNull();
    expect(group.lines.length).toBeGreaterThan(0);
    for (const l of group.lines) expect(l.runningBalanceCents).toBeNull();
  });

  it('header account refused', async () => {
    const header = await accountId(orgA, '1000');
    const res = await agentA.get(`${URL_}?accountIds=${header}&${WINDOW}`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Account 1000 is a header account and has no transactions of its own');
  });

  it('validation', async () => {
    const missing = await agentA.get(`${URL_}?from=2026-09-01`);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('from and to are required');
    const badGroup = await agentA.get(`${URL_}?${WINDOW}&groupBy=x`);
    expect(badGroup.status).toBe(400);
    const badColumn = await agentA.get(`${URL_}?${WINDOW}&columns=foo`);
    expect(badColumn.status).toBe(400);
    expect(badColumn.body.error).toBe('Unknown column "foo"');
  });

  it('export honours columns', async () => {
    const res = await agentA.get(`${URL_}?${WINDOW}&format=csv&columns=date,debit`);
    expect(res.status).toBe(200);
    const firstLine = res.text.replace(/^﻿/, '').split('\r\n')[0];
    expect(firstLine).toBe('Date,Debit');
  });

  it('cross-tenant', async () => {
    const ar = await accountId(orgA, '1120');
    const res = await agentB.get(`${URL_}?accountIds=${ar}&${WINDOW}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Account not found');
    const all = await agentB.get(`${URL_}?${WINDOW}`);
    expect(all.status).toBe(200);
    expect(all.body.groups).toEqual([]);
  });
});
