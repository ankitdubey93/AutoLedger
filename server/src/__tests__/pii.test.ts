import { describe, expect, it } from 'vitest';
import { detectPii, redactText, regionsForWords } from '../utils/pii.js';
import type { OcrWord } from '../types/ap-flow.js';

function word(text: string, x0: number, x1: number, y0 = 0, y1 = 10): OcrWord {
  return { text, box: { x0, y0, x1, y1 }, confidence: 0.9 };
}

describe('detectPii', () => {
  it('detects a Luhn-valid card number', () => {
    const spans = detectPii('Card 4111 1111 1111 1111 paid');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.kind).toBe('CARD_NUMBER');
    const text = 'Card 4111 1111 1111 1111 paid';
    expect(text.slice(spans[0]?.start, spans[0]?.end)).toBe('4111 1111 1111 1111');
  });

  it('does not flag a Luhn-invalid 16-digit run as a card number', () => {
    const spans = detectPii('Invoice 1234567890123456 total');
    expect(spans.filter((s) => s.kind === 'CARD_NUMBER')).toHaveLength(0);
  });

  it('detects a PAN', () => {
    const spans = detectPii('PAN ABCDE1234F');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.kind).toBe('PAN');
  });

  it('detects a label-anchored person name', () => {
    const spans = detectPii('Bill To: Priya Sharma\nAmount');
    const nameSpans = spans.filter((s) => s.kind === 'PERSON_NAME');
    expect(nameSpans).toHaveLength(1);
    const text = 'Bill To: Priya Sharma\nAmount';
    expect(text.slice(nameSpans[0]?.start, nameSpans[0]?.end)).toBe('Priya Sharma');
  });

  it('does not treat a capitalised line item as a name without a label', () => {
    const spans = detectPii('EC2 Compute Instances');
    expect(spans).toHaveLength(0);
  });
});

describe('redactText', () => {
  it('replaces a Luhn-valid card number with [REDACTED:CARD_NUMBER] and leaves surrounding words intact', () => {
    const result = redactText('Card 4111 1111 1111 1111 paid');
    expect(result).toBe('Card [REDACTED:CARD_NUMBER] paid');
  });

  it('returns the input unchanged when detectPii finds nothing', () => {
    const text = 'Invoice for consulting services rendered in March';
    expect(redactText(text)).toBe(text);
  });
});

describe('regionsForWords', () => {
  it('produces one region per OCR word under a Luhn-valid card number', () => {
    const words = [word('4111', 0, 40), word('1111', 45, 85), word('1111', 90, 130), word('1111', 135, 175)];
    const regions = regionsForWords(words, 0);
    expect(regions).toHaveLength(4);
    for (const region of regions) {
      expect(region.kind).toBe('CARD_NUMBER');
    }
  });

  it('pads outward and clamps to zero, never negative', () => {
    const words = [word('4111', 1, 40, 1, 20), word('1111', 45, 85), word('1111', 90, 130), word('1111', 135, 175)];
    const regions = regionsForWords(words, 3);
    expect(regions[0]?.box.x0).toBe(0);
    expect(regions[0]?.box.y0).toBe(0);
  });

  it('returns an empty array for an empty word list', () => {
    expect(regionsForWords([])).toEqual([]);
  });

  it('returns no regions for ordinary words', () => {
    const words = [word('EC2', 0, 30), word('Compute', 35, 90)];
    expect(regionsForWords(words)).toEqual([]);
  });
});
