import { useEffect, useState } from 'react';
import { FileStack } from 'lucide-react';
import {
  createPaymentTerm,
  listPaymentTerms,
  updatePaymentTerm,
  type PaymentTerm,
} from '../../services/fetchServices';
import SettingsTabs from './SettingsTabs';
import PageHeader from '../../components/ui/PageHeader';
import { inputClass } from '../../components/ui/formClasses';

/**
 * The payment terms catalogue — Phase 24's selectable due-date terms, managed
 * from Settings. Every organization starts with the seven standards
 * (seeded at registration); a standard term can be deactivated but not
 * renamed or re-dated, so a custom one is added here instead.
 */

function PaymentTermForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [netDays, setNetDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createPaymentTerm({
        code: code.trim(),
        name: name.trim(),
        netDays: Number(netDays),
      });
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the payment term');
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"
    >
      <h3 className="text-sm font-semibold m-0">New payment term</h3>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm w-32">
          <span className="text-[var(--muted)]">Code</span>
          <input
            type="text"
            required
            maxLength={30}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="NET_21"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-40">
          <span className="text-[var(--muted)]">Name</span>
          <input
            type="text"
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Net 21"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm w-28">
          <span className="text-[var(--muted)]">Net days</span>
          <input
            type="number"
            required
            min={0}
            max={365}
            value={netDays}
            onChange={(e) => setNetDays(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || code.trim() === '' || name.trim() === '' || netDays.trim() === ''}
          className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Creating…' : 'Create payment term'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="btn btn--ghost">
          Cancel
        </button>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
    </form>
  );
}

export default function PaymentTermsSettingsPage() {
  const [terms, setTerms] = useState<PaymentTerm[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let ignore = false;

    listPaymentTerms({ includeInactive: true })
      .then((res) => {
        if (!ignore) setTerms(res.paymentTerms);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load payment terms');
      });

    return () => {
      ignore = true;
    };
  }, [reloadToken]);

  async function toggleActive(term: PaymentTerm) {
    try {
      await updatePaymentTerm(term.id, { isActive: !term.isActive });
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not update the payment term');
    }
  }

  return (
    <section className="flex flex-col gap-4 max-w-2xl">
      <PageHeader as="h2" icon={FileStack} title="Settings" />

      <SettingsTabs />

      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <p className="text-sm text-[var(--muted)] m-0">
          The terms invoices and bills can derive their due date from.
        </p>
        <button
          type="button"
          onClick={() => setShowForm((open) => !open)}
          className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors"
        >
          New payment term
        </button>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}

      {showForm && (
        <PaymentTermForm
          onCreated={() => {
            setShowForm(false);
            setReloadToken((t) => t + 1);
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {terms === null && error === null && <p className="muted">Loading…</p>}

      {terms !== null && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[36rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Code</th>
                <th className="p-3 font-medium">Name</th>
                <th className="p-3 font-medium text-right">Net days</th>
                <th className="p-3 font-medium">Source</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {terms.map((term) => (
                <tr key={term.id} className="border-t border-[var(--border)]">
                  <td className="p-3">{term.code}</td>
                  <td className="p-3">{term.name}</td>
                  <td className="p-3 text-right tabular-nums">{term.netDays}</td>
                  <td className="p-3">{term.isSystem ? 'Standard' : 'Custom'}</td>
                  <td className="p-3">
                    {term.isActive ? (
                      <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Active</span>
                    ) : (
                      <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20">
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-right">
                    <button type="button" onClick={() => void toggleActive(term)} className="btn btn--ghost">
                      {term.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
