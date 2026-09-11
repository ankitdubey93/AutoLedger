import { cents, scaleCents } from './money.js';
import type { ForecasterDriverKind, ForecasterLineKind } from '../types/forecaster.js';

/**
 * ForecasterPro's forecast build engine (Phase 13) — a pure function, no DB,
 * no clock, no I/O. Mirrors `utils/fpaProjection.ts`'s posture: an
 * app-specific computation engine that lives in `utils/` so it can be
 * unit-tested without a running Postgres.
 *
 * Every scaling here is `scaleCents` — exact `BigInt` integer arithmetic
 * (guardrails rule 3). There is no other multiplication or division applied
 * to a cents value anywhere in this file.
 *
 * DELIBERATE LIMITS, stated once here rather than scattered through the
 * arithmetic below:
 *
 *  - **A missing driver value produces zero and a flag, never an invented
 *    figure.** This is the single most consequential default in the
 *    engine — a DRIVER_PRODUCT or DRIVER_PERCENT line with no value stored
 *    for a given month costs nothing that month, and `missingDriverValue`
 *    says why.
 *  - **A `FIXED_CENTS` line is the same in every month** — there is no
 *    inflation or escalation curve. Escalation is expressible as a driver
 *    plus a `DRIVER_PERCENT` line, not a first-class field here.
 *  - **Salary is annual ÷ 12, a flat twelfth, not a day-count convention**
 *    — the same simplification `fpaProjection` makes with its 30-day
 *    month.
 *  - **Loading is applied after FTE scaling**, so 1.8 FTE at 18% loading is
 *    `(annual/12) × 1.8 × 1.18`, rounded at each of the three steps — not
 *    folded into one calculation.
 *  - **This engine is not a 3-statement model.** It produces a per-account
 *    expense/revenue build-up only. Balance-sheet and cash-flow linkage is
 *    FP&A Engine's (Phase 12), reached through its own routes.
 */

export interface BuildDriverValue {
  driverId: string;
  kind: ForecasterDriverKind;
  month: string; // 'YYYY-MM-01'
  value: number;
}

export interface BuildLine {
  lineId: string;
  label: string;
  accountId: string;
  kind: ForecasterLineKind;
  quantityDriverId: string | null;
  rateDriverId: string | null;
  sourceDriverId: string | null;
  percentBps: number | null;
  fixedCents: number | null;
}

export interface BuildRole {
  roleId: string;
  title: string;
  accountId: string;
  startsOn: string;
  endsOn: string | null;
  fteCount: number;
  annualSalaryCents: number;
  loadingBps: number;
}

export interface ForecastBuildInput {
  months: readonly string[]; // 'YYYY-MM-01', chronological
  driverValues: readonly BuildDriverValue[];
  lines: readonly BuildLine[];
  roles: readonly BuildRole[];
}

export interface BuiltLine {
  lineId: string;
  label: string;
  accountId: string;
  amountCents: number;
  /** true when a driver this line needs has no value stored for this month. amountCents is then 0. */
  missingDriverValue: boolean;
}

export interface BuiltRole {
  roleId: string;
  title: string;
  accountId: string;
  fteCount: number;
  amountCents: number;
}

export interface BuiltMonth {
  month: string;
  lines: readonly BuiltLine[];
  roles: readonly BuiltRole[];
  accountTotals: readonly { accountId: string; amountCents: number }[];
  totalCents: number;
}

export interface ForecastBuild {
  months: readonly BuiltMonth[];
  /** Union of every accountId appearing on any line or role, sorted ascending. */
  accountIds: readonly string[];
  /** Per account, summed across the whole horizon. */
  horizonTotals: readonly { accountId: string; amountCents: number }[];
  /** true when any line in any month reported missingDriverValue. */
  hasMissingDriverValues: boolean;
}

function driverValueKey(driverId: string, month: string): string {
  return `${driverId}|${month}`;
}

