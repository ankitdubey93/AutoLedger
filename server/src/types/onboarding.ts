import { APPS, isAppSlug, type AppSlug } from '../config/apps.js';

/**
 * Platform onboarding state — Phase 9a.
 *
 * Platform-layer, unprefixed, mirroring `types/auth.ts` and `types/apps.ts`:
 * onboarding spans every app, not just LedgerCore (guardrails rule 16).
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

/** `'platform'` is the suite-level wizard; every other value is a real app slug. */
export type OnboardingSlug = AppSlug | 'platform';

/** The full set of valid onboarding slugs — every app in APPS, plus 'platform'. */
export const ONBOARDING_SLUGS: readonly OnboardingSlug[] = [
  ...APPS.map((app) => app.slug),
  'platform',
];

export function isOnboardingSlug(value: string): value is OnboardingSlug {
  return value === 'platform' || isAppSlug(value);
}

export interface OnboardingState {
  appSlug: OnboardingSlug;
  status: OnboardingStatus;
  currentStep: string | null;
  draft: Record<string, unknown>;
  completedAt: string | null;
  skippedAt: string | null;
  updatedAt: string | null;
}

export interface OnboardingChecklistItem extends OnboardingState {
  appName: string;
  appStatus: 'building' | 'planned';
}
