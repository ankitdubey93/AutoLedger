import { Link } from 'react-router-dom';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * Shown above LedgerCore's pages when the wizard was skipped rather than
 * completed (Phase 9a). Persistent — no dismiss — because a skipped setup is
 * a standing condition, not a one-time notice; it goes away only once
 * onboarding actually completes.
 */
export default function OnboardingBanner() {
  const base = useAppBasePath();
  return (
    <div
      role="status"
      className="mb-4 rounded-md border border-[var(--border)] bg-[var(--panel)] px-4 py-2.5 text-sm flex items-center justify-between gap-4"
    >
      <span>Setup was skipped — some LedgerCore features need it.</span>
      <Link to={`${base}/onboarding`} className="font-medium underline shrink-0">
        Finish setup
      </Link>
    </div>
  );
}
