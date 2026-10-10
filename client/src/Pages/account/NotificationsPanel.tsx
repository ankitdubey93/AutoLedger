import { useEffect, useState } from 'react';
import {
  getNotificationPreferences,
  setNotificationPreferences,
  type NotificationEvent,
  type NotificationPreference,
} from '../../services/fetchServices';
import LoadingState from '../../components/ui/LoadingState';

const LABELS: Record<NotificationEvent, { title: string; detail: string }> = {
  bill_awaiting_approval: {
    title: 'Bills awaiting approval',
    detail: 'When someone submits a bill in an organization where you can approve bills.',
  },
  invitation_accepted: {
    title: 'Invitations accepted',
    detail: 'When someone you invited joins the organization.',
  },
  quote_responded: {
    title: 'Quotes accepted or declined',
    detail: 'When a customer or vendor answers a quote you sent, or a colleague records their answer.',
  },
};

/**
 * Account settings → Notifications (Phase 38b). Per person, not per
 * organization: these switches cover every organization you belong to.
 * Security emails (password reset, email change) are always sent.
 */
export default function NotificationsPanel() {
  const [prefs, setPrefs] = useState<NotificationPreference[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<NotificationEvent | null>(null);

  useEffect(() => {
    let ignore = false;
    getNotificationPreferences()
      .then((res) => {
        if (!ignore) setPrefs(res.preferences);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load your notification settings');
      });
    return () => {
      ignore = true;
    };
  }, []);

  async function toggle(event: NotificationEvent, enabled: boolean) {
    setSaving(event);
    setError(null);
    try {
      setPrefs((await setNotificationPreferences([{ event, enabled }])).preferences);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="card">
      <h2>Email notifications</h2>
      <p className="muted text-sm">For every organization you belong to. Security emails are always sent.</p>
      {error !== null && (
        <p className="status status--bad" role="alert">
          {error}
        </p>
      )}
      {prefs === null && error === null && <LoadingState />}
      {prefs !== null && (
        <ul className="list-none m-0 p-0 flex flex-col gap-3">
          {prefs.map((p) => (
            <li key={p.event}>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={p.enabled}
                  disabled={saving === p.event}
                  onChange={(e) => void toggle(p.event, e.target.checked)}
                />
                <span>
                  <span className="block font-medium">{LABELS[p.event].title}</span>
                  <span className="block muted text-sm">{LABELS[p.event].detail}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
