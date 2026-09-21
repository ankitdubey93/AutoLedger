import { describe, expect, it } from 'vitest';
import css from '../index.css?raw';

// vitest.config.ts sets `css: false`, so jsdom never evaluates the stylesheet
// and no rendered-component assertion can see a cascade-layer bug. Reading the
// file as text is what lets this test fail.

/** The body of the first `@layer base { ... }` block, by brace matching. */
function baseLayerBody(source: string): string {
  const marker = source.indexOf('@layer base');
  if (marker < 0) throw new Error('no @layer base block in index.css');
  const open = source.indexOf('{', marker);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced braces in @layer base block');
}

describe('index.css cascade layers', () => {
  it('keeps the blanket table element rules inside @layer base', () => {
    const body = baseLayerBody(css);
    expect(body).toContain('th,');
    expect(body).toContain('td {');
    expect(body).toContain('border-collapse: collapse;');
  });

  it('leaves the opt-in class rules unlayered so the pre-Tailwind pages keep winning', () => {
    const body = baseLayerBody(css);
    expect(body).not.toContain('.card {');
    expect(body).not.toContain('.btn {');
    expect(body).not.toContain('.table-scroll {');
  });

  it('imports tailwindcss first so the layer order is declared before any rule', () => {
    const firstRule = css.indexOf('@layer base');
    const importAt = css.indexOf('@import "tailwindcss";');
    expect(importAt).toBeGreaterThanOrEqual(0);
    expect(importAt).toBeLessThan(firstRule);
  });
});
