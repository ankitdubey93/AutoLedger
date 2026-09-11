import { describe, expect, it } from 'vitest';
import { buildForecast, type BuildLine, type BuildRole } from '../utils/forecasterBuild.js';

/**
 * Pure unit tests — no database import, passes with Postgres stopped.
 * Mirrors `fpaProjection.test.ts`'s posture: hand-computed expected values,
 * the arithmetic shown alongside each.
 */

const MONTHS = ['2026-10-01', '2026-11-01', '2026-12-01'];

function driverProductLine(overrides: Partial<BuildLine> = {}): BuildLine {
  return {
    lineId: 'line-1',
    label: 'Subscription revenue',
    accountId: 'account-1',
    kind: 'DRIVER_PRODUCT',
    quantityDriverId: 'qty-driver',
    rateDriverId: 'rate-driver',
    sourceDriverId: null,
    percentBps: null,
    fixedCents: null,
    ...overrides,
  };
}

describe('forecasterBuild — DRIVER_PRODUCT', () => {
  it('1. multiplies a count by a price in cents', () => {
    const build = buildForecast({
      months: ['2026-10-01'],
      driverValues: [
        { driverId: 'qty-driver', kind: 'COUNT', month: '2026-10-01', value: 1200 },
        { driverId: 'rate-driver', kind: 'CENTS', month: '2026-10-01', value: 49900 },
      ],
      lines: [driverProductLine()],
      roles: [],
    });
    // scaleCents(cents(49900), 1200, 1) = 49900 * 1200 = 59_880_000
    expect(build.months[0]?.lines[0]?.amountCents).toBe(59_880_000);
  });
});

describe('forecasterBuild — DRIVER_PERCENT', () => {
  const percentLine: BuildLine = {
    lineId: 'line-2',
    label: 'Payment processing fees',
    accountId: 'account-2',
    kind: 'DRIVER_PERCENT',
    quantityDriverId: null,
    rateDriverId: null,
    sourceDriverId: 'source-driver',
    percentBps: 250,
    fixedCents: null,
  };

  it('2. scales a cents driver by basis points', () => {
    const build = buildForecast({
      months: ['2026-10-01'],
      driverValues: [{ driverId: 'source-driver', kind: 'CENTS', month: '2026-10-01', value: 10_000_000 }],
      lines: [percentLine],
      roles: [],
    });
    // scaleCents(10_000_000, 250, 10000) = 250_000
    expect(build.months[0]?.lines[0]?.amountCents).toBe(250_000);
  });

  it('3. rounds half up', () => {
    const build = buildForecast({
      months: ['2026-10-01'],
      driverValues: [{ driverId: 'source-driver', kind: 'CENTS', month: '2026-10-01', value: 999 }],
      lines: [{ ...percentLine, percentBps: 5000 }],
      roles: [],
    });
    // (999 * 5000 + 5000) / 10000 = 500 (not 499)
    expect(build.months[0]?.lines[0]?.amountCents).toBe(500);
  });
});

describe('forecasterBuild — FIXED_CENTS', () => {
  const fixedLine: BuildLine = {
    lineId: 'line-3',
    label: 'Office rent',
    accountId: 'account-3',
    kind: 'FIXED_CENTS',
    quantityDriverId: null,
    rateDriverId: null,
    sourceDriverId: null,
    percentBps: null,
    fixedCents: 750_000,
  };

  it('4. is identical in every month', () => {
    const build = buildForecast({ months: MONTHS, driverValues: [], lines: [fixedLine], roles: [] });
    for (const m of build.months) {
      expect(m.lines[0]?.amountCents).toBe(750_000);
    }
  });

  it('7. never flags a missing driver value', () => {
    const build = buildForecast({ months: ['2026-10-01'], driverValues: [], lines: [fixedLine], roles: [] });
    expect(build.months[0]?.lines[0]?.missingDriverValue).toBe(false);
  });
});

describe('forecasterBuild — missing driver values', () => {
  it('5. a missing quantity value yields zero and flags the line', () => {
    const build = buildForecast({
      months: ['2026-10-01'],
      driverValues: [{ driverId: 'rate-driver', kind: 'CENTS', month: '2026-10-01', value: 100 }],
      lines: [driverProductLine()],
      roles: [],
    });
    expect(build.months[0]?.lines[0]?.amountCents).toBe(0);
    expect(build.months[0]?.lines[0]?.missingDriverValue).toBe(true);
    expect(build.hasMissingDriverValues).toBe(true);
  });

  it('6. a missing rate value flags the line just as a missing quantity does', () => {
    const build = buildForecast({
      months: ['2026-10-01'],
      driverValues: [{ driverId: 'qty-driver', kind: 'COUNT', month: '2026-10-01', value: 5 }],
      lines: [driverProductLine()],
      roles: [],
    });
    expect(build.months[0]?.lines[0]?.amountCents).toBe(0);
    expect(build.months[0]?.lines[0]?.missingDriverValue).toBe(true);
    expect(build.hasMissingDriverValues).toBe(true);
  });
});

