import { MODULE_TAGS } from '../config/modules.js';

/**
 * Platform onboarding state — Phase 9a.
 *
 * Platform-layer, unprefixed, mirroring `types/auth.ts`: onboarding spans
 * modules, and each row is keyed by the module's provenance tag
 * (config/modules.ts).
 */

export const ONBOARDING_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'SKIPPED', 'COMPLETED'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export function isOnboardingStatus(value: string): value is OnboardingStatus {
  return (ONBOARDING_STATUSES as readonly string[]).includes(value);
}

/**
 * The one place onboarding's lifecycle is written down (guardrails rule 10).
 *
 * COMPLETED is deliberately NOT terminal: re-running a wizard is already
 * legal, since every completer is an upsert (settingsService.completeOnboarding
 * is one example). SKIPPED is not terminal either — a skipped wizard is
 * resumable, which is the whole point of this phase.
 */
export const ONBOARDING_TRANSITIONS = {
  NOT_STARTED: ['IN_PROGRESS', 'SKIPPED', 'COMPLETED'],
  IN_PROGRESS: ['SKIPPED', 'COMPLETED'],
  SKIPPED: ['IN_PROGRESS', 'COMPLETED'],
  COMPLETED: ['IN_PROGRESS'],
} as const satisfies Record<OnboardingStatus, readonly OnboardingStatus[]>;

export function canTransitionOnboarding(from: OnboardingStatus, to: OnboardingStatus): boolean {
  return (ONBOARDING_TRANSITIONS[from] as readonly OnboardingStatus[]).includes(to);
}

/**
 * The modules that have a setup step, keyed by provenance tag. Capture has
 * none: a bill inbox needs no configuration to start. Phase 33 removed the
 * `'platform'` key, which recorded the retired app picker.
 */
export const ONBOARDING_TASKS = [
  { module: MODULE_TAGS.accounting, label: 'Accounting setup', optional: false },
  { module: MODULE_TAGS.inventory, label: 'Inventory', optional: true },
] as const;

export type OnboardingSlug = (typeof ONBOARDING_TASKS)[number]['module'];

export const ONBOARDING_SLUGS: readonly OnboardingSlug[] = ONBOARDING_TASKS.map((task) => task.module);

export function isOnboardingSlug(value: string): value is OnboardingSlug {
  return (ONBOARDING_SLUGS as readonly string[]).includes(value);
}

export interface OnboardingState {
  module: OnboardingSlug;
  status: OnboardingStatus;
  currentStep: string | null;
  draft: Record<string, unknown>;
  completedAt: string | null;
  skippedAt: string | null;
  updatedAt: string | null;
}

export interface OnboardingChecklistItem extends OnboardingState {
  label: string;
  optional: boolean;
}
