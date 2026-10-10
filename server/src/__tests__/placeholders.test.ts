import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  containsPlaceholders,
  fillPlaceholders,
  formatPlaceholderDate,
  placeholdersFor,
  unknownLegacyPlaceholders,
  type FillMode,
  type PlaceholderContext,
  type PlaceholderSurface,
} from '../utils/placeholders.js';

/**
 * Phase 40 — the placeholder engine, pure. The shared fixture is run by the
 * client's mirror too (client/src/__tests__/placeholders.test.ts), so the two
 * engines cannot drift apart.
 */

interface Case {
  name: string;
  surface: PlaceholderSurface;
  text: string;
  ctx: PlaceholderContext;
  mode?: FillMode;
  expected: string;
}

// One copy, in the client package: Vite refuses to import files from outside
// its root, while node `fs` reads across the repo freely.
const fixture = JSON.parse(
  readFileSync(new URL('../../../client/src/__tests__/fixtures/placeholderCases.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

describe('fillPlaceholders — shared fixture', () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(fillPlaceholders(c.text, c.surface, c.ctx, c.mode)).toBe(c.expected);
  });
});

describe('fillPlaceholders', () => {
  it('defaults to final mode', () => {
    expect(fillPlaceholders('[Invoice Number]', 'INVOICE', { date: '2026-10-10' })).toBe('');
  });
});

describe('containsPlaceholders', () => {
  it('is true only for a placeholder the surface would fill', () => {
    expect(containsPlaceholders('RENT-[Month]', 'BILL')).toBe(true);
    expect(containsPlaceholders('RENT [draft]', 'BILL')).toBe(false);
    expect(containsPlaceholders('[Invoice Number]', 'BILL')).toBe(false);
    expect(containsPlaceholders('{{contact_name}}', 'BILL')).toBe(false);
    expect(containsPlaceholders('{{contact_name}}', 'STATEMENT')).toBe(true);
    expect(containsPlaceholders('[Day+1000]', 'BILL')).toBe(false);
    expect(containsPlaceholders('RENT-[[Month]]', 'BILL')).toBe(false);
  });
});

describe('unknownLegacyPlaceholders', () => {
  it('reports unknown double-brace names once each, ignoring brackets', () => {
    expect(unknownLegacyPlaceholders('{{nope}} {{balance_due}} {{nope}} {{x_y}} [Whatever]')).toEqual(['nope', 'x_y']);
  });
});

describe('placeholdersFor', () => {
  it('offers statement amounts only on statements', () => {
    expect(placeholdersFor('INVOICE').map((d) => d.label)).not.toContain('Balance Due');
    expect(placeholdersFor('STATEMENT').map((d) => d.label)).toContain('Balance Due');
    expect(placeholdersFor('JOURNAL').map((d) => d.label)).not.toContain('Contact Name');
  });
});

describe('formatPlaceholderDate', () => {
  it('formats without Intl', () => {
    expect(formatPlaceholderDate('2026-01-01')).toBe('1 Jan 2026');
    expect(() => formatPlaceholderDate('01/01/2026')).toThrow();
  });
});
