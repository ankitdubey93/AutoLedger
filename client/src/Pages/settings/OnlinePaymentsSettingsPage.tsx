import { useEffect, useState } from 'react';
import { CreditCard } from 'lucide-react';
import {
  getOnlinePaymentSettings,
  listAccounts,
  updateOnlinePaymentSettings,
  type Account,
  type OnlinePaymentSettings,
} from '../../services/fetchServices';
import PageHeader from '../../components/ui/PageHeader';
import { inputClass, primaryButtonClass } from '../../components/ui/formClasses';

/**
 * Online payments (Phase 39c): whether an emailed customer statement offers
 * "Review and pay" by card, and the Asset account card receipts are deposited
 * into — typically a "Stripe clearing" account, reconciled against Stripe's
 * payouts to the bank like any other clearing account.
 */
export default function OnlinePaymentsSettingsPage() {
  const [settings, setSettings] = useState<OnlinePaymentSettings | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [depositAccountId, setDepositAccountId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([getOnlinePaymentSettings(), listAccounts()])
      .then(([s, a]) => {
        setSettings(s);
        setEnabled(s.enabled);
        setDepositAccountId(s.depositAccountId ?? '');
        setAccounts(a.accounts);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load settings'));
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await updateOnlinePaymentSettings({
        enabled,
        depositAccountId: depositAccountId === '' ? null : depositAccountId,
      });
      setSettings(next);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  const options = accounts.filter(
    (a) => a.id === depositAccountId || (a.type === 'Asset' && a.isPostable && a.isActive),
  );

  return (
    <section className="flex flex-col gap-4 max-w-xl">
      <PageHeader
        as="h2"
        icon={CreditCard}
        title="Online payments"
        subtitle="Let customers pay their statement by card from the emailed link."
      />
      {error !== null && <p className="status status--bad">{error}</p>}
      {settings === null && error === null && <div className="skeleton skeleton--card" aria-busy="true" />}
      {settings !== null && (
        <div className="flex flex-col gap-4">
          {!settings.providerConfigured && (
            <p className="status status--bad m-0">
              Card payments are not configured on this server (Stripe keys are missing). You can save these settings, but
              statement links will not offer card payment until an administrator adds them.
            </p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Offer card payment on emailed customer statements
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Deposit card payments into</span>
            <select value={depositAccountId} onChange={(e) => setDepositAccountId(e.target.value)} className={inputClass}>
              <option value="">Not set</option>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-[var(--muted)]">
              An Asset account, e.g. a “Stripe clearing” account. Each card payment is recorded as a customer receipt into it.
            </span>
          </label>
          {saved && <p className="status status--good m-0">Saved.</p>}
          <div>
            <button
              type="button"
              className={primaryButtonClass}
              disabled={saving || (enabled && depositAccountId === '')}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
