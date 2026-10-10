import { describe, expect, it } from 'vitest';
import fixtureText from './fixtures/placeholderCases.json?raw';
import {
  fillPlaceholders,
  hasLegacySyntax,
  nearMisses,
  upgradeLegacy,
  type FillMode,
  type PlaceholderContext,
  type PlaceholderSurface,
} from '../utils/placeholders';

/**
 * Phase 40 — the client's placeholder engine must agree with the server's on
 * every case of the one shared fixture. It lives here because Vite refuses
 * to load files outside the client package; the server suite reads this same
 * file with `fs` (server/src/__tests__/placeholders.test.ts).
 */

interface Case {
  name: string;
  surface: PlaceholderSurface;
  text: string;
  ctx: PlaceholderContext;
  mode?: FillMode;
  expected: string;
}

const fixture = JSON.parse(fixtureText) as { cases: Case[] };

describe('fillPlaceholders — parity with the server', () => {
  it('has cases', () => {
    expect(fixture.cases.length).toBeGreaterThan(20);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(fillPlaceholders(c.text, c.surface, c.ctx, c.mode)).toBe(c.expected);
  });
});

describe('nearMisses', () => {
  it('hints at likely typos, off-surface names and bad offsets — never at prose', () => {
    expect(nearMisses('[Mnth] [Contact Name] [Day+1] [draft] [x]', 'JOURNAL')).toEqual([
      '[Mnth] — did you mean [Month]?',
      '[Contact Name] — [Contact Name] is not available here',
    ]);
    expect(nearMisses('[Contact Name+1]', 'INVOICE')).toEqual(['[Contact Name+1] — [Contact Name] does not take an offset']);
    expect(nearMisses('[Month] [Year+1]', 'INVOICE')).toEqual([]);
    expect(nearMisses('[[Mnth]]', 'INVOICE')).toEqual([]);
  });
});

describe('upgradeLegacy', () => {
  it('rewrites known double-brace names to brackets and keeps unknown ones', () => {
    const text = 'Hi {{ contact_name }}, {{organization_name}} {{nope}}';
    expect(hasLegacySyntax(text)).toBe(true);
    expect(upgradeLegacy(text)).toBe('Hi [Contact Name], [Organisation Name] {{nope}}');
    expect(hasLegacySyntax('Hi [Contact Name]')).toBe(false);
  });
});
