import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useAuth, useAuthActions } from '../../context/AuthContext';
import AuthLayout from './AuthLayout';

/**
 * The demo organization built by `npm run seed:demo`. Offered only when a
 * deployment sets both variables — they are public by design (Vite inlines
 * them into the bundle), which is fine for a demo account and nothing else.
 */
const DEMO_EMAIL = import.meta.env.VITE_DEMO_EMAIL;
const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD;
const DEMO_ENABLED = Boolean(DEMO_EMAIL) && Boolean(DEMO_PASSWORD);

/**
 * Controlled inputs throughout: React state is the single source of truth for
 * the field values, which is what makes the submit handler able to validate
 * and disable without reading the DOM.
 */
export default function LoginPage() {
  const auth = useAuth();
  const { login } = useAuthActions();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<'form' | 'demo' | null>(null);

  // Already signed in — bounce to wherever they were headed before the
  // redirect, or the dashboard.
  if (auth.status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  async function signIn(which: 'form' | 'demo', signInEmail: string, signInPassword: string) {
    setError(null);
    setSubmitting(which);
    try {
      await login(signInEmail, signInPassword);
      // No navigate() call: the redirect above fires as soon as auth state
      // flips, so success and "already logged in" take the same path.
    } catch (err) {
      // The server answers with one message for a wrong password and an
      // unknown email alike — repeating it verbatim keeps that property.
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setSubmitting(null);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void signIn('form', email, password);
  }

  return (
    <AuthLayout title="Sign in" subtitle="Welcome back to AutoLedger.">
      {DEMO_ENABLED && (
        <section className="card flex flex-col gap-3" aria-labelledby="demo-heading">
          <div>
            <p id="demo-heading" className="m-0 text-sm font-semibold text-[var(--text)]">
              Explore the demo company
            </p>
            <p className="m-0 mt-1 text-sm text-[var(--muted)]">
              Harbor Point Fabrication — four months of invoices, bills, bank reconciliation and inventory, already entered.
            </p>
          </div>
          <button
            type="button"
            className="btn !mt-0 inline-flex items-center justify-center gap-2"
            disabled={submitting !== null}
            onClick={() => void signIn('demo', DEMO_EMAIL ?? '', DEMO_PASSWORD ?? '')}
          >
            {submitting === 'demo' ? 'Opening the demo…' : 'Open the demo'}
            {submitting !== 'demo' && <ArrowRight size={15} aria-hidden="true" />}
          </button>
        </section>
      )}

      {DEMO_ENABLED && (
        <p className="m-0 flex items-center gap-3 text-xs text-[var(--muted)] before:h-px before:flex-1 before:bg-[var(--border)] after:h-px after:flex-1 after:bg-[var(--border)]">
          or sign in to your organization
        </p>
      )}

      <form className="card form" onSubmit={onSubmit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <span className="flex items-baseline justify-between">
          <label htmlFor="password">Password</label>
          <Link to="/forgot-password" className="text-xs">
            Forgot password?
          </Link>
        </span>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error !== null && (
          <p className="status status--bad" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn" disabled={submitting !== null}>
          {submitting === 'form' ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="muted m-0">
        No account? <Link to="/register">Create one</Link>
      </p>
    </AuthLayout>
  );
}
