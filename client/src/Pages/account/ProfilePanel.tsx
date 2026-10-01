import { useState, type FormEvent } from 'react';
import { checkSession, requestEmailChange, resendVerification, updateProfile } from '../../services/fetchServices';
import { useAuth, useAuthActions } from '../../context/AuthContext';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../components/ui/formClasses';

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Account settings → Profile: your name (editable) and identity details. */
export default function ProfilePanel() {
  const auth = useAuth();
  const { applySession } = useAuthActions();
  const user = auth.status === 'authenticated' ? auth.user : null;

  const [name, setName] = useState(user?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user === null) return null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await updateProfile({ name: name.trim() });
      // Re-read the session so the top bar and every other consumer of
      // AuthContext pick up the new name.
      applySession(await checkSession());
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your profile');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <h2>Profile</h2>
      <form className="flex flex-col gap-3 max-w-md" onSubmit={(e) => void onSubmit(e)}>
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input className={inputClass} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error !== null && (
          <p className="status status--bad" role="alert">
            {error}
          </p>
        )}
        {saved && <p className="status status--good">Saved.</p>}
        <div>
          <button type="submit" className={primaryButtonClass} disabled={saving || name.trim() === (user.name ?? '')}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>

      <dl className="mt-4">
        <dt>Email</dt>
        <dd>{user.email}</dd>
        <dt>Email verified</dt>
        <dd>{user.emailVerified ? 'Yes' : <ResendVerification />}</dd>
        <dt>Account created</dt>
        <dd>{formatDay(user.createdAt)}</dd>
      </dl>

      <ChangeEmailForm currentEmail={user.email} />
    </section>
  );
}

/** Phase 38b — "Not verified" plus a way to get a fresh link. */
function ResendVerification() {
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    setState('busy');
    setError(null);
    try {
      await resendVerification();
      setState('sent');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the email');
      setState('idle');
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="muted">Not verified</span>
      {state === 'sent' ? (
        <span className="status status--good">Verification email sent — check your inbox.</span>
      ) : (
        <button type="button" className={secondaryButtonClass} disabled={state === 'busy'} onClick={() => void resend()}>
          {state === 'busy' ? 'Sending…' : 'Send verification email'}
        </button>
      )}
      {error !== null && <span className="status status--bad">{error}</span>}
    </span>
  );
}

/**
 * Phase 38b — change the sign-in email. Needs the current password; a link
 * goes to the new address and nothing changes until it is opened.
 */
function ChangeEmailForm({ currentEmail }: { currentEmail: string }) {
  const [open, setOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await requestEmailChange({ newEmail: newEmail.trim(), currentPassword });
      setSentTo(newEmail.trim());
      setNewEmail('');
      setCurrentPassword('');
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the change');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      {sentTo !== null && (
        <p className="status status--good" role="status">
          We sent a confirmation link to {sentTo}. Your sign-in email stays {currentEmail} until you open it.
        </p>
      )}
      {!open ? (
        <button type="button" className={secondaryButtonClass} onClick={() => setOpen(true)}>
          Change email
        </button>
      ) : (
        <form className="flex flex-col gap-3 max-w-md" onSubmit={(e) => void onSubmit(e)}>
          <h3 className="m-0 text-sm font-semibold">Change sign-in email</h3>
          <label className="flex flex-col gap-1 text-sm">
            New email
            <input
              type="email"
              required
              autoComplete="email"
              className={inputClass}
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Current password
            <input
              type="password"
              required
              autoComplete="current-password"
              className={inputClass}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </label>
          {error !== null && (
            <p className="status status--bad" role="alert">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={busy}>
              {busy ? 'Sending…' : 'Send confirmation link'}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
