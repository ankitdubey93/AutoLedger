import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { requestPasswordReset } from '../../services/fetchServices';
import AuthLayout from './AuthLayout';

/**
 * Asks for a reset link. The confirmation reads the same whether or not the
 * email has an account — the server answers identically, and so does this
 * page, so neither reveals who is registered.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the reset link');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout title="Reset your password" subtitle="We'll send a link to set a new one.">
      {sent ? (
        <div className="card flex flex-col gap-2" role="status">
          <p className="m-0 text-sm font-semibold">Check your email</p>
          <p className="m-0 text-sm text-[var(--muted)]">
            If an account exists for {email.trim()}, a reset link is on its way. It works once and expires in 30 minutes.
          </p>
        </div>
      ) : (
        <form className="card form" onSubmit={(e) => void onSubmit(e)}>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          {error !== null && (
            <p className="status status--bad" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn" disabled={submitting}>
            {submitting ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
      <p className="muted m-0">
        <Link to="/login">Back to sign in</Link>
      </p>
    </AuthLayout>
  );
}
