import { describe, expect, it } from 'vitest';
import { fillGuideTokens, renderGuide } from '../../scripts/walkthroughGuide.js';
import type { AnchorMonth } from '../../scripts/walkthroughDates.js';

/**
 * The guide renderer's contract: a closed token set, filled from the
 * dataset, that throws on anything else. No database — pure functions over
 * the committed templates.
 */

const ANCHOR: AnchorMonth = { year: 2026, month: 3 };

describe('walkthrough guide renderer', () => {
  it('fills every token kind', () => {
    expect(fillGuideTokens(ANCHOR, 't.md', '{{customer:kestrel-logistics}}')).toBe('Kestrel Logistics');
    expect(fillGuideTokens(ANCHOR, 't.md', '{{doc:I16}}')).toBe('I16 (Ferrous Works Ltd)');
    expect(fillGuideTokens(ANCHOR, 't.md', '{{account:1110}}')).toBe('`1110 Operating Cash`');
    expect(fillGuideTokens(ANCHOR, 't.md', '{{date:7:20}}')).toBe('2026-09-20');
    expect(fillGuideTokens(ANCHOR, 't.md', '{{month:7}}')).toBe('September');
    expect(fillGuideTokens(ANCHOR, 't.md', '{{demo.email}}')).toBe('demo@autoledger.dev');
    expect(fillGuideTokens(ANCHOR, 't.md', '{{demo.password}}')).toBe('autoledger-demo');
    expect(fillGuideTokens(ANCHOR, 't.md', '{{vendor:cloudspan}}')).not.toBe('');
  });

  it('throws on an unknown token', () => {
    expect(() => fillGuideTokens(ANCHOR, 't.md', '{{nope:1}}')).toThrow(/unknown token/);
  });

  it('throws on an unknown customer key', () => {
    expect(() => fillGuideTokens(ANCHOR, 't.md', '{{customer:nobody}}')).toThrow(/unknown token/);
  });

  it('throws on braces left unfilled', () => {
    expect(() => fillGuideTokens(ANCHOR, 't.md', 'a {{ b')).toThrow(/unfilled braces/);
  });

  it('renders every committed template with no braces left', () => {
    const files = renderGuide(ANCHOR);
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const file of files) expect(file.content).not.toContain('{{');
  });

  it('every guide file is listed in the guide README', () => {
    const files = renderGuide(ANCHOR);
    const readme = files.find((f) => f.path === 'guide/README.md');
    expect(readme).toBeDefined();
    for (const file of files) {
      if (file.path === 'guide/README.md') continue;
      expect(readme?.content).toContain(file.path.replace('guide/', ''));
    }
  });
});
