import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { listAccounts, importBankStatement, type Account, type DateFormat } from '../../services/fetchServices';
import { useAppBasePath } from '../../apps/useAppBasePath';
import BackLink from './BackLink';

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
}

export default function BankImportPage() {
  const base = useAppBasePath();
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

    const closingBalanceCents =
      closingBalance.trim() === '' ? null : Math.round(Number(closingBalance) * 100);

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
      });
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
    <section className="flex flex-col gap-4 max-w-2xl">
      <BackLink to={`${base}/bank`} label="Back to bank lines" />

      <header>
        <h2 className="text-lg font-semibold m-0">Import bank statement</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Upload a CSV export from your bank. Re-importing the same statement is safe — duplicate
          lines are skipped automatically.
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
            </p>
            <Link to={`${base}/bank`} className="text-sm mt-2 inline-block">
              Review the approval queue →
            </Link>
          </div>
        )}

        <div>
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Importing…' : 'Import statement'}
          </button>
        </div>
      </form>
    </section>
  );
}
