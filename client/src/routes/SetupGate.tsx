import { useEffect, useRef, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { LedgerSettingsProvider, useLedgerSettings } from '../context/LedgerSettingsContext';
import { getOnboardingState, type OnboardingStatus } from '../services/fetchServices';
import OnboardingPage from '../Pages/home/OnboardingPage';
import WorkspaceLayout from './WorkspaceLayout';

function Loading() {
  return (
    <div className="shell" aria-busy="true">
      <div className="skeleton skeleton--title" />
      <span className="visually-hidden">Loading AutoLedger…</span>
    </div>
  );
}

/** Loads the organization's accounting settings once for every page below it. */
export function SettingsRoot() {
  return (
    <LedgerSettingsProvider>
      <Outlet />
    </LedgerSettingsProvider>
  );
}

/**
 * `/onboarding`: the setup wizard until it has been completed once, then the
 * dashboard.
 *
 * The decision is taken once, on arrival. Finishing the wizard marks the
 * organization onboarded *while this route is still mounted*, and the wizard
 * then navigates on to the optional inventory step. Re-deciding on that
 * render would fire a `<Navigate to="/">` after the wizard's own navigation
 * and win, so the hand-off to step 4 would never be seen.
 */
export function OnboardingRoute() {
  const settings = useLedgerSettings();
  const onboardedOnArrival = useRef<boolean | null>(null);

  if (settings.status === 'loading') return <Loading />;
  if (settings.status === 'error') return <p className="status status--bad">{settings.message}</p>;

  onboardedOnArrival.current ??= settings.settings.onboardedAt !== null;
  return onboardedOnArrival.current ? <Navigate to="/" replace /> : <OnboardingPage />;
}

/**
 * The setup gate in front of every product page (Phase 3.5's onboarding gate,
 * lifted out of LedgerCore's routes in Phase 33 now there is one product).
 *
 * A fresh organization is redirected to `/onboarding` until the wizard is
 * completed. Phase 9a made the gate soft: a wizard that was explicitly
 * skipped (onboarding_states.status === 'SKIPPED') keeps every page
 * reachable behind a persistent banner instead. Only NOT_STARTED and
 * IN_PROGRESS still redirect.
 *
 * AppShell's `key={org.id}-${orgVersion}` remounts this on every organization
 * switch, which is what makes switching into a not-yet-set-up organization
 * show the wizard again.
 */
export default function SetupGate() {
  const settings = useLedgerSettings();
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | 'loading'>('loading');

  useEffect(() => {
    if (settings.status !== 'ready' || settings.settings.onboardedAt !== null) return;
    let ignore = false;

    getOnboardingState('ledger-core')
      .then((state) => {
        if (!ignore) setOnboardingStatus(state.status);
      })
      .catch(() => {
        // Unknown: treat as NOT_STARTED, which keeps the redirect rather than
        // silently unlocking every page.
        if (!ignore) setOnboardingStatus('NOT_STARTED');
      });

    return () => {
      ignore = true;
    };
  }, [settings.status, settings.status === 'ready' ? settings.settings.onboardedAt : null]);

  if (settings.status === 'loading') return <Loading />;
  if (settings.status === 'error') return <p className="status status--bad">{settings.message}</p>;

  const onboarded = settings.settings.onboardedAt !== null;
  if (onboarded) return <WorkspaceLayout showBanner={false} />;
  if (onboardingStatus === 'loading') return <Loading />;
  if (onboardingStatus === 'SKIPPED') return <WorkspaceLayout showBanner />;
  return <Navigate to="/onboarding" replace />;
}
