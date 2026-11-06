import { describe, expect, it } from 'vitest';
import css from '../index.css?raw';

/** WCAG relative luminance contrast between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r = 0, g = 0, bl = 0] = [1, 3, 5].map((i) => {
      const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/** Every value a token takes in index.css: the dark `:root` block, then the light blocks. */
function tokenValues(name: string): string[] {
  return [...css.matchAll(new RegExp(`--${name}: (#[0-9a-f]{6});`, 'g'))].map((match) => match[1] ?? '');
}

/** [dark, light] for a token; the two light blocks must not have drifted apart. */
function themes(name: string): [string, string] {
  const [dark, light, lightAgain] = tokenValues(name);
  expect(light).toBe(lightAgain);
  return [dark ?? '', light ?? ''];
}

describe('form contrast', () => {
  const surfaces = ['bg', 'panel', 'panel-2', 'input-bg'].map(themes);

  it.each([
    ['dark', 0],
    ['light', 1],
  ] as const)('a field edge reaches 3:1 against every surface it sits on (%s)', (_theme, index) => {
    const border = themes('input-border')[index];
    for (const surface of surfaces) {
      expect(contrast(border, surface[index])).toBeGreaterThanOrEqual(3);
    }
  });

  it.each([
    ['dark', 0],
    ['light', 1],
  ] as const)('typed text and placeholders reach 4.5:1 inside a field (%s)', (_theme, index) => {
    const field = themes('input-bg')[index];
    expect(contrast(themes('text')[index], field)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(themes('muted')[index], field)).toBeGreaterThanOrEqual(4.5);
  });
});
