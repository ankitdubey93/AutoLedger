import { useState, type FormEvent } from 'react';
import { changePassword } from '../../services/fetchServices';
import { inputClass, primaryButtonClass } from '../../components/ui/formClasses';

/**
 * Account settings → Password. Needs the current password, and signs every
 * other browser out — this one stays signed in.
 */
export default function ChangePasswordPanel() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm !== '' && confirm !== newPassword;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mismatch) return;
    setSaving(true);
    setDone(null);
    setError(null);
    try {
      const res = await changePassword({ currentPassword, newPassword });
      setDone(res.signedOutSessions);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change your password');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <h2>Change password</h2>
      <form className="flex flex-col gap-3 max-w-md" onSubmit={(e) => void onSubmit(e)}>
        <label className="flex flex-col gap-1 text-sm">
          Current password
          <input
            type="password"
            autoComplete="current-password"
            required
            className={inputClass}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          New password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            className={inputClass}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            required
            className={inputClass}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        {mismatch && <p className="status status--bad">The two new passwords do not match.</p>}
        <p className="muted text-sm m-0">At least 8 characters. Every other device you are signed in on will be signed out.</p>
        {error !== null && (
          <p className="status status--bad" role="alert">
            {error}
          </p>
        )}
        {done !== null && (
          <p className="status status--good" role="status">
            Password changed.{done > 0 ? ` Signed out of ${String(done)} other session${done === 1 ? '' : 's'}.` : ''}
          </p>
        )}
        <div>
          <button type="submit" className={primaryButtonClass} disabled={saving || mismatch}>
            {saving ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </section>
  );
}
