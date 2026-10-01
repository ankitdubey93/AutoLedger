import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  commitMigrationImport,
  deleteMigrationImport,
  getMigrationImport,
  getMigrationImportRows,
  patchMigrationImportRow,
  previewMigrationImport,
  setMigrationImportRowsStatus,
  type MigrationCommitPreview,
  type MigrationCommitResult,
  type MigrationImport,
  type MigrationImportRow,
  type MigrationRowStatus,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { safeReturnTo } from '../../utils/safeReturnTo';
import BackLink from '../../components/BackLink';
import ConfirmDialog from '../../components/ConfirmDialog';
import LoadingState from '../../components/ui/LoadingState';
import Pagination from '../../components/ui/Pagination';
import ImportGuidePanel from './imports/ImportGuidePanel';
import ImportRowsTable from './imports/ImportRowsTable';
import ImportSteps from './imports/ImportSteps';
import { useImportKinds } from './imports/useImportKinds';

/**
 * One staged migration import — its rows, per-row fixes, the commit preview,
 * and the commit action itself (Phase 9b).
 *
 * The preview is shown BEFORE commit, never applied silently: a plug amount
 * headed for 3400 Opening Balance Equity is named here, not discovered
 * afterward. Commit is gated by `ConfirmDialog`, matching every other
 * irreversible action in this app.
 */

const STATUS_FILTERS: (MigrationRowStatus | '')[] = ['', 'INVALID', 'VALID', 'EXCLUDED'];
const STATUS_LABEL: Record<MigrationRowStatus, string> = { VALID: 'Valid', INVALID: 'Invalid', EXCLUDED: 'Excluded' };

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2 py-1 text-sm text-[var(--text)] w-full';

function committedMessage(result: Exclude<MigrationCommitResult, { kind: 'OPENING_BALANCES' }>): string {
  switch (result.kind) {
    case 'INVOICES':
    case 'BILLS':
      return `Committed: ${String(result.documentCount)} ${result.kind === 'INVOICES' ? 'invoices' : 'expenses'} ${result.mode === 'DRAFT' ? 'created as drafts' : 'posted'} (${String(result.lineCount)} lines).`;
    case 'JOURNALS':
      return `Committed: ${String(result.entryCount)} journal entries posted (${String(result.lineCount)} lines).`;
    case 'ITEMS':
      return `Committed: ${String(result.createdCount)} created, ${String(result.mergedCount)} filled in.`;
    case 'INVENTORY_ITEMS':
      return `Committed: ${String(result.createdCount)} items created, opening stock posted for ${String(result.openingStockCount)}.`;
    default:
      return `Committed: ${String(result.createdCount)} created, ${String(result.mergedCount)} merged.`;
  }
}

