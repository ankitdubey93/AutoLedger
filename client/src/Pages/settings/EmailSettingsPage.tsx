import { useEffect, useState, type FormEvent } from 'react';
import { Mail } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import LoadingState from '../../components/ui/LoadingState';
import {
  ApiRequestError,
  getEmailSettings,
  updateEmailSettings,
  type OrganizationEmailSettings,
} from '../../services/fetchServices';
import { inputClass, primaryButtonClass } from '../../components/ui/formClasses';

const TRANSPORT_NOTE: Record<OrganizationEmailSettings['transport'], string> = {
  brevo: 'Emails are delivered through Brevo.',
  mailpit: 'Development: emails are caught by the local Mailpit inbox, not delivered.',
  log: 'Development: emails are written to the server log, not delivered.',
};

/**
 * Organization settings → Email (Phase 38b): how email sent on this
 * organization's behalf (invitations, approval requests) presents itself.
 * The From address is the platform's verified sender and cannot change;
 * the display name and the reply-to address can.
 */
export default function EmailSettingsPage() {
  const [settings, setSettings] = useState<OrganizationEmailSettings | null>(null);
  const [senderName, setSenderName] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let ignore = false;
    getEmailSettings()
      .then((res) => {
        if (ignore) return;
        setSettings(res.settings);
        setSenderName(res.settings.senderName ?? '');
        setReplyTo(res.settings.replyTo ?? '');
      })
      .catch((err: unknown) => {
        if (ignore) return;
        if (err instanceof ApiRequestError && err.status === 403) setDenied(true);
        else setError(err instanceof Error ? err.message : 'Could not load email settings');
      });
    return () => {
      ignore = true;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await updateEmailSettings({
        senderName: senderName.trim() === '' ? null : senderName.trim(),
        replyTo: replyTo.trim() === '' ? null : replyTo.trim(),
      });
      setSettings(res.settings);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        as="h2"
        icon={Mail}
        title="Email"
        subtitle="How invitations and notifications from this organization appear in people's inboxes."
      />
      {denied && <p className="muted">Email settings are managed by owners and admins.</p>}
      {!denied && settings === null && error === null && <LoadingState />}
      {settings !== null && (
        <form className="card flex flex-col gap-3 max-w-xl" onSubmit={(e) => void onSubmit(e)}>
          <label className="flex flex-col gap-1 text-sm">
            Sender name
            <input
              className={inputClass}
              maxLength={100}
              placeholder="AutoLedger"
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Reply-to address
            <input
              type="email"
              className={inputClass}
              placeholder="Replies go nowhere unless you set this"
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
            />
          </label>
          <p className="muted text-sm m-0">
            Sent from <code>{settings.fromEmail}</code>. {TRANSPORT_NOTE[settings.transport]}
          </p>
          {error !== null && (
            <p className="status status--bad" role="alert">
              {error}
            </p>
          )}
          {saved && <p className="status status--good">Saved.</p>}
          <div>
            <button type="submit" className={primaryButtonClass} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
      {settings === null && error !== null && (
        <p className="status status--bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
