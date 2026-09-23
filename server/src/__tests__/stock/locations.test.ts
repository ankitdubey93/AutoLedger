import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * StockLedger (Phase 28) — the location hierarchy. Integration tier, real
 * PostgreSQL. Includes this module's cross-tenant isolation suite (rule 15).
 */

const app = createApp();
const LOCATIONS = '/api/v1/stock/locations';

let userA: SeededUser;
let userB: SeededUser;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
});

afterAll(closePool);

describe('POST /stock/locations', () => {
  it('builds MAIN / A / A-01 with paths', async () => {
    const agent = await loginAgent(app, userA);

    const main = await agent.post(LOCATIONS).send({ code: 'MAIN', name: 'Main warehouse', kind: 'WAREHOUSE' });
    expect(main.status).toBe(201);

    const zoneA = await agent
      .post(LOCATIONS)
      .send({ code: 'A', name: 'Zone A', kind: 'ZONE', parentId: main.body.location.id });
    expect(zoneA.status).toBe(201);
    expect(zoneA.body.location.path).toBe('MAIN / A');

    const binA01 = await agent
      .post(LOCATIONS)
      .send({ code: 'A-01', name: 'Bin A-01', kind: 'BIN', parentId: zoneA.body.location.id });
    expect(binA01.status).toBe(201);
    expect(binA01.body.location.path).toBe('MAIN / A / A-01');
    expect(binA01.body.location.depth).toBe(3);
  });

  it('ZONE without parent → 422 exact message', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(LOCATIONS).send({ code: 'A', name: 'Zone A', kind: 'ZONE' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(
      'A WAREHOUSE, STORE or SITE must be top-level; a ZONE or BIN must sit inside another location',
    );
  });

  it('WAREHOUSE with parent → 422', async () => {
    const agent = await loginAgent(app, userA);
    const main = await agent.post(LOCATIONS).send({ code: 'MAIN', name: 'Main', kind: 'WAREHOUSE' });

    const res = await agent
      .post(LOCATIONS)
      .send({ code: 'MAIN2', name: 'Main 2', kind: 'WAREHOUSE', parentId: main.body.location.id });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(
      'A WAREHOUSE, STORE or SITE must be top-level; a ZONE or BIN must sit inside another location',
    );
  });

  it('5th level → 422', async () => {
    const agent = await loginAgent(app, userA);

    async function makeLocation(code: string, kind: string, parentId: string | null) {
      const res = await agent.post(LOCATIONS).send({ code, name: code, kind, parentId });
      expect(res.status).toBe(201);
      return res.body.location.id as string;
    }

    const l1 = await makeLocation('L1', 'WAREHOUSE', null);
    const l2 = await makeLocation('L2', 'ZONE', l1);
    const l3 = await makeLocation('L3', 'BIN', l2);
    const l4 = await makeLocation('L4', 'BIN', l3);

    const res = await agent.post(LOCATIONS).send({ code: 'L5', name: 'L5', kind: 'BIN', parentId: l4 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Locations can be nested at most 4 levels deep');
  });

  it('duplicate code → 409', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(LOCATIONS).send({ code: 'MAIN', name: 'Main warehouse', kind: 'WAREHOUSE' });

    const res = await agent.post(LOCATIONS).send({ code: 'MAIN', name: 'Main warehouse again', kind: 'WAREHOUSE' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Location code already exists');
  });

  it('org B parent → 422', async () => {
    const agentB = await loginAgent(app, userB);
    const foreign = await agentB.post(LOCATIONS).send({ code: 'MAIN', name: 'Foreign main', kind: 'WAREHOUSE' });

    const agentA = await loginAgent(app, userA);
    const res = await agentA
      .post(LOCATIONS)
      .send({ code: 'A', name: 'Zone A', kind: 'ZONE', parentId: foreign.body.location.id });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Parent location does not exist in this organization');
  });
});

describe('GET /stock/locations', () => {
  it('shows only own org', async () => {
    const agentB = await loginAgent(app, userB);
    await agentB.post(LOCATIONS).send({ code: 'MAIN', name: 'Foreign main', kind: 'WAREHOUSE' });

    const agentA = await loginAgent(app, userA);
    await agentA.post(LOCATIONS).send({ code: 'MAIN', name: 'Own main', kind: 'WAREHOUSE' });

    const res = await agentA.get(LOCATIONS);
    expect(res.status).toBe(200);
    expect(res.body.locations).toHaveLength(1);
    expect(res.body.locations[0].name).toBe('Own main');
  });
});
