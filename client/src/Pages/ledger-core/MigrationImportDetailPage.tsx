import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  commitMigrationImport,
  deleteMigrationImport,
  getMigrationImport,
  getMigrationImportRows,
  patchMigrationImportRow,
  previewMigrationImport,
  type AccountType,
  type MigrationCommitPreview,
  type MigrationImport,
  type MigrationImportRow,
  type MigrationRowStatus,
} from '../../services/fetchServices';
import { useAppBasePath } from '../../apps/useAppBasePath';
import { formatCents, parseCentsInput } from '../../utils/money';
import BackLink from '../../components/BackLink';
import ConfirmDialog from '../../components/ConfirmDialog';

/**
 * One staged migration import — its rows, per-row fixes, the commit preview,
 * and the commit action itself (Phase 9b).
 *
 * The preview is shown BEFORE commit, never applied silently: a plug amount
 * headed for 3400 Opening Balance Equity is named here, not discovered
 * afterward. Commit is gated by `ConfirmDialog`, matching every other
 * irreversible action in this app.
 */

const ACCOUNT_TYPES: AccountType[] = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];
const STATUS_FILTERS: (MigrationRowStatus | '')[] = ['', 'INVALID', 'VALID', 'EXCLUDED'];
const STATUS_LABEL: Record<MigrationRowStatus, string> = { VALID: 'Valid', INVALID: 'Invalid', EXCLUDED: 'Excluded' };

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2 py-1 text-sm text-[var(--text)] w-full';

interface RowEdits {
  accountCode: string;
  accountName: string;
  accountType: AccountType | '';
  parentCode: string;
  debit: string;
  credit: string;
}

function toEdits(row: MigrationImportRow): RowEdits {
  return {
    accountCode: row.accountCode ?? '',
    accountName: row.accountName ?? '',
    accountType: row.accountType ?? '',
    parentCode: row.parentCode ?? '',
    debit: row.debitCents !== null && row.debitCents > 0 ? formatCents(row.debitCents) : '',
    credit: row.creditCents !== null && row.creditCents > 0 ? formatCents(row.creditCents) : '',
  };
}

