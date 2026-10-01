import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

const DISMISS_KEY = 'autoledger.verifyBannerDismissed';

function dismissedThisSession(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Phase 38b — a slim reminder while the signed-in user's email is
 * unverified. Dismissible for the browser session; the Profile tab keeps
 * the status and the resend button either way.
 */
export default function VerifyEmailBanner() {
  const auth = useAuth();
  const [dismissed, setDismissed] = useState(dismissedThisSession);

  if (auth.status !== 'authenticated' || auth.user.emailVerified || dismissed) return null;

  return (
    <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--warn-soft,var(--panel-2))] px-3 py-2 text-sm">
      <span>
        Please verify <strong>{auth.user.email}</strong> — we sent you a link.{' '}
        <Link to="/account?tab=profile">Resend it</Link>
      </span>
      <button
        type="button"
        className="text-[var(--muted)] hover:text-[var(--text)]"
        onClick={() => {
          setDismissed(true);
          try {
            sessionStorage.setItem(DISMISS_KEY, '1');
          } catch {
            // Storage can be unavailable (private mode); dismissing for this render is enough.
          }
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
