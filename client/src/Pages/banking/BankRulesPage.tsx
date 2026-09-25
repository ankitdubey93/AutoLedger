import { useEffect, useState } from 'react';
import { Filter } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import {
  applyBankRules,
  createBankRule,
  listBankRules,
  updateBankRule,
  type BankRule,
  type BankRuleInput,
} from '../../services/fetchServices';
import { listAccounts, type Account } from '../../services/fetchServices';
import PageHeader from '../../components/ui/PageHeader';
import { inputClass } from '../../components/ui/formClasses';
import { formatCents } from '../../utils/money';

function BankRuleForm({
  accounts,
  onCreated,
  onCancel,
  prefill,
}: {
  accounts: Account[];
  onCreated: () => void;
  onCancel: () => void;
  prefill?: { memo?: string; account?: string; direction?: 'IN' | 'OUT' | 'ANY' };
}) {
  const [name, setName] = useState(prefill?.memo ? `Rule: ${prefill.memo}` : '');
  const [priority, setPriority] = useState('100');
  const [direction, setDirection] = useState<'IN' | 'OUT' | 'ANY'>(prefill?.direction || 'ANY');
  const [memoContains, setMemoContains] = useState(prefill?.memo || '');
  const [amountMinCents, setAmountMinCents] = useState('');
  const [amountMaxCents, setAmountMaxCents] = useState('');
  const [bankAccountId, setBankAccountId] = useState('');
  const [targetAccountId, setTargetAccountId] = useState(prefill?.account || '');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const postableAccounts = accounts.filter((a) => a.isPostable && a.isActive);
  const bankAccounts = accounts.filter((a) => a.type === 'Asset' && a.isActive);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input: BankRuleInput = {
        name: name.trim(),
        priority: Number(priority),
        direction,
        memoContains: memoContains.trim(),
        amountMinCents: amountMinCents.trim() === '' ? null : Number(amountMinCents),
        amountMaxCents: amountMaxCents.trim() === '' ? null : Number(amountMaxCents),
        bankAccountId: bankAccountId === '' ? null : bankAccountId,
        targetAccountId,
        description: description.trim() === '' ? null : description.trim(),
      };
      await createBankRule(input);
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the bank rule');
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"
    >
      <h3 className="text-sm font-semibold m-0">New bank rule</h3>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm w-32">
          <span className="text-[var(--muted)]">Priority</span>
          <input
            type="number"
            required
            min="0"
            max="10000"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-40">
          <span className="text-[var(--muted)]">Name</span>
          <input
            type="text"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Rule name"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm w-32">
          <span className="text-[var(--muted)]">Direction</span>
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as 'IN' | 'OUT' | 'ANY')}
            className={inputClass}
          >
            <option value="ANY">Any</option>
            <option value="IN">In</option>
            <option value="OUT">Out</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-40">
          <span className="text-[var(--muted)]">Memo contains</span>
          <input
            type="text"
            required
            maxLength={100}
            value={memoContains}
            onChange={(e) => setMemoContains(e.target.value)}
            placeholder="Text to match"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm w-28">
          <span className="text-[var(--muted)]">Min amount</span>
          <input
            type="number"
            min="0"
            value={amountMinCents}
            onChange={(e) => setAmountMinCents(e.target.value)}
            placeholder="(any)"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm w-28">
          <span className="text-[var(--muted)]">Max amount</span>
          <input
            type="number"
            min="0"
            value={amountMaxCents}
            onChange={(e) => setAmountMaxCents(e.target.value)}
            placeholder="(any)"
            className={inputClass}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-40">
          <span className="text-[var(--muted)]">Bank account (optional)</span>
          <select
            value={bankAccountId}
            onChange={(e) => setBankAccountId(e.target.value)}
            className={inputClass}
          >
            <option value="">Any bank account</option>
            {bankAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-40">
          <span className="text-[var(--muted)]">Posts to *</span>
          <select
            value={targetAccountId}
            onChange={(e) => setTargetAccountId(e.target.value)}
            required
            className={inputClass}
          >
            <option value="">Select an account…</option>
            {postableAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Description (optional)</span>
        <input
          type="text"
          maxLength={200}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Journal entry description"
          className={inputClass}
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || name.trim() === '' || memoContains.trim() === '' || targetAccountId === ''}
          className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Creating…' : 'Create rule'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="btn btn--ghost">
          Cancel
        </button>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
    </form>
  );
}

