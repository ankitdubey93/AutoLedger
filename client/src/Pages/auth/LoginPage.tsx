import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth, useAuthActions } from '../../context/AuthContext';

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
  const [submitting, setSubmitting] = useState(false);

  // Already signed in — bounce to wherever they were headed before the
  // redirect, or the dashboard.
  if (auth.status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      // No navigate() call: the redirect above fires as soon as auth state
      // flips, so success and "already logged in" take the same path.
    } catch (err) {
      // The server answers with one message for a wrong password and an
      // unknown email alike — repeating it verbatim keeps that property.
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="shell shell--narrow">
      <header>
        <h1>Sign in</h1>
        <p className="subtitle">AutoLedger · multi-tenant ERP</p>
      </header>

      <form className="card form" onSubmit={(e) => void onSubmit(e)}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="password">Password</label>
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

        <button type="submit" className="btn" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="muted">
        No account? <Link to="/register">Create one</Link>
      </p>
    </main>
  );
}
