import request from 'supertest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { APPS, isAppSlug } from '../../config/apps.js';
import type { AppDefinition } from '../../types/apps.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';

/**
 * Integration tier for GET /api/v1/apps — the platform's app registry.
 * docs/testing.md: real Postgres, real cookie-authenticated request.
 */
describe('GET /api/v1/apps', () => {
  const app = createApp();

  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closePool();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/apps');
    expect(res.status).toBe(401);
  });

  it('returns exactly eight apps with unique kebab-case slugs', async () => {
    const user = await createUserWithOrg();
    const agent = await loginAgent(app, user);

    const res = await agent.get('/api/v1/apps');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(8);
    expect(res.body.apps).toHaveLength(8);

    const slugs = res.body.apps.map((a: { slug: string }) => a.slug);
    expect(new Set(slugs).size).toBe(8);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  it('exposes only the fields the registry defines', async () => {
    const user = await createUserWithOrg();
    const agent = await loginAgent(app, user);

    const res = await agent.get('/api/v1/apps');
    const first = res.body.apps[0];

    expect(Object.keys(first).sort()).toEqual(
      ['domain', 'name', 'requires', 'skills', 'slug', 'status', 'tagline'].sort(),
    );
    expect(['building', 'planned']).toContain(first.status);
  });
});

describe('isAppSlug', () => {
  it('accepts every slug in the registry and rejects an unknown one', () => {
    for (const app of APPS) {
      expect(isAppSlug(app.slug)).toBe(true);
    }
    expect(isAppSlug('not-a-real-app')).toBe(false);
  });

  it('every requires entry is a known slug and never the app itself', () => {
    // Widened to AppDefinition the same way config/apps.ts's own helpers do:
    // under `as const`, an empty `requires` is the tuple `readonly []`.
    for (const app of APPS as readonly AppDefinition[]) {
      for (const req of app.requires) {
        expect(isAppSlug(req)).toBe(true);
        expect(req).not.toBe(app.slug);
      }
    }
  });
});