export default function MigrationImportDetailPage() {
  const { importId } = useParams<{ importId: string }>();
  const base = useAppBasePath();
  const navigate = useNavigate();

  const [imp, setImp] = useState<MigrationImport | null>(null);
  const [rows, setRows] = useState<MigrationImportRow[] | null>(null);
  const [preview, setPreview] = useState<MigrationCommitPreview | null>(null);
  const [statusFilter, setStatusFilter] = useState<MigrationRowStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, RowEdits>>({});
  const [savingRowId, setSavingRowId] = useState<string | null>(null);
  const [showCommitConfirm, setShowCommitConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (importId === undefined) return;
    getMigrationImport(importId)
      .then((res) => setImp(res.import))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the import'));

    const rowOptions: Parameters<typeof getMigrationImportRows>[1] = { limit: 100 };
    if (statusFilter !== '') rowOptions.status = statusFilter;

    getMigrationImportRows(importId, rowOptions)
      .then((res) => {
        setRows(res.rows);
        setEdits(Object.fromEntries(res.rows.map((r) => [r.id, toEdits(r)])));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load rows'));

    previewMigrationImport(importId)
      .then((res) => setPreview(res.preview))
      .catch(() => {
        // Preview is a convenience panel — its own failure should not block
        // the rest of the page from rendering.
      });
  }, [importId, statusFilter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (importId === undefined) return <p className="status status--bad">Missing import id.</p>;
  if (error !== null && imp === null) return <p className="status status--bad">{error}</p>;
  if (imp === null || rows === null) return <p className="muted">Loading…</p>;

  // A fresh const, not `importId` itself: TS's narrowing of a destructured
  // `useParams()` field does not reliably survive into the nested async
  // functions defined below, even though this check already ran.
  const id = importId;
  const isChart = imp.kind === 'CHART_OF_ACCOUNTS';
  const readOnly = imp.status === 'COMMITTED';

  async function saveRow(row: MigrationImportRow) {
    const edit = edits[row.id];
    if (edit === undefined) return;
    setSavingRowId(row.id);
    setError(null);

    const body: Parameters<typeof patchMigrationImportRow>[2] = {};
    if (isChart) {
      body.accountCode = edit.accountCode.trim();
      body.accountName = edit.accountName.trim();
      if (edit.accountType !== '') body.accountType = edit.accountType;
      body.parentCode = edit.parentCode.trim() === '' ? null : edit.parentCode.trim();
    } else {
      body.accountCode = edit.accountCode.trim();
      const debitCents = parseCentsInput(edit.debit);
      const creditCents = parseCentsInput(edit.credit);
      if (debitCents === null || creditCents === null) {
        setError('Debit and credit must be valid amounts');
        setSavingRowId(null);
        return;
      }
      body.debitCents = debitCents;
      body.creditCents = creditCents;
    }

    try {
      await patchMigrationImportRow(id, row.id, body);
      refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the row');
    } finally {
      setSavingRowId(null);
    }
  }

  async function handleCommit() {
    setBusy(true);
    setError(null);
    try {
      await commitMigrationImport(id);
      setShowCommitConfirm(false);
      refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not commit the import');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await deleteMigrationImport(id);
      navigate(`${base}/migration-imports`, { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete the import');
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <BackLink to={`${base}/migration-imports`} label="Back to imports" />

      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">{imp.fileName}</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            {imp.kind === 'CHART_OF_ACCOUNTS' ? 'Chart of accounts' : 'Opening balances'} · {imp.status} ·{' '}
            {imp.rowCount} row{imp.rowCount === 1 ? '' : 's'}, {imp.errorCount} error
            {imp.errorCount === 1 ? '' : 's'}
          </p>
        </div>
        {!readOnly && (
          <button type="button" onClick={() => setShowDeleteConfirm(true)} className="btn btn--ghost">
            Delete import
          </button>
        )}
      </header>

      {readOnly && imp.journalEntryId !== null && (
        <div className="card">
          <p className="text-sm m-0">
            Committed. Posted as{' '}
            <a href={`${base}/journals/${imp.journalEntryId}`}>journal entry</a>.
          </p>
        </div>
      )}

      {preview !== null && !readOnly && (
        <div className="card flex flex-col gap-2">
          <h3 className="text-sm font-semibold m-0">Preview</h3>
          {imp.kind === 'CHART_OF_ACCOUNTS' ? (
            <p className="text-sm m-0">
              {preview.accountsToCreate} account{preview.accountsToCreate === 1 ? '' : 's'} will be created,{' '}
              {preview.accountsToMerge} merged into an existing account.
            </p>
          ) : preview.plugCents === 0 ? (
            <p className="text-sm m-0">This trial balance is already in balance — no plug will be posted.</p>
          ) : (
            <p className="text-sm m-0">
              An imbalance of {formatCents(Math.abs(preview.plugCents))} will be posted to{' '}
              {preview.plugAccountCode} Opening Balance Equity.
            </p>
          )}
          {!preview.canCommit && (
            <p className="text-sm text-[var(--muted)] m-0">
              Fix {preview.blockingErrorCount} invalid row{preview.blockingErrorCount === 1 ? '' : 's'} first.
            </p>
          )}
          <div>
            <button
              type="button"
              disabled={!preview.canCommit}
              onClick={() => setShowCommitConfirm(true)}
              className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Commit
            </button>
          </div>
        </div>
      )}

      {error !== null && <p className="status status--bad">{error}</p>}

      <label className="flex flex-col gap-1 text-sm max-w-xs">
        <span className="text-[var(--muted)]">Filter by status</span>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as MigrationRowStatus | '')}
          className={inputClass}
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === '' ? 'All rows' : STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm min-w-[50rem]">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className="p-2 font-medium">Row</th>
              <th className="p-2 font-medium">Code</th>
              {isChart ? (
                <>
                  <th className="p-2 font-medium">Name</th>
                  <th className="p-2 font-medium">Type</th>
                  <th className="p-2 font-medium">Parent</th>
                </>
              ) : (
                <>
                  <th className="p-2 font-medium">Debit</th>
                  <th className="p-2 font-medium">Credit</th>
                </>
              )}
              <th className="p-2 font-medium">Status</th>
              <th className="p-2 font-medium">Errors</th>
              {!readOnly && <th className="p-2 font-medium" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const edit = edits[row.id] ?? toEdits(row);
              return (
                <tr key={row.id} className="border-t border-[var(--border)] align-top">
                  <td className="p-2">{row.rowNumber}</td>
                  <td className="p-2">
                    {readOnly ? (
                      row.accountCode ?? '—'
                    ) : (
                      <input
                        type="text"
                        value={edit.accountCode}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [row.id]: { ...edit, accountCode: e.target.value } }))}
                        className={inputClass}
                      />
                    )}
                  </td>
                  {isChart ? (
                    <>
                      <td className="p-2">
                        {readOnly ? (
                          row.accountName ?? '—'
                        ) : (
                          <input
                            type="text"
                            value={edit.accountName}
                            onChange={(e) => setEdits((prev) => ({ ...prev, [row.id]: { ...edit, accountName: e.target.value } }))}
                            className={inputClass}
                          />
                        )}
                      </td>
                      <td className="p-2">
                        {readOnly ? (
                          row.accountType ?? '—'
                        ) : (
                          <select
                            value={edit.accountType}
                            onChange={(e) => setEdits((prev) => ({ ...prev, [row.id]: { ...edit, accountType: e.target.value as AccountType | '' } }))}
                            className={inputClass}
                          >
                            <option value="">—</option>
                            {ACCOUNT_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="p-2">
                        {readOnly ? (
                          row.parentCode ?? '—'
                        ) : (
                          <input
                            type="text"
                            value={edit.parentCode}
                            onChange={(e) => setEdits((prev) => ({ ...prev, [row.id]: { ...edit, parentCode: e.target.value } }))}
                            className={inputClass}
                          />
                        )}
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="p-2">
                        {readOnly ? (
                          row.debitCents !== null && row.debitCents > 0 ? formatCents(row.debitCents) : '—'
                        ) : (
                          <input
                            inputMode="decimal"
                            value={edit.debit}
                            onChange={(e) => setEdits((prev) => ({ ...prev, [row.id]: { ...edit, debit: e.target.value } }))}
                            className={inputClass}
                          />
                        )}
                      </td>
                      <td className="p-2">
                        {readOnly ? (
                          row.creditCents !== null && row.creditCents > 0 ? formatCents(row.creditCents) : '—'
                        ) : (
                          <input
                            inputMode="decimal"
                            value={edit.credit}
                            onChange={(e) => setEdits((prev) => ({ ...prev, [row.id]: { ...edit, credit: e.target.value } }))}
                            className={inputClass}
                          />
                        )}
                      </td>
                    </>
                  )}
                  <td className="p-2">
                    <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                      {STATUS_LABEL[row.status]}
                    </span>
                  </td>
                  <td className="p-2 text-xs text-[var(--bad)]">
                    {row.errors.length === 0 ? '—' : row.errors.join('; ')}
                  </td>
                  {!readOnly && (
                    <td className="p-2">
                      <button
                        type="button"
                        disabled={savingRowId === row.id}
                        onClick={() => void saveRow(row)}
                        className="btn btn--ghost"
                      >
                        {savingRowId === row.id ? 'Saving…' : 'Save'}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showCommitConfirm && (
        <ConfirmDialog
          title="Commit this import?"
          body="This creates accounts and posts to the ledger. It cannot be undone by editing — only by a reversing entry."
          confirmLabel="Commit"
          busy={busy}
          onConfirm={() => void handleCommit()}
          onCancel={() => setShowCommitConfirm(false)}
        />
      )}

      {showDeleteConfirm && (
        <ConfirmDialog
          title="Delete this import?"
          body="Every staged row is removed. This cannot be undone."
          confirmLabel="Delete"
          tone="danger"
          busy={busy}
          onConfirm={() => void handleDelete()}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </section>
  );
}