export default function BankRulesPage() {
  const [searchParams] = useSearchParams();
  const [rules, setRules] = useState<BankRule[] | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Extract prefill from query string
  const prefill: { memo?: string; account?: string; direction?: 'IN' | 'OUT' | 'ANY' } = {};
  const memoParam = searchParams.get('memo');
  if (memoParam) prefill.memo = memoParam;
  const accountParam = searchParams.get('account');
  if (accountParam) prefill.account = accountParam;
  const directionParam = searchParams.get('direction');
  if (directionParam === 'IN' || directionParam === 'OUT' || directionParam === 'ANY') {
    prefill.direction = directionParam;
  }

  useEffect(() => {
    let ignore = false;

    Promise.all([
      listBankRules(true).then((res) => res.bankRules),
      listAccounts().then((res) => res.accounts),
    ])
      .then(([rulesData, accountsData]) => {
        if (!ignore) {
          setRules(rulesData);
          setAccounts(accountsData);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load data');
      });

    return () => {
      ignore = true;
    };
  }, [reloadToken]);

  async function toggleActive(rule: BankRule) {
    try {
      await updateBankRule(rule.id, { isActive: !rule.isActive });
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not update the rule');
    }
  }

  async function handleApplyRules() {
    setApplyBusy(true);
    setError(null);
    try {
      const res = await applyBankRules();
      setAppliedCount(res.appliedCount);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not apply rules');
    } finally {
      setApplyBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <PageHeader as="h2" icon={Filter} title="Bank rules" />

      <p className="text-sm text-[var(--muted)] m-0">
        Automatically settle bank lines that match a pattern by posting a journal entry.
      </p>

      <div className="flex items-center gap-3 flex-wrap justify-between">
        <button
          type="button"
          onClick={() => setShowForm((open) => !open)}
          className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors"
        >
          New rule
        </button>
        <button
          type="button"
          onClick={() => void handleApplyRules()}
          disabled={applyBusy}
          className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40"
        >
          {applyBusy ? 'Applying…' : 'Apply to unmatched lines'}
        </button>
      </div>

      {appliedCount !== null && (
        <p className="status status--good">Settled {appliedCount} line(s)</p>
      )}

      {error !== null && <p className="status status--bad">{error}</p>}

      {showForm && accounts !== null && (
        <BankRuleForm
          accounts={accounts}
          prefill={prefill}
          onCreated={() => {
            setShowForm(false);
            setReloadToken((t) => t + 1);
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {rules === null && error === null && <p className="muted">Loading…</p>}

      {rules !== null && (
        <>
          {rules.length === 0 ? (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 text-center">
              <p className="text-sm text-[var(--muted)] m-0">No rules yet. Create one to get started.</p>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[56rem]">
                <thead>
                  <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                    <th className="p-3 font-medium">Priority</th>
                    <th className="p-3 font-medium">Name</th>
                    <th className="p-3 font-medium">Memo contains</th>
                    <th className="p-3 font-medium">Direction</th>
                    <th className="p-3 font-medium">Amount range</th>
                    <th className="p-3 font-medium">Posts to</th>
                    <th className="p-3 font-medium">Status</th>
                    <th className="p-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => {
                    const amountRange =
                      rule.amountMinCents === null && rule.amountMaxCents === null
                        ? 'Any'
                        : rule.amountMinCents === null
                          ? `≤ ${formatCents(rule.amountMaxCents!)}`
                          : rule.amountMaxCents === null
                            ? `≥ ${formatCents(rule.amountMinCents)}`
                            : `${formatCents(rule.amountMinCents)} – ${formatCents(rule.amountMaxCents)}`;

                    return (
                      <tr key={rule.id} className="border-t border-[var(--border)]">
                        <td className="p-3 tabular-nums">{rule.priority}</td>
                        <td className="p-3">{rule.name}</td>
                        <td className="p-3 text-xs font-mono">{rule.memoContains}</td>
                        <td className="p-3">{rule.direction}</td>
                        <td className="p-3">{amountRange}</td>
                        <td className="p-3">
                          {rule.targetAccountCode} {rule.targetAccountName}
                        </td>
                        <td className="p-3">
                          {rule.isActive ? (
                            <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Active</span>
                          ) : (
                            <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20">
                              Inactive
                            </span>
                          )}
                        </td>
                        <td className="p-3 text-right">
                          <button type="button" onClick={() => void toggleActive(rule)} className="btn btn--ghost">
                            {rule.isActive ? 'Deactivate' : 'Reactivate'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
