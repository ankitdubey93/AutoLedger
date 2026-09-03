import { useState } from 'react';
import { createAccount, type Account, type AccountType } from '../../services/fetchServices';

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
 */

const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'] as const;

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

export default function NewAccountForm({
  accounts,
  onCreated,
  onCancel,
}: {
  accounts: Account[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('Asset');
  const [parentId, setParentId] = useState('');
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
          className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
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
