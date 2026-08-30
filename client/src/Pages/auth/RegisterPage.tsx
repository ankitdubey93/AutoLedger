import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth, useAuthActions } from '../../context/AuthContext';

/**
 * Creates a user, their organization, and the OWNER membership binding them —
 * one server-side transaction (docs/architecture.md: an ERP is operated by a
 * company, so there is no such thing as a user without an organization).
 *
 * The organization name is asked for here rather than in a second onboarding
 * step precisely because the two must be created atomically.
 */
export default function RegisterPage() {
  const auth = useAuth();
  const { register } = useAuthActions();

  const [name, setName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (auth.status === 'authenticated') return <Navigate to="/" replace />;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // register() also logs in, so the user experiences one action.
      await register({ name, email, password, organizationName });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create your account');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="shell shell--narrow">
      <header>
        <h1>Create your organization</h1>
        <p className="subtitle">You will be its owner.</p>
      </header>

      <form className="card form" onSubmit={(e) => void onSubmit(e)}>
        <label htmlFor="organizationName">Organization name</label>
        <input
          id="organizationName"
          required
          minLength={2}
          value={organizationName}
          onChange={(e) => setOrganizationName(e.target.value)}
        />

        <label htmlFor="name">Your name</label>
        <input
          id="name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

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
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {/* The 72-byte ceiling is bcrypt's, and the server rejects anything over it. */}
        <p className="muted">At least 8 characters.</p>

        {error !== null && (
          <p className="status status--bad" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create account'}
        </button>
      </form>

      <p className="muted">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </main>
  );
}
