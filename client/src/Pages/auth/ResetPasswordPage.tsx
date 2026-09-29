import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { resetPassword } from '../../services/fetchServices';
import AuthLayout from './AuthLayout';

/**
 * Sets a new password from the emailed link (`/reset-password?token=…`).
 * A successful reset signs the account out everywhere, so the next step is
 * always a fresh sign-in.
 */
export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirm) {
      setError('The two passwords do not match');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset the password');
    } finally {
      setSubmitting(false);
    }
  }

  if (token === '') {
    return (
      <AuthLayout title="Reset your password" subtitle="This page needs the link from your email.">
        <p className="status status--bad m-0">The reset link is missing its token.</p>
        <p className="muted m-0">
          <Link to="/forgot-password">Request a new link</Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password" subtitle="Signing in again is required on every device afterwards.">
      {done ? (
        <div className="card flex flex-col gap-2" role="status">
          <p className="m-0 text-sm font-semibold">Password updated</p>
          <p className="m-0 text-sm text-[var(--muted)]">
            <Link to="/login">Sign in with your new password</Link>
          </p>
        </div>
      ) : (
        <form className="card form" onSubmit={(e) => void onSubmit(e)}>
          <label htmlFor="password">New password</label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <label htmlFor="confirm">Confirm new password</label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <p className="muted">At least 8 characters.</p>
          {error !== null && (
            <p className="status status--bad" role="alert">
              {error}{' '}
              {/expired|invalid/.test(error) && <Link to="/forgot-password">Request a new link</Link>}
            </p>
          )}
          <button type="submit" className="btn" disabled={submitting}>
            {submitting ? 'Saving…' : 'Set new password'}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
