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
import PlaceholderPicker from '../../components/placeholders/PlaceholderPicker';
import PlaceholderHints from '../../components/placeholders/PlaceholderHints';
import { usePlaceholderTarget } from '../../utils/usePlaceholderTarget';
import { formatCents, parseCentsInput } from '../../utils/money';
import { useTableSort } from '../../utils/useTableSort';
import { useClientPage } from '../../utils/useClientPage';
import SortableHeader from '../../components/ui/SortableHeader';
import Pagination from '../../components/ui/Pagination';
import LoadingState from '../../components/ui/LoadingState';

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
  // Typed as money ("450.50"), converted to cents on submit — never sent as typed.
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [bankAccountId, setBankAccountId] = useState('');
  const [targetAccountId, setTargetAccountId] = useState(prefill?.account || '');
  const [description, setDescription] = useState('');
  const placeholderTarget = usePlaceholderTarget('description');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const postableAccounts = accounts.filter((a) => a.isPostable && a.isActive);
  const bankAccounts = accounts.filter((a) => a.type === 'Asset' && a.isActive);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const amountMinCents = amountMin.trim() === '' ? null : parseCentsInput(amountMin);
    const amountMaxCents = amountMax.trim() === '' ? null : parseCentsInput(amountMax);
    if ((amountMin.trim() !== '' && amountMinCents === null) || (amountMax.trim() !== '' && amountMaxCents === null)) {
      setError('Enter amounts like 450 or 450.50');
      return;
    }
    if (amountMinCents !== null && amountMaxCents !== null && amountMinCents > amountMaxCents) {
      setError('Min amount cannot be more than max amount');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input: BankRuleInput = {
        name: name.trim(),
        priority: Number(priority),
        direction,
        memoContains: memoContains.trim(),
        amountMinCents,
        amountMaxCents,
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
            type="text"
            inputMode="decimal"
            value={amountMin}
            onChange={(e) => setAmountMin(e.target.value)}
            placeholder="(any)"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm w-28">
          <span className="text-[var(--muted)]">Max amount</span>
          <input
            type="text"
            inputMode="decimal"
            value={amountMax}
            onChange={(e) => setAmountMax(e.target.value)}
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

      <div className="flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="bank-rule-description" className="text-[var(--muted)]">
            Description (optional)
          </label>
          <PlaceholderPicker surface="BANK_LINE" onInsert={placeholderTarget.insert} />
        </div>
        <input
          id="bank-rule-description"
          type="text"
          maxLength={200}
          {...placeholderTarget.bind('description', setDescription)}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Bank fee [Month]"
          className={inputClass}
        />
        <PlaceholderHints text={description} surface="BANK_LINE" />
      </div>

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
  const { sorted: sortedRules, sort, toggle: toggleSort } = useTableSort(
    rules,
    {
      priority: (row: BankRule) => row.priority,
      name: (row: BankRule) => row.name,
      memo: (row: BankRule) => row.memoContains,
      direction: (row: BankRule) => row.direction,
      amount: (row: BankRule) => row.amountMinCents ?? row.amountMaxCents,
      postsTo: (row: BankRule) => row.targetAccountCode,
      status: (row: BankRule) => (row.isActive ? 0 : 1),
    },
    // Rules apply in priority order, so that is the natural default.
    { key: 'priority', direction: 'asc' },
  );
  const paged = useClientPage(sortedRules);
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

      {rules === null && error === null && <LoadingState />}

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
                    <SortableHeader label="Priority" sortKey="priority" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Memo contains" sortKey="memo" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Direction" sortKey="direction" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Amount range" sortKey="amount" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Posts to" sortKey="postsTo" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
                    <th className="p-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(paged.pageRows ?? []).map((rule) => {
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
          {paged.pageRows !== null && (
            <Pagination
              page={paged.page}
              totalPages={paged.totalPages}
              shownCount={paged.pageRows.length}
              totalCount={paged.totalCount}
              noun="rules"
              onPageChange={paged.setPage}
            />
          )}
        </>
      )}
    </section>
  );
}
