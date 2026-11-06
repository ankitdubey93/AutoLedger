import { describe, expect, it } from 'vitest';
import { basDueDate, basPeriodContaining, isBasPeriodStart, previousBasPeriod } from '../utils/basPeriods.js';
import { attributed } from '../services/accounting/gstEventService.js';
import { basSummary, computeWorksheet, labelsForEvent, wholeDollars } from '../utils/basWorksheet.js';

describe('BAS periods', () => {
  it.each([
    ['2026-07-01', '2026-07-01', '2026-09-30'],
    ['2026-09-30', '2026-07-01', '2026-09-30'],
    ['2026-10-15', '2026-10-01', '2026-12-31'],
    ['2027-02-28', '2027-01-01', '2027-03-31'],
    ['2027-06-30', '2027-04-01', '2027-06-30'],
  ])('quarter containing %s', (date, start, end) => {
    expect(basPeriodContaining(date, 'QUARTERLY')).toEqual({ start, end });
  });

  it('finds month bounds, including a leap February', () => {
    expect(basPeriodContaining('2028-02-10', 'MONTHLY')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });

  it('walks back across a year', () => {
    expect(previousBasPeriod({ start: '2027-01-01', end: '2027-03-31' }, 'QUARTERLY')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(previousBasPeriod({ start: '2027-01-01', end: '2027-01-31' }, 'MONTHLY')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
  });

  it('recognises a period start', () => {
    expect(isBasPeriodStart('2026-07-01', 'QUARTERLY')).toBe(true);
    expect(isBasPeriodStart('2026-08-01', 'QUARTERLY')).toBe(false);
    expect(isBasPeriodStart('2026-08-01', 'MONTHLY')).toBe(true);
  });

  it.each([
    ['2026-09-30', '2026-10-28'],
    ['2026-12-31', '2027-02-28'],
    ['2027-03-31', '2027-04-28'],
    ['2027-06-30', '2027-07-28'],
  ])('a quarter ending %s is due %s', (end, due) => {
    expect(basDueDate(end, 'QUARTERLY')).toBe(due);
  });

  it('a month is due on the 21st of the next, across a year', () => {
    expect(basDueDate('2026-12-31', 'MONTHLY')).toBe('2027-01-21');
  });
});

const event = (taxCode: string, netCents: number, taxCents: number, priorPeriod = false) => ({ taxCode, netCents, taxCents, priorPeriod });

describe('the worksheet', () => {
  it('takes a mixed quarter through every label', () => {
    const l = computeWorksheet(
      [
        event('S_GST', 100_000, 10_000),
        event('S_EXPORT', 20_000, 0),
        event('S_FREE', 5_000, 0),
        event('S_INPUT_TAXED', 3_000, 0),
        event('S_EXCLUDED', 99_999, 0),
        event('P_GST', 40_000, 4_000),
        event('P_CAP_GST', 50_000, 5_000),
        event('P_FREE', 1_000, 0),
        event('P_CAP_FREE', 2_000, 0),
        event('P_INPUT_TAXED', 1_100, 0),
        event('P_PRIVATE', 2_200, 0),
        event('P_EXCLUDED', 88_888, 0),
      ],
      [],
    );
    expect(l).toMatchObject({
      G1: 138_000,
      G2: 20_000,
      G3: 5_000,
      G4: 3_000,
      G5: 28_000,
      G6: 110_000,
      G7: 0,
      G8: 110_000,
      G9: 10_000,
      G10: 57_000,
      G11: 48_300,
      G12: 105_300,
      G13: 1_100,
      G14: 3_000,
      G15: 2_200,
      G16: 6_300,
      G17: 99_000,
      G18: 0,
      G19: 99_000,
      G20: 9_000,
      '1A': 10_000,
      '1B': 9_000,
    });
  });

  it('nets a same-period credit note out of sales', () => {
    const l = computeWorksheet([event('S_GST', 10_000, 1_000), event('S_GST', -4_000, -400)], []);
    expect(l).toMatchObject({ G1: 6_600, '1A': 600 });
  });

  it('moves a prior-period note to the adjustment labels, keeping its tax', () => {
    const l = computeWorksheet([event('S_GST', 10_000, 1_000), event('S_GST', -2_000, -200, true), event('P_GST', -1_000, -100, true)], []);
    expect(l).toMatchObject({ G1: 11_000, G7: -2_200, G8: 8_800, G9: 800, '1A': 800, G18: -1_100, G19: -1_100, '1B': -100 });
    expect(labelsForEvent('S_GST', true)).toEqual(['G7']);
  });

  it('adds a manual adjustment to the worksheet and to 1A or 1B', () => {
    const l = computeWorksheet([], [
      { label: 'G7', grossCents: 1_100, taxCents: 100 },
      { label: 'G18', grossCents: 2_200, taxCents: 200 },
    ]);
    expect(l).toMatchObject({ G7: 1_100, G9: 100, '1A': 100, G18: 2_200, G20: 200, '1B': 200 });
  });

  it('uses actual tax for 1A, with G9 as the cross-check that rounding can miss', () => {
    // Three $0.99 inclusive sales: each line rounds its own GST to 9 cents.
    const l = computeWorksheet([event('S_GST', 90, 9), event('S_GST', 90, 9), event('S_GST', 90, 9)], []);
    expect(l['1A']).toBe(27);
    expect(l.G9).toBe(27);
    const uneven = computeWorksheet([event('S_GST', 5, 1), event('S_GST', 5, 1), event('S_GST', 5, 1)], []);
    expect(uneven['1A']).toBe(3);
    expect(uneven.G9).toBe(2);
  });

  it('leaves unknown and excluded codes out', () => {
    expect(labelsForEvent('S_EXCLUDED', false)).toEqual([]);
    expect(labelsForEvent('NOPE', false)).toEqual([]);
  });
});

describe('the summary', () => {
  it('drops cents and nets to what is payable', () => {
    expect(basSummary({ '1A': 1_234_599, '1B': 400_099 }, 300_050, 100_000)).toEqual({
      gstOnSales: 12_345,
      gstOnPurchases: 4_000,
      paygWithheld: 3_000,
      paygInstalment: 1_000,
      netPayable: 12_345,
    });
  });

  it('shows a refund as negative, and truncates toward zero', () => {
    expect(basSummary({ '1A': 0, '1B': 50_000 }, 0, 0).netPayable).toBe(-500);
    expect(wholeDollars(-199)).toBe(-1);
  });
});

describe('cash-basis attribution telescopes', () => {
  // A small seeded generator, so a failure reproduces.
  function random(seed: number): () => number {
    let x = seed;
    return () => {
      x = (x * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return x / 4_294_967_296;
    };
  }

  it('sums to exactly the amount, over many documents and payment patterns', () => {
    const next = random(49);
    for (let run = 0; run < 2_000; run += 1) {
      const total = 1 + Math.floor(next() * 5_000_000);
      const lineTax = Math.floor(next() * total);
      let settled = 0;
      let reported = 0;
      let previous = 0;
      while (settled < total) {
        const pay = Math.min(total - settled, 1 + Math.floor(next() * total));
        settled += pay;
        const cumulative = attributed(lineTax, settled, total);
        reported += cumulative - previous;
        previous = cumulative;
      }
      expect(reported).toBe(lineTax);
    }
  });

  it('is capped at the line when a document is over-settled', () => {
    expect(attributed(1_000, 11_000, 10_000)).toBe(1_000);
  });

  it('comes back down when a payment is voided', () => {
    const paid = attributed(1_000, 5_000, 10_000);
    const voided = attributed(1_000, 0, 10_000);
    expect(voided - paid).toBe(-500);
  });
});
