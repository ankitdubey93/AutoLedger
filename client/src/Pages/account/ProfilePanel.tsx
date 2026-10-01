import { useState, type FormEvent } from 'react';
import { checkSession, updateProfile } from '../../services/fetchServices';
import { useAuth, useAuthActions } from '../../context/AuthContext';
import { inputClass, primaryButtonClass } from '../../components/ui/formClasses';

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
        <dd>{user.emailVerified ? 'Yes' : <span className="muted">Not verified</span>}</dd>
        <dt>Account created</dt>
        <dd>{formatDay(user.createdAt)}</dd>
      </dl>
    </section>
  );
}
