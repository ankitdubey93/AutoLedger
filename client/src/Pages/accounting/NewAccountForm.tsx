import { useState } from 'react';
import {
  createAccount,
  type Account,
  type AccountType,
  type BankAccountKind,
  type CashFlowCategory,
} from '../../services/fetchServices';

/**
 * The chart-of-accounts create form.
 *
 * The five account types here are the same five `ACCOUNT_TYPES` the server's
 * zod schema and the `accounts` table's CHECK constraint enforce — one list,
 * four enforcement points (guardrails rule 12), never a sixth.
 *
 * Changing the type clears the selected parent: a parent of a different type
 * is rejected by the server with a documented 422, so keeping a stale
 * selection around would just relocate the error from here to the submit.
 *
 * `initialType` (Phase 30) lets a caller — `ChartSettingsPage`'s per-type
 * "Add account" row — seed the type select without forking this component.
 * It defaults to `'Asset'`, so `AccountsPage`'s existing usage (which never
 * passes it) is unchanged.
 */

export const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'] as const;

/**
 * Phase 45 — the cash flow category choices. `''` is "Automatic" (sent as null,
 * derived from the account's type and code). Shared with ChartSettingsPage.
 */
export const CASH_FLOW_OPTIONS: { value: '' | CashFlowCategory; label: string }[] = [
  { value: '', label: 'Automatic' },
  { value: 'CASH', label: 'Cash' },
  { value: 'OPERATING', label: 'Operating' },
  { value: 'INVESTING', label: 'Investing' },
  { value: 'FINANCING', label: 'Financing' },
];

/** Phase 45 — the cash flow category is offered only on balance-sheet accounts. */
export function hasCashFlowCategory(type: AccountType): boolean {
  return type === 'Asset' || type === 'Liability' || type === 'Equity';
}

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

export default function NewAccountForm({
  accounts,
  initialType = 'Asset',
  onCreated,
  onCancel,
}: {
  accounts: Account[];
  initialType?: AccountType;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>(initialType);
  const [parentId, setParentId] = useState('');
  // Phase 44 — a bank account is an Asset, a credit card account a Liability.
  const [bankAccountKind, setBankAccountKind] = useState<BankAccountKind | null>(null);
  // Phase 45 — '' is Automatic.
  const [cashFlowCategory, setCashFlowCategory] = useState<'' | CashFlowCategory>('');
  const [isPostable, setIsPostable] = useState(true);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parentOptions = accounts.filter((a) => a.type === type && !a.isPostable);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createAccount({
        code: code.trim(),
        name: name.trim(),
        type,
        parentId: parentId === '' ? null : parentId,
        bankAccountKind,
        // Sent only when the field is shown; Revenue and Expense omit the key.
        ...(hasCashFlowCategory(type)
          ? { cashFlowCategory: cashFlowCategory === '' ? null : cashFlowCategory }
          : {}),
        isPostable,
        description: description.trim() === '' ? null : description.trim(),
      });
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the account');
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"
    >
      <h3 className="text-sm font-semibold m-0">New account</h3>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Code</span>
          <input
            type="text"
            required
            maxLength={20}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6130"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
          <span className="text-[var(--muted)]">Name</span>
          <input
            type="text"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Marketing & Advertising"
            className={inputClass}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Type</span>
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value as AccountType);
              setParentId('');
              setBankAccountKind(null);
              setCashFlowCategory('');
            }}
            className={inputClass}
          >
            {ACCOUNT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
          <span className="text-[var(--muted)]">Parent</span>
          <select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            className={inputClass}
          >
            <option value="">No parent (top level)</option>
            {parentOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {type === 'Asset' && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Bank account</span>
          <select
            value={bankAccountKind === 'BANK' ? 'BANK' : ''}
            onChange={(e) => setBankAccountKind(e.target.value === 'BANK' ? 'BANK' : null)}
            className={inputClass}
          >
            <option value="">None</option>
            <option value="BANK">Bank account</option>
          </select>
        </label>
      )}

      {type === 'Liability' && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Credit card</span>
          <select
            value={bankAccountKind === 'CREDIT_CARD' ? 'CREDIT_CARD' : ''}
            onChange={(e) => setBankAccountKind(e.target.value === 'CREDIT_CARD' ? 'CREDIT_CARD' : null)}
            className={inputClass}
          >
            <option value="">None</option>
            <option value="CREDIT_CARD">Credit card</option>
          </select>
        </label>
      )}

      {hasCashFlowCategory(type) && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Cash flow category</span>
          <select
            value={cashFlowCategory}
            onChange={(e) => setCashFlowCategory(e.target.value as '' | CashFlowCategory)}
            className={inputClass}
          >
            {CASH_FLOW_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
        <input
          type="checkbox"
          checked={isPostable}
          onChange={(e) => setIsPostable(e.target.checked)}
        />
        Can be posted to
      </label>
      <p className="text-xs text-[var(--muted)] m-0 -mt-2">
        Unchecked makes this a header account that rolls up its children and cannot receive
        journal lines.
      </p>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Description (optional)</span>
        <input
          type="text"
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputClass}
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || code.trim() === '' || name.trim() === ''}
          className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Creating…' : 'Create account'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="btn btn--ghost"
        >
          Cancel
        </button>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
    </form>
  );
}
