import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listAccounts,
  importBankStatement,
  listBankImports,
  deleteBankImport,
  type Account,
  type BankStatementImport,
  type DateFormat,
} from '../../services/fetchServices';
import BackLink from '../../components/BackLink';
import ConfirmDialog from '../../components/ConfirmDialog';
import { parseCentsInput } from '../../utils/money';
import { formatDate } from '../../utils/date';

/**
 * Upload a bank statement CSV. The file's text goes straight into the JSON
 * body — never a multipart upload — matching the server's `MAX_CSV_CHARS`
 * cap under the 1MB JSON body limit (guardrails rule 14: no dependency, no
 * file storage before Phase 10 owns that).
 */

const MAX_CSV_CHARS = 900_000;

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

interface ImportSummary {
  importedCount: number;
  duplicateCount: number;
  suggestedCount: number;
  autoMatchableCount: number;
  ruleMatchedCount: number;
  previouslyDeletedCount: number;
}

export default function BankImportPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [dateFormat, setDateFormat] = useState<DateFormat>('ISO');
  const [showColumnMap, setShowColumnMap] = useState(false);
  const [dateColumn, setDateColumn] = useState('');
  const [descriptionColumn, setDescriptionColumn] = useState('');
  const [amountColumn, setAmountColumn] = useState('');
  const [debitColumn, setDebitColumn] = useState('');
  const [creditColumn, setCreditColumn] = useState('');
  const [referenceColumn, setReferenceColumn] = useState('');
  const [closingBalance, setClosingBalance] = useState('');
  const [closingBalanceOn, setClosingBalanceOn] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [imports, setImports] = useState<BankStatementImport[]>([]);
  const [importsError, setImportsError] = useState<string | null>(null);
  const [importsToken, setImportsToken] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<BankStatementImport | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    listAccounts()
      .then((res) => {
        if (ignore) return;
        setAccounts(res.accounts.filter((a) => a.isPostable && a.type === 'Asset' && a.isActive));
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load accounts');
      });
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    listBankImports({ limit: 20 })
      .then((res) => {
        if (ignore) return;
        setImports(res.imports);
        setImportsError(null);
      })
      .catch((err: unknown) => {
        if (!ignore) setImportsError(err instanceof Error ? err.message : 'Could not load statements');
      });
    return () => {
      ignore = true;
    };
  }, [importsToken]);

  async function submitDeleteImport(target: BankStatementImport): Promise<void> {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteBankImport(target.id, null);
      setDeleteTarget(null);
      setImportsToken((t) => t + 1);
    } catch (err: unknown) {
      setDeleteTarget(null);
      setDeleteError(err instanceof Error ? err.message : 'Could not delete that statement');
    } finally {
      setDeleteBusy(false);
    }
  }

  function handleFile(file: File) {
    setError(null);
    setSummary(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      if (text.length > MAX_CSV_CHARS) {
        setError('That file is too large to import — split it by month.');
        setContent('');
        return;
      }
      setContent(text);
    };
    reader.onerror = () => {
      setError('Could not read that file.');
    };
    reader.readAsText(file);
  }

  const canSubmit = accountId !== '' && content !== '' && !busy;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    // A closing balance may be negative (an overdrawn account); parseCentsInput
    // only takes magnitudes, so the sign is split off first.
    let closingBalanceCents: number | null = null;
    const trimmedBalance = closingBalance.trim();
    if (trimmedBalance !== '') {
      const negative = trimmedBalance.startsWith('-');
      const magnitude = parseCentsInput(negative ? trimmedBalance.slice(1) : trimmedBalance);
      if (magnitude === null) {
        setError('Enter the closing balance like 1250.00 or -80.50');
        return;
      }
      closingBalanceCents = negative ? -magnitude : magnitude;
    }

    setBusy(true);
    setError(null);
    setSummary(null);

    const columnMap =
      showColumnMap && dateColumn.trim() !== '' && descriptionColumn.trim() !== ''
        ? {
            date: dateColumn.trim(),
            description: descriptionColumn.trim(),
            amount: amountColumn.trim() === '' ? null : amountColumn.trim(),
            debit: debitColumn.trim() === '' ? null : debitColumn.trim(),
            credit: creditColumn.trim() === '' ? null : creditColumn.trim(),
            reference: referenceColumn.trim() === '' ? null : referenceColumn.trim(),
          }
        : null;

    try {
      const res = await importBankStatement({
        accountId,
        fileName: fileName === '' ? 'statement.csv' : fileName,
        content,
        dateFormat,
        columnMap,
        closingBalanceCents,
        closingBalanceOn: closingBalanceCents === null ? null : closingBalanceOn || null,
      });
      setSummary({
        importedCount: res.importedCount,
        duplicateCount: res.duplicateCount,
        suggestedCount: res.suggestedCount,
        autoMatchableCount: res.autoMatchableCount,
        ruleMatchedCount: res.ruleMatchedCount,
        previouslyDeletedCount: res.previouslyDeletedCount,
      });
      setImportsToken((t) => t + 1);
      setContent('');
      setFileName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not import the statement');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <BackLink to="/bank" label="Back to bank lines" />

      <header>
        <h2 className="text-lg font-semibold m-0">Import bank statement</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Upload a CSV export from your bank. Re-importing the same statement is safe — duplicate
          lines are skipped automatically. Or{' '}
          <Link to="/settings/connections" className="underline">
            import automatically from a Drive folder
          </Link>
          .
        </p>
      </header>

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Bank account</span>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputClass}>
            <option value="">Select an account…</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} · {account.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Statement file (CSV)</span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file !== undefined) handleFile(file);
            }}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Date format</span>
          <select
            value={dateFormat}
            onChange={(e) => setDateFormat(e.target.value as DateFormat)}
            className={inputClass}
          >
            <option value="ISO">ISO — 2026-03-09</option>
            <option value="DMY">Day/Month/Year — 09/03/2026</option>
            <option value="MDY">Month/Day/Year — 03/09/2026</option>
          </select>
        </label>

        <details
          open={showColumnMap}
          onToggle={(e) => setShowColumnMap(e.currentTarget.open)}
          className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3"
        >
          <summary className="cursor-pointer text-sm font-medium">Column mapping (optional)</summary>
          <p className="text-xs text-[var(--muted)] mt-2 mb-3">
            Left blank, columns are detected automatically by header name (Date, Description, Amount, or
            Debit/Credit).
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Date column</span>
              <input
                type="text"
                value={dateColumn}
                onChange={(e) => setDateColumn(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Description column</span>
              <input
                type="text"
                value={descriptionColumn}
                onChange={(e) => setDescriptionColumn(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Amount column</span>
              <input
                type="text"
                value={amountColumn}
                onChange={(e) => setAmountColumn(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Reference column</span>
              <input
                type="text"
                value={referenceColumn}
                onChange={(e) => setReferenceColumn(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Debit column</span>
              <input
                type="text"
                value={debitColumn}
                onChange={(e) => setDebitColumn(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Credit column</span>
              <input
                type="text"
                value={creditColumn}
                onChange={(e) => setCreditColumn(e.target.value)}
                className={inputClass}
              />
            </label>
          </div>
        </details>

        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Statement closing balance (optional)</span>
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={closingBalance}
              onChange={(e) => setClosingBalance(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">as of</span>
            <input
              type="date"
              value={closingBalanceOn}
              onChange={(e) => setClosingBalanceOn(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        {error !== null && <p className="status status--bad">{error}</p>}

        {summary !== null && (
          <div className="card">
            <p className="text-sm m-0">
              Imported {summary.importedCount} line{summary.importedCount === 1 ? '' : 's'}, skipped{' '}
              {summary.duplicateCount} duplicate{summary.duplicateCount === 1 ? '' : 's'}.{' '}
              {summary.suggestedCount} line{summary.suggestedCount === 1 ? '' : 's'} got a suggested match,{' '}
              {summary.autoMatchableCount} ready for one-click accept.
              {summary.ruleMatchedCount > 0 && ` ${summary.ruleMatchedCount} settled by bank rules.`}
            </p>
            {summary.previouslyDeletedCount > 0 && (
              <p className="text-sm m-0 mt-2">
                {summary.previouslyDeletedCount} previously deleted lines were skipped — restore them from the Deleted tab
              </p>
            )}
            <Link to="/bank" className="text-sm mt-2 inline-block">
              Review the approval queue →
            </Link>
          </div>
        )}

        <div>
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Importing…' : 'Import statement'}
          </button>
        </div>
      </form>

      <section className="flex flex-col gap-3">
        <h3 className="text-base font-semibold m-0">Recent statements</h3>
        {importsError !== null && <p className="status status--bad">{importsError}</p>}
        {deleteError !== null && <p className="status status--bad">{deleteError}</p>}
        {imports.length === 0 && importsError === null && (
          <p className="text-sm text-[var(--muted)] m-0">No statements imported yet.</p>
        )}
        {imports.map((imp) => (
          <div
            key={imp.id}
            className="flex items-center gap-3 flex-wrap rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3"
          >
            <span className="text-sm flex-1 min-w-40">
              {imp.fileName} · {imp.accountCode} {imp.accountName}
            </span>
            <span className="text-sm text-[var(--muted)] tabular-nums">{formatDate(imp.createdAt.slice(0, 10))}</span>
            <span className="text-sm text-[var(--muted)]">
              {imp.importedCount} imported · {imp.duplicateCount} duplicate{imp.duplicateCount === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              disabled={deleteBusy}
              onClick={() => setDeleteTarget(imp)}
              className="btn btn--ghost"
            >
              Delete statement
            </button>
          </div>
        ))}
      </section>

      {deleteTarget !== null && (
        <ConfirmDialog
          title="Delete this statement?"
          body="Its unreconciled lines leave the approval queue and can be restored from the Deleted tab. The import record itself is kept."
          confirmLabel="Delete"
          tone="danger"
          busy={deleteBusy}
          onConfirm={() => void submitDeleteImport(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </section>
  );
}
