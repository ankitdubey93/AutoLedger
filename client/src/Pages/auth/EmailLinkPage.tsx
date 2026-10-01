import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { checkSession, confirmEmailChange, verifyEmail } from '../../services/fetchServices';
import { useAuth, useAuthActions } from '../../context/AuthContext';
import AuthLayout from './AuthLayout';

/**
 * Phase 38b — where an emailed verification or change-of-email link lands
 * (`/verify-email?token=…`, `/confirm-email-change?token=…`). Public: the
 * token is the proof, and the link may be opened on a device that is not
 * signed in.
 *
 * The token is spent by a button, not on page load. A mount effect runs
 * twice under React's StrictMode in development, and the second call would
 * report "already used" right after succeeding; mail scanners that pre-open
 * links in an inbox also must not consume them (they only GET the page).
 */
const COPY = {
  verify: {
    title: 'Verify your email',
    subtitle: 'Confirm this address belongs to you.',
    button: 'Verify my email',
    done: 'Your email is verified.',
    run: verifyEmail,
  },
  change: {
    title: 'Confirm your new email',
    subtitle: 'After this, you sign in with the new address.',
    button: 'Confirm new email',
    done: 'Your sign-in email has been changed.',
    run: confirmEmailChange,
  },
} as const;

export default function EmailLinkPage({ kind }: { kind: 'verify' | 'change' }) {
  const copy = COPY[kind];
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const auth = useAuth();
  const { applySession } = useAuthActions();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setState('busy');
    setError(null);
    try {
      await copy.run(token);
      // A signed-in tab picks up the new email / verified flag straight away.
      if (auth.status === 'authenticated') applySession(await checkSession());
      setState('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This link could not be used');
      setState('idle');
    }
  }

  return (
    <AuthLayout title={copy.title} subtitle={copy.subtitle}>
      {token === '' ? (
        <p className="status status--bad m-0">This link is missing its token. Open it straight from the email.</p>
      ) : state === 'done' ? (
        <div className="card flex flex-col gap-2" role="status">
          <p className="m-0 text-sm font-semibold">{copy.done}</p>
          <p className="m-0 text-sm">
            <Link to={auth.status === 'authenticated' ? '/account' : '/login'}>
              {auth.status === 'authenticated' ? 'Back to Account settings' : 'Sign in'}
            </Link>
          </p>
        </div>
      ) : (
        <div className="card form">
          {error !== null && (
            <p className="status status--bad" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="btn" disabled={state === 'busy'} onClick={() => void submit()}>
            {state === 'busy' ? 'Working…' : copy.button}
          </button>
        </div>
      )}
    </AuthLayout>
  );
}