export default function MigrationImportDetailPage() {
  const { importId } = useParams<{ importId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { kinds } = useImportKinds();

  const [imp, setImp] = useState<MigrationImport | null>(null);
  const [rows, setRows] = useState<MigrationImportRow[] | null>(null);
  const [preview, setPreview] = useState<MigrationCommitPreview | null>(null);
  const [statusFilter, setStatusFilter] = useState<MigrationRowStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [paging, setPaging] = useState({ totalCount: 0, totalPages: 1 });
  const [savingRowId, setSavingRowId] = useState<string | null>(null);
  const [showCommitConfirm, setShowCommitConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [commitMode, setCommitMode] = useState<'DRAFT' | 'POST'>('DRAFT');
  const [dateChoice, setDateChoice] = useState<'OWN' | 'ON'>('OWN');
  const [postingDate, setPostingDate] = useState('');

  // Document imports (invoices, expenses) offer a commit mode; the options only apply once the
  // import's own kind says so and it was not staged in conversion mode.
  const optionsActive =
    imp !== null &&
    !imp.conversionMode &&
    (kinds?.find((k) => k.kind === imp.kind)?.commitModes.length ?? 0) > 0;

  const refresh = useCallback(() => {
    if (importId === undefined) return;
    getMigrationImport(importId)
      .then((res) => setImp(res.import))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the import'));

    const rowOptions: Parameters<typeof getMigrationImportRows>[1] = { page, limit: 50 };
    if (statusFilter !== '') rowOptions.status = statusFilter;

    getMigrationImportRows(importId, rowOptions)
      .then((res) => {
        setRows(res.rows);
        setPaging({ totalCount: res.totalCount, totalPages: res.totalPages });
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load rows'));

    const previewParams: NonNullable<Parameters<typeof previewMigrationImport>[2]> = {};
    if (commitMode === 'POST') {
      previewParams.mode = 'POST';
      if (dateChoice === 'ON' && postingDate !== '') previewParams.postingDate = postingDate;
    } else if (optionsActive) {
      previewParams.mode = 'DRAFT';
    }
    previewMigrationImport(importId, undefined, previewParams)
      .then((res) => setPreview(res.preview))
      .catch(() => {
        // Preview is a convenience panel — its own failure should not block
        // the rest of the page from rendering.
      });
  }, [importId, statusFilter, page, commitMode, dateChoice, postingDate, optionsActive]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (importId === undefined) return <p className="status status--bad">Missing import id.</p>;
  if (error !== null && imp === null) return <p className="status status--bad">{error}</p>;
  const meta = imp === null ? undefined : kinds?.find((k) => k.kind === imp.kind);
  if (imp === null || rows === null || meta === undefined) return <LoadingState />;

  // A fresh const, not `importId` itself: TS's narrowing of a destructured
  // `useParams()` field does not reliably survive into the nested async
  // functions defined below, even though this check already ran.
  const id = importId;
  const isParty = imp.kind === 'CUSTOMERS' || imp.kind === 'VENDORS';
  const readOnly = imp.status === 'COMMITTED';
  const returnTo = safeReturnTo(searchParams.get('returnTo'));
  const hasCommitModes = meta.commitModes.length > 0;
  const isInvoices = imp.kind === 'INVOICES';
  const documentsPosting = hasCommitModes && (imp.conversionMode || commitMode === 'POST');

  async function saveRow(
    row: MigrationImportRow,
    body: Record<string, string | number | null | Record<string, string | null>>,
  ) {
    setSavingRowId(row.id);
    setError(null);
    try {
      await patchMigrationImportRow(id, row.id, body);
      refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the row');
    } finally {
      setSavingRowId(null);
    }
  }

  async function setGroupStatus(rowIds: string[], status: 'VALID' | 'EXCLUDED') {
    setError(null);
    try {
      await setMigrationImportRowsStatus(id, { rowIds, status });
      refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not update the rows');
    }
  }

  async function handleCommit() {
    setBusy(true);
    setError(null);
    try {
      if (hasCommitModes && !imp?.conversionMode) {
        await commitMigrationImport(id, {
          mode: commitMode,
          ...(commitMode === 'POST' && dateChoice === 'ON' && postingDate !== '' ? { postingDate } : {}),
        });
      } else {
        await commitMigrationImport(id);
      }
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
      navigate('/migration-imports', { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete the import');
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <BackLink to={returnTo ?? '/migration-imports'} label={returnTo !== null ? 'Back' : 'Back to imports'} />
      <ImportSteps current={imp.status === 'COMMITTED' ? 4 : 3} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">{imp.fileName}</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            {meta.label} · {imp.status} ·{' '}
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
            <a href={`/journals/${imp.journalEntryId}`}>journal entry</a>.
          </p>
        </div>
      )}

      {readOnly && imp.result !== null && imp.result.kind !== 'OPENING_BALANCES' && (
        <div className="card">
          <p className="text-sm m-0">
            {committedMessage(imp.result)}
          </p>
        </div>
      )}

      {preview !== null && !readOnly && (
        <div className="card flex flex-col gap-2">
          <h3 className="text-sm font-semibold m-0">Preview</h3>
          {preview.summary.length > 0 ? (
            <dl className="text-sm m-0 grid grid-cols-[auto_auto] gap-x-4 gap-y-1 justify-start">
              {preview.summary.map((item) => (
                <div key={item.label} className="contents">
                  <dt className="text-[var(--muted)]">{item.label}</dt>
                  <dd className="m-0">{item.format === 'money' ? formatCents(item.value) : String(item.value)}</dd>
                </div>
              ))}
            </dl>
          ) : imp.kind === 'CHART_OF_ACCOUNTS' ? (
            <p className="text-sm m-0">
              {preview.accountsToCreate} account{preview.accountsToCreate === 1 ? '' : 's'} will be created,{' '}
              {preview.accountsToMerge} merged into an existing account.
            </p>
          ) : isParty ? (
            <p className="text-sm m-0">
              {preview.partiesToCreate} will be created, {preview.partiesToMerge} will be merged into existing
              records.
            </p>
          ) : preview.plugCents === 0 ? (
            <p className="text-sm m-0">This trial balance is already in balance — no plug will be posted.</p>
          ) : (
            <p className="text-sm m-0">
              An imbalance of {formatCents(Math.abs(preview.plugCents))} will be posted to{' '}
              {preview.plugAccountCode} Opening Balance Equity.
            </p>
          )}
          {preview.warnings.map((w) => (
            <p key={w} className="status status--warn">
              {w}
            </p>
          ))}
          {!preview.canCommit && (
            <p className="text-sm text-[var(--muted)] m-0">
              Fix {preview.blockingErrorCount} invalid row{preview.blockingErrorCount === 1 ? '' : 's'} first.
            </p>
          )}
          {hasCommitModes && imp.conversionMode && (
            <p className="text-sm m-0">
              Conversion mode — documents post on your conversion date to 3400 Opening Balance Equity.
            </p>
          )}
          {hasCommitModes && !imp.conversionMode && (
            <div className="flex flex-col gap-2">
              <div role="radiogroup" aria-label="How to import" className="flex flex-col gap-1 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="commit-mode"
                    value="DRAFT"
                    checked={commitMode === 'DRAFT'}
                    onChange={() => setCommitMode('DRAFT')}
                  />
                  Import as drafts
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="commit-mode"
                    value="POST"
                    checked={commitMode === 'POST'}
                    onChange={() => setCommitMode('POST')}
                  />
                  Import and post
                </label>
                <span className="text-xs text-[var(--muted)]">
                  {isInvoices ? 'Issues the invoices' : 'Approves the expenses'}
                </span>
              </div>
              {commitMode === 'POST' && (
                <div role="radiogroup" aria-label="Posting date" className="flex flex-col gap-1 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="posting-date-choice"
                      value="OWN"
                      checked={dateChoice === 'OWN'}
                      onChange={() => setDateChoice('OWN')}
                    />
                    Each document's own date
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="posting-date-choice"
                      value="ON"
                      checked={dateChoice === 'ON'}
                      onChange={() => setDateChoice('ON')}
                    />
                    On this date
                    <input
                      type="date"
                      aria-label="Posting date"
                      value={postingDate}
                      onChange={(e) => {
                        setPostingDate(e.target.value);
                        setDateChoice('ON');
                      }}
                      className={inputClass + ' !w-auto'}
                    />
                  </label>
                </div>
              )}
            </div>
          )}
          <div>
            <button
              type="button"
              disabled={!preview.canCommit}
              onClick={() => setShowCommitConfirm(true)}
              className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
          onChange={(e) => {
            setStatusFilter(e.target.value as MigrationRowStatus | '');
            setPage(1);
          }}
          className={inputClass}
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === '' ? 'All rows' : STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>

      <ImportRowsTable
        meta={meta}
        rows={rows}
        readOnly={readOnly}
        savingRowId={savingRowId}
        onSave={(row, body) => void saveRow(row, body)}
        onError={setError}
        onSetGroupStatus={(rowIds, status) => void setGroupStatus(rowIds, status)}
      />

      <Pagination
        page={page}
        totalPages={paging.totalPages}
        shownCount={rows.length}
        totalCount={paging.totalCount}
        noun="rows"
        onPageChange={setPage}
      />
      </div>

      <ImportGuidePanel kind={imp.kind} />
      </div>

      {showCommitConfirm && (
        <ConfirmDialog
          title="Commit this import?"
          body={
            hasCommitModes
              ? `This creates ${String(preview?.summary[0]?.value ?? imp.validCount)} ${documentsPosting ? 'posted' : 'draft'} document(s).${documentsPosting ? ' It cannot be undone by editing — only by a reversing entry.' : ''}`
              : 'This creates accounts and posts to the ledger. It cannot be undone by editing — only by a reversing entry.'
          }
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
