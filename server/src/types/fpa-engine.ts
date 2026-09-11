/**
 * FP&A Engine (Phase 12) — the linked 3-statement model, scenarios, and
 * assumptions. This file mirrors `types/ap-flow.ts`'s FSM-table shape: one
 * transition table in code, a matching CHECK constraint in the migration.
 */

import type { AccountType } from './ledger-core.js';

export const FPA_MODEL_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type FpaModelStatus = (typeof FPA_MODEL_STATUSES)[number];

export function isFpaModelStatus(value: string): value is FpaModelStatus {
  return (FPA_MODEL_STATUSES as readonly string[]).includes(value);
}

/**
 * No terminal state, deliberately. Every other FSM in this codebase has one
 * — ap_flow_documents.POSTED, fiscal_periods.LOCKED, migration_imports
 * .COMMITTED — because each marks a fact that reached the general ledger and
 * must never change. A forecast reaches nothing: FP&A posts no journal entry,
 * so archiving a model carries no integrity obligation and refusing to
 * un-archive it would be user-hostile with no payoff.
 */
export const FPA_MODEL_TRANSITIONS = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: ['ACTIVE'],
} as const satisfies Record<FpaModelStatus, readonly FpaModelStatus[]>;

export function canTransitionFpaModel(from: FpaModelStatus, to: FpaModelStatus): boolean {
  return (FPA_MODEL_TRANSITIONS[from] as readonly FpaModelStatus[]).includes(to);
}

export const FPA_SCENARIO_KINDS = ['BASE', 'UPSIDE', 'DOWNSIDE', 'CUSTOM'] as const;
export type FpaScenarioKind = (typeof FPA_SCENARIO_KINDS)[number];

export function isFpaScenarioKind(value: string): value is FpaScenarioKind {
  return (FPA_SCENARIO_KINDS as readonly string[]).includes(value);
}

export interface FpaScenario {
  id: string;
  modelId: string;
  name: string;
  kind: FpaScenarioKind;
  isDefault: boolean;
  dsoDays: number;
  dpoDays: number;
  taxRateBps: number;
  createdAt: string;
  updatedAt: string;
}

export interface FpaModel {
  id: string;
  name: string;
  description: string | null;
  startsOn: string; // 'YYYY-MM-01'
  horizonMonths: number;
  actualsThrough: string; // 'YYYY-MM-01'
  status: FpaModelStatus;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  scenarioCount: number;
}

export interface FpaModelDetail extends FpaModel {
  scenarios: FpaScenario[];
}

/* -------------------------------------------------- Assumptions (Slice B) */

export const FPA_ASSUMPTION_KINDS = ['GROWTH_BPS', 'FIXED_CENTS', 'PERCENT_OF_REVENUE_BPS'] as const;
export type FpaAssumptionKind = (typeof FPA_ASSUMPTION_KINDS)[number];

export function isFpaAssumptionKind(value: string): value is FpaAssumptionKind {
  return (FPA_ASSUMPTION_KINDS as readonly string[]).includes(value);
}

export interface FpaAssumption {
  id: string;
  scenarioId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  kind: FpaAssumptionKind;
  growthBps: number | null;
  fixedCents: number | null;
  percentOfRevenueBps: number | null;
  createdAt: string;
  updatedAt: string;
}
