/**
 * ForecasterPro (Phase 13) — driver-based rolling forecasting, headcount
 * planning, and zero-based budgeting. This file mirrors `types/fpa-engine.ts`'s
 * FSM-table shape: one transition table in code per lifecycle, each matching
 * a CHECK constraint in its migration.
 */

import type { AccountType } from './ledger-core.js';

/* -------------------------------------------------- Plans (Slice A) */

export const FORECASTER_PLAN_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type ForecasterPlanStatus = (typeof FORECASTER_PLAN_STATUSES)[number];

export function isForecasterPlanStatus(value: string): value is ForecasterPlanStatus {
  return (FORECASTER_PLAN_STATUSES as readonly string[]).includes(value);
}

/**
 * No terminal state, deliberately. ForecasterPro posts nothing to the
 * general ledger, ever — a plan is a container for driver-based arithmetic,
 * never a source document, so rule 6 does not apply and archiving a plan
 * carries no integrity obligation. Must match migration 035's CHECK exactly.
 */
export const FORECASTER_PLAN_TRANSITIONS = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: ['ACTIVE'],
} as const satisfies Record<ForecasterPlanStatus, readonly ForecasterPlanStatus[]>;

export function canTransitionForecasterPlan(
  from: ForecasterPlanStatus,
  to: ForecasterPlanStatus,
): boolean {
  return (FORECASTER_PLAN_TRANSITIONS[from] as readonly ForecasterPlanStatus[]).includes(to);
}

export interface ForecasterPlan {
  id: string;
  name: string;
  description: string | null;
  startsOn: string; // 'YYYY-MM-01'
  horizonMonths: number;
  actualsThrough: string; // 'YYYY-MM-01'
  status: ForecasterPlanStatus;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------- Drivers (Slice B) */

export const FORECASTER_DRIVER_KINDS = ['COUNT', 'CENTS', 'BPS'] as const;
export type ForecasterDriverKind = (typeof FORECASTER_DRIVER_KINDS)[number];

export function isForecasterDriverKind(value: string): value is ForecasterDriverKind {
  return (FORECASTER_DRIVER_KINDS as readonly string[]).includes(value);
}

export interface ForecasterDriver {
  id: string;
  planId: string;
  name: string;
  unitLabel: string;
  kind: ForecasterDriverKind;
  createdAt: string;
  updatedAt: string;
}

export interface ForecasterDriverValue {
  driverId: string;
  month: string; // 'YYYY-MM-01'
  value: number;
}

/* -------------------------------------------------- Headcount (Slice C) */

export interface ForecasterHeadcountRole {
  id: string;
  planId: string;
  title: string;
  department: string | null;
  accountId: string;
  accountCode: string;
  accountName: string;
  startsOn: string; // 'YYYY-MM-01'
  endsOn: string | null; // 'YYYY-MM-01'
  fteCount: number;
  annualSalaryCents: number;
  loadingBps: number;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------- Forecast lines (Slice D) */

export const FORECASTER_LINE_KINDS = ['DRIVER_PRODUCT', 'DRIVER_PERCENT', 'FIXED_CENTS'] as const;
export type ForecasterLineKind = (typeof FORECASTER_LINE_KINDS)[number];

export function isForecasterLineKind(value: string): value is ForecasterLineKind {
  return (FORECASTER_LINE_KINDS as readonly string[]).includes(value);
}

export interface ForecasterForecastLine {
  id: string;
  planId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  label: string;
  kind: ForecasterLineKind;
  quantityDriverId: string | null;
  rateDriverId: string | null;
  sourceDriverId: string | null;
  percentBps: number | null;
  fixedCents: number | null;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------- Budgets (Slice E) */

export const FORECASTER_BUDGET_STATUSES = ['DRAFT', 'APPROVED', 'SUPERSEDED'] as const;
export type ForecasterBudgetStatus = (typeof FORECASTER_BUDGET_STATUSES)[number];

export function isForecasterBudgetStatus(value: string): value is ForecasterBudgetStatus {
  return (FORECASTER_BUDGET_STATUSES as readonly string[]).includes(value);
}

/**
 * SUPERSEDED is terminal — ForecasterPro's ONLY terminal state. An approved
 * budget is a decision of record; correcting it means a new DRAFT version,
 * never an edit. Must match migration 039's CHECK exactly.
 */
export const FORECASTER_BUDGET_TRANSITIONS = {
  DRAFT: ['APPROVED'],
  APPROVED: ['SUPERSEDED'],
  SUPERSEDED: [],
} as const satisfies Record<ForecasterBudgetStatus, readonly ForecasterBudgetStatus[]>;

export function canTransitionForecasterBudget(
  from: ForecasterBudgetStatus,
  to: ForecasterBudgetStatus,
): boolean {
  return (FORECASTER_BUDGET_TRANSITIONS[from] as readonly ForecasterBudgetStatus[]).includes(to);
}

export const FORECASTER_BUDGET_LINE_SOURCES = ['DRIVER', 'HEADCOUNT', 'MANUAL'] as const;
export type ForecasterBudgetLineSource = (typeof FORECASTER_BUDGET_LINE_SOURCES)[number];

export interface ForecasterBudgetVersion {
  id: string;
  planId: string;
  label: string;
  status: ForecasterBudgetStatus;
  createdBy: string;
  createdByName: string;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  lineCount: number;
  totalCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface ForecasterBudgetLine {
  id: string;
  versionId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  month: string; // 'YYYY-MM-01'
  amountCents: number;
  source: ForecasterBudgetLineSource;
  justification: string;
  createdAt: string;
  updatedAt: string;
}

export interface ForecasterBudgetVersionDetail extends ForecasterBudgetVersion {
  lines: ForecasterBudgetLine[];
}

export interface ForecasterVarianceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  month: string; // 'YYYY-MM-01'
  budgetCents: number;
  actualCents: number;
  /** actual − budget. Sign is raw; `favourable` carries the business reading. */
  varianceCents: number;
  /** Revenue: actual >= budget. Expense: actual <= budget. */
  favourable: boolean;
}
