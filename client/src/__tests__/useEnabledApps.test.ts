import { describe, expect, it } from 'vitest';
import { resolveActiveApp, type EnabledAppsState } from '../apps/useEnabledApps';
import type { OrganizationAppEntry } from '../services/fetchServices';

function app(slug: string): OrganizationAppEntry {
  return {
    slug,
    name: slug,
    domain: 'x',
    tagline: 'y',
    skills: [],
    status: 'building',
    requires: [],
    enabled: true,
    enabledAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('resolveActiveApp', () => {
  it('is loading while the enabled-apps fetch is in flight', () => {
    const state: EnabledAppsState = { status: 'loading' };
    expect(resolveActiveApp(state, 'ledger-core')).toEqual({ status: 'loading' });
  });

  it('treats a fetch error as not-found rather than throwing', () => {
    const state: EnabledAppsState = { status: 'error', message: 'boom' };
    expect(resolveActiveApp(state, 'ledger-core')).toEqual({ status: 'not-found' });
  });

  it('finds the app matching the slug once ready', () => {
    const state: EnabledAppsState = { status: 'ready', apps: [app('ledger-core'), app('stock')] };
    expect(resolveActiveApp(state, 'stock')).toEqual({ status: 'found', app: app('stock') });
  });

  it('is not-found for a slug the organization has not enabled', () => {
    const state: EnabledAppsState = { status: 'ready', apps: [app('ledger-core')] };
    expect(resolveActiveApp(state, 'stock')).toEqual({ status: 'not-found' });
  });

  it('is not-found when the slug param is undefined', () => {
    const state: EnabledAppsState = { status: 'ready', apps: [app('ledger-core')] };
    expect(resolveActiveApp(state, undefined)).toEqual({ status: 'not-found' });
  });
});