function sumByAccount(
  lines: readonly BuiltLine[],
  roles: readonly BuiltRole[],
): { accountId: string; amountCents: number }[] {
  const totals = new Map<string, number>();
  for (const line of lines) {
    totals.set(line.accountId, (totals.get(line.accountId) ?? 0) + line.amountCents);
  }
  for (const role of roles) {
    totals.set(role.accountId, (totals.get(role.accountId) ?? 0) + role.amountCents);
  }
  return [...totals.entries()]
    .map(([accountId, amountCents]) => ({ accountId, amountCents }))
    .sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
}

/** Pure. No DB, no clock, no I/O — the same input always yields the same output. */
export function buildForecast(input: ForecastBuildInput): ForecastBuild {
  const valueByKey = new Map<string, number>();
  for (const dv of input.driverValues) {
    valueByKey.set(driverValueKey(dv.driverId, dv.month), dv.value);
  }

  const builtMonths: BuiltMonth[] = [];
  let hasMissingDriverValues = false;
  const horizonTotalsMap = new Map<string, number>();

  for (const month of input.months) {
    const builtLines: BuiltLine[] = [];

    for (const line of input.lines) {
      let amountCents = 0;
      let missingDriverValue = false;

      switch (line.kind) {
        case 'DRIVER_PRODUCT': {
          if (line.quantityDriverId === null || line.rateDriverId === null) {
            throw new Error(`DRIVER_PRODUCT line ${line.lineId} is missing a driver id`);
          }
          const quantityValue = valueByKey.get(driverValueKey(line.quantityDriverId, month));
          const rateValue = valueByKey.get(driverValueKey(line.rateDriverId, month));
          if (quantityValue === undefined || rateValue === undefined) {
            missingDriverValue = true;
          } else {
            // The quantity is the NUMERATOR; setDriverValues' 422 guard
            // is what guarantees it is never negative here.
            amountCents = scaleCents(cents(rateValue), quantityValue, 1);
          }
          break;
        }
        case 'DRIVER_PERCENT': {
          if (line.sourceDriverId === null || line.percentBps === null) {
            throw new Error(`DRIVER_PERCENT line ${line.lineId} is missing sourceDriverId or percentBps`);
          }
          const sourceValue = valueByKey.get(driverValueKey(line.sourceDriverId, month));
          if (sourceValue === undefined) {
            missingDriverValue = true;
          } else {
            amountCents = scaleCents(cents(sourceValue), line.percentBps, 10000);
          }
          break;
        }
        case 'FIXED_CENTS': {
          if (line.fixedCents === null) {
            throw new Error(`FIXED_CENTS line ${line.lineId} is missing fixedCents`);
          }
          amountCents = cents(line.fixedCents);
          missingDriverValue = false;
          break;
        }
      }

      if (missingDriverValue) hasMissingDriverValues = true;
      builtLines.push({
        lineId: line.lineId,
        label: line.label,
        accountId: line.accountId,
        amountCents,
        missingDriverValue,
      });
    }

    const builtRoles: BuiltRole[] = [];
    for (const role of input.roles) {
      const active = month >= role.startsOn && (role.endsOn === null || month <= role.endsOn);
      if (!active) continue;

      const monthlyBase = scaleCents(cents(role.annualSalaryCents), 1, 12);
      const withFte = scaleCents(monthlyBase, role.fteCount, 1);
      const amountCents = scaleCents(withFte, 10000 + role.loadingBps, 10000);

      builtRoles.push({
        roleId: role.roleId,
        title: role.title,
        accountId: role.accountId,
        fteCount: role.fteCount,
        amountCents,
      });
    }

    const accountTotals = sumByAccount(builtLines, builtRoles);
    const totalCents = accountTotals.reduce((sum, t) => sum + t.amountCents, 0);

    for (const t of accountTotals) {
      horizonTotalsMap.set(t.accountId, (horizonTotalsMap.get(t.accountId) ?? 0) + t.amountCents);
    }

    builtMonths.push({ month, lines: builtLines, roles: builtRoles, accountTotals, totalCents });
  }

  const accountIds = [...new Set([...input.lines.map((l) => l.accountId), ...input.roles.map((r) => r.accountId)])].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );

  const horizonTotals = [...horizonTotalsMap.entries()]
    .map(([accountId, amountCents]) => ({ accountId, amountCents }))
    .sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));

  return { months: builtMonths, accountIds, horizonTotals, hasMissingDriverValues };
}