describe('forecasterBuild — headcount roles', () => {
  const role: BuildRole = {
    roleId: 'role-1',
    title: 'Senior Engineer',
    accountId: 'account-4',
    startsOn: '2026-10-01',
    endsOn: null,
    fteCount: 2,
    annualSalaryCents: 12_000_000,
    loadingBps: 1800,
  };

  it('8. costs annual/12 x fte x (1 + loading)', () => {
    const build = buildForecast({ months: ['2026-10-01'], driverValues: [], lines: [], roles: [role] });
    // scaleCents(12_000_000, 1, 12) = 1_000_000
    // scaleCents(1_000_000, 2, 1) = 2_000_000
    // scaleCents(2_000_000, 11800, 10000) = 2_360_000
    expect(build.months[0]?.roles[0]?.amountCents).toBe(2_360_000);
  });

  it('9. a role with zero loading costs exactly annual/12 x fte', () => {
    const build = buildForecast({
      months: ['2026-10-01'],
      driverValues: [],
      lines: [],
      roles: [{ ...role, loadingBps: 0 }],
    });
    expect(build.months[0]?.roles[0]?.amountCents).toBe(2_000_000);
  });

  it('10. a role is omitted from months before it starts', () => {
    const build = buildForecast({
      months: MONTHS,
      driverValues: [],
      lines: [],
      roles: [{ ...role, startsOn: '2026-12-01' }],
    });
    expect(build.months[0]?.roles).toHaveLength(0);
    expect(build.months[1]?.roles).toHaveLength(0);
    expect(build.months[2]?.roles).toHaveLength(1);
  });

  it('11. a role is omitted from months after it ends', () => {
    const build = buildForecast({
      months: MONTHS,
      driverValues: [],
      lines: [],
      roles: [{ ...role, endsOn: '2026-10-01' }],
    });
    expect(build.months[0]?.roles).toHaveLength(1);
    expect(build.months[1]?.roles).toHaveLength(0);
    expect(build.months[2]?.roles).toHaveLength(0);
  });

  it('12. a role with a null endsOn runs to the end of the horizon', () => {
    const build = buildForecast({ months: MONTHS, driverValues: [], lines: [], roles: [role] });
    for (const m of build.months) {
      expect(m.roles).toHaveLength(1);
    }
  });
});

describe('forecasterBuild — totals', () => {
  it('13. accountTotals sums lines and roles on the same account', () => {
    const build = buildForecast({
      months: ['2026-10-01'],
      driverValues: [],
      lines: [
        {
          lineId: 'line-x',
          label: 'Misc expense',
          accountId: 'shared-account',
          kind: 'FIXED_CENTS',
          quantityDriverId: null,
          rateDriverId: null,
          sourceDriverId: null,
          percentBps: null,
          fixedCents: 100_000,
        },
      ],
      roles: [
        {
          roleId: 'role-x',
          title: 'Engineer',
          accountId: 'shared-account',
          startsOn: '2026-10-01',
          endsOn: null,
          fteCount: 2,
          annualSalaryCents: 12_000_000,
          loadingBps: 1800,
        },
      ],
    });
    expect(build.months[0]?.accountTotals).toHaveLength(1);
    expect(build.months[0]?.accountTotals[0]).toEqual({ accountId: 'shared-account', amountCents: 2_460_000 });
  });

  it('14. totalCents equals the sum of accountTotals', () => {
    const build = buildForecast({
      months: ['2026-10-01'],
      driverValues: [],
      lines: [
        { lineId: 'a', label: 'A', accountId: 'acc-a', kind: 'FIXED_CENTS', quantityDriverId: null, rateDriverId: null, sourceDriverId: null, percentBps: null, fixedCents: 100 },
        { lineId: 'b', label: 'B', accountId: 'acc-b', kind: 'FIXED_CENTS', quantityDriverId: null, rateDriverId: null, sourceDriverId: null, percentBps: null, fixedCents: 200 },
      ],
      roles: [],
    });
    const summed = build.months[0]?.accountTotals.reduce((s, t) => s + t.amountCents, 0);
    expect(build.months[0]?.totalCents).toBe(summed);
    expect(build.months[0]?.totalCents).toBe(300);
  });

  it('15. horizonTotals sums each account across every month', () => {
    const build = buildForecast({
      months: MONTHS,
      driverValues: [],
      lines: [
        { lineId: 'a', label: 'A', accountId: 'acc-a', kind: 'FIXED_CENTS', quantityDriverId: null, rateDriverId: null, sourceDriverId: null, percentBps: null, fixedCents: 750_000 },
      ],
      roles: [],
    });
    expect(build.horizonTotals).toEqual([{ accountId: 'acc-a', amountCents: 2_250_000 }]);
  });

  it('16. accountIds is the sorted union of line and role accounts, with no duplicate', () => {
    const build = buildForecast({
      months: ['2026-10-01'],
      driverValues: [],
      lines: [
        { lineId: 'a', label: 'A', accountId: 'acc-b', kind: 'FIXED_CENTS', quantityDriverId: null, rateDriverId: null, sourceDriverId: null, percentBps: null, fixedCents: 100 },
        { lineId: 'c', label: 'C', accountId: 'acc-a', kind: 'FIXED_CENTS', quantityDriverId: null, rateDriverId: null, sourceDriverId: null, percentBps: null, fixedCents: 100 },
      ],
      roles: [
        { roleId: 'r', title: 'R', accountId: 'acc-a', startsOn: '2026-10-01', endsOn: null, fteCount: 1, annualSalaryCents: 1_200_00, loadingBps: 0 },
      ],
    });
    expect(build.accountIds).toEqual(['acc-a', 'acc-b']);
  });
});

describe('forecasterBuild — edge cases', () => {
  it('17. an empty horizon produces an empty build', () => {
    const build = buildForecast({ months: [], driverValues: [], lines: [], roles: [] });
    expect(build.months).toHaveLength(0);
    expect(build.horizonTotals).toHaveLength(0);
    expect(build.hasMissingDriverValues).toBe(false);
  });

  it('18. the same input twice produces a deeply equal result', () => {
    const input = {
      months: MONTHS,
      driverValues: [{ driverId: 'qty-driver', kind: 'COUNT' as const, month: '2026-10-01', value: 10 }],
      lines: [driverProductLine()],
      roles: [] as BuildRole[],
    };
    expect(buildForecast(input)).toEqual(buildForecast(input));
  });
});
