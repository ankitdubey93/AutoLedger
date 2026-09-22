import { describe, expect, it } from 'vitest';
import { requiredBy, toggleApp } from '../utils/appSelection';
import type { AppSummary } from '../services/fetchServices';

function app(slug: string, name: string, requires: string[] = []): AppSummary {
  return { slug, name, domain: 'd', tagline: 't', skills: [], status: 'building', requires };
}

const apps = [app('ledger-core', 'LedgerCore'), app('ap-flow', 'AP-Flow', ['ledger-core']), app('taxguard', 'TaxGuard AI')];

describe('toggleApp', () => {
  it('ticking an app also ticks what it requires', () => {
    expect(toggleApp(apps, new Set(), 'ap-flow')).toEqual(new Set(['ap-flow', 'ledger-core']));
  });

  it('unticking an app leaves its requirement selected', () => {
    expect(toggleApp(apps, new Set(['ap-flow', 'ledger-core']), 'ap-flow')).toEqual(new Set(['ledger-core']));
  });

  it('unticking a required app while its dependent is selected does nothing', () => {
    expect(toggleApp(apps, new Set(['ap-flow', 'ledger-core']), 'ledger-core')).toEqual(
      new Set(['ap-flow', 'ledger-core']),
    );
  });
});

describe('requiredBy', () => {
  it('names the selected apps that need a slug', () => {
    expect(requiredBy(apps, new Set(['ap-flow', 'ledger-core']), 'ledger-core')).toEqual(['AP-Flow']);
  });
});
