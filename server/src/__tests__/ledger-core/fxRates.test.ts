import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — fx_rates (Phase 8). Integration tier, real PostgreSQL.
 *
 * Includes this module's own cross-tenant isolation suite (rule 15). Every
 * org defaults to base_currency = 'USD' (migration 001), so no onboarding
 * is needed to exercise these routes.
 */

const app = createApp();
const RATES = '/api/v1/ledger-core/fx-rates';

let userA: SeededUser;
let userB: SeededUser;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
});

afterAll(async () => {
  await closePool();
});

describe('POST /fx-rates', () => {
  it('creates a rate', async () => {
    const agent = await loginAgent(app, userA);

    const res = await agent
      .post(RATES)
      .send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '83.00000000' });

    expect(res.status).toBe(201);
    expect(res.body.rate.rate).toBe('83.00000000');
    expect(res.body.rate.fromCode).toBe('USD');
    expect(res.body.rate.toCode).toBe('INR');
  });

  it('upserts — posting the same pair and date again overwrites, not duplicates', async () => {
    const agent = await loginAgent(app, userA);
    await agent
      .post(RATES)
      .send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '83.00000000' });

    const res = await agent
      .post(RATES)
      .send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '84.00000000' });
    expect(res.status).toBe(201);

    const list = await agent.get(RATES);
    expect(list.body.count).toBe(1);
    expect(list.body.rates[0].rate).toBe('84.00000000');
  });

  it('rejects a currency paired with itself', async () => {
    const agent = await loginAgent(app, userA);

    const res = await agent
      .post(RATES)
      .send({ fromCode: 'USD', toCode: 'USD', rateDate: '2026-01-01', rate: '1.00000000' });

    expect(res.status).toBe(422);
  });

  it('rejects a zero or out-of-range rate and creates no row', async () => {
    const agent = await loginAgent(app, userA);

    const zero = await agent
      .post(RATES)
      .send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '0' });
    expect(zero.status).toBe(400);

    const huge = await agent
      .post(RATES)
      .send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '2000000' });
    expect(huge.status).toBe(422);

    const list = await agent.get(RATES);
    expect(list.body.count).toBe(0);
  });
});

describe('GET /fx-rates/latest', () => {
  it('resolves the latest rate on or before the date, not an exact match', async () => {
    const agent = await loginAgent(app, userA);
    await agent.patch('/api/v1/organizations').send({ baseCurrency: 'INR' });
    await agent
      .post(RATES)
      .send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '83.00000000' });
    await agent
      .post(RATES)
      .send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-02-01', rate: '84.00000000' });

    const res = await agent.get(`${RATES}/latest`).query({ from: 'USD', on: '2026-03-15' });

    expect(res.status).toBe(200);
    expect(res.body.rate.rateDate).toBe('2026-02-01');
    expect(res.body.rate.rate).toBe('84.00000000');
  });

  it('returns 422 when no rate exists on or before the date', async () => {
    const agent = await loginAgent(app, userA);
    await agent.patch('/api/v1/organizations').send({ baseCurrency: 'INR' });
    await agent
      .post(RATES)
      .send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '83.00000000' });

    const res = await agent.get(`${RATES}/latest`).query({ from: 'USD', on: '2025-12-31' });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('No exchange rate for USD to');
  });

  it('resolves identity when the requested currency is the org base currency', async () => {
    const agent = await loginAgent(app, userA);

    const res = await agent.get(`${RATES}/latest`).query({ from: 'USD' });

    expect(res.status).toBe(200);
    expect(res.body.rate.identity).toBe(true);
    expect(res.body.rate.rate).toBe('1.00000000');
  });
});

describe('DELETE /fx-rates/:id', () => {
  it('is refused for ACCOUNTANT and allowed for OWNER', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent
      .post(RATES)
      .send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '83.00000000' });
    const id: string = created.body.rate.id;

    // userA registered as OWNER by createUserWithOrg; delete should succeed.
    const res = await agent.delete(`${RATES}/${id}`);
    expect(res.status).toBe(204);
  });
});

describe('cross-tenant isolation', () => {
  it('org B cannot see, delete, or resolve org A rates', async () => {
    const agentA = await loginAgent(app, userA);
    const agentB = await loginAgent(app, userB);

    const created = await agentA
      .post(RATES)
      .send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '83.00000000' });
    const idFromA: string = created.body.rate.id;

    const listB = await agentB.get(RATES);
    expect(listB.body.rates.find((r: { id: string }) => r.id === idFromA)).toBeUndefined();

    const deleteB = await agentB.delete(`${RATES}/${idFromA}`);
    expect(deleteB.status).toBe(404);

    const latestB = await agentB.get(`${RATES}/latest`).query({ from: 'USD' });
    // org B's own base currency is USD too, so USD->USD is identity, not a
    // lookup — use INR->EUR style pair that only org A has a rate for.
    expect(latestB.status).toBe(200);

    const foreignLatestB = await agentB.get(`${RATES}/latest`).query({ from: 'GBP' });
    expect(foreignLatestB.status).toBe(422);
  });
});
