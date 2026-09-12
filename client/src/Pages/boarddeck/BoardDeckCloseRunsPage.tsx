import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import {
  closeBoardDeckPeriod,
  createBoardDeckCloseRun,
  getBoardDeckCloseRun,
  getFiscalPeriods,
  listBoardDeckCloseRuns,
  rerunBoardDeckCloseRun,
  type BoardDeckCloseRun,
  type BoardDeckCloseRunDetail,
  type FiscalPeriod,
} from '../../services/fetchServices';
import { useAuth } from '../../context/AuthContext';
import ConfirmDialog from '../../components/ConfirmDialog';

const CHECK_LABELS: Record<string, string> = {
  PERIOD_OPEN: 'Period is open',
  TRIAL_BALANCE_BALANCED: 'Trial balance is balanced',
  NO_DRAFT_INVOICES: 'No DRAFT invoices',
  NO_UNPOSTED_BILLS: 'No unposted bills',
  NO_UNMATCHED_BANK_LINES: 'No unmatched bank lines',
};

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

/**
 * The monthly close checklist: run five readiness checks against a
 * LedgerCore fiscal period, re-run them after fixing what failed, and close
 * the period once every check passes.
 *
 * Closing the period is OWNER/ADMIN only and HIDDEN (not merely disabled)
 * for anyone else — the posture UniteconSettingsPage established — and
 * gated by ConfirmDialog since it writes to LedgerCore's fiscal-period
 * lifecycle on the caller's behalf.
 */
export default function BoardDeckCloseRunsPage() {
  const auth = useAuth();
  const role = auth.status === 'authenticated' ? auth.role : null;
  const canClose = role === 'OWNER' || role === 'ADMIN';

  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [runs, setRuns] = useState<BoardDeckCloseRun[]>([]);
  const [selectedPeriodId, setSelectedPeriodId] = useState('');
  const [detail, setDetail] = useState<BoardDeckCloseRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);

  function reload() {
    setError(null);
    Promise.all([getFiscalPeriods(), listBoardDeckCloseRuns()])
      .then(([periodsRes, runsRes]) => {
        setPeriods(periodsRes.periods);
        setRuns(runsRes.closeRuns);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load close runs'));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleRun() {
    if (selectedPeriodId === '') return;
    setBusy(true);
    setError(null);
    try {
      const res = await createBoardDeckCloseRun(selectedPeriodId);
      setDetail(res.closeRun);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not run close checks');
    } finally {
      setBusy(false);
    }
  }

  async function handleOpen(run: BoardDeckCloseRun) {
    setError(null);
    try {
      const res = await getBoardDeckCloseRun(run.id);
      setDetail(res.closeRun);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this close run');
    }
  }

  async function handleRerun() {
    if (detail === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await rerunBoardDeckCloseRun(detail.id);
      setDetail(res.closeRun);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not re-run checks');
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmClose() {
    if (detail === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await closeBoardDeckPeriod(detail.id);
      setDetail(res.closeRun);
      setConfirmingClose(false);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not close the period');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold m-0">Monthly close</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Five readiness checks against a fiscal period, run before closing the books.
        </p>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--muted)]">Fiscal period</span>
          <select value={selectedPeriodId} onChange={(e) => setSelectedPeriodId(e.target.value)} className={inputClass}>
            <option value="">Select…</option>
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fiscalYearLabel} — period {p.periodNumber} ({p.startsOn} to {p.endsOn})
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn" disabled={busy || selectedPeriodId === ''} onClick={handleRun}>
          {busy ? 'Running…' : 'Run close checks'}
        </button>
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className="p-3 font-medium">Period</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 font-medium">Ran</th>
              <th className="p-3 font-medium">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} className="border-t border-[var(--border)]">
                <td className="p-3">
                  {run.periodStartsOn} to {run.periodEndsOn}
                </td>
                <td className="p-3">{run.status}</td>
                <td className="p-3">{run.ranByName ?? '—'}</td>
                <td className="p-3">
                  <button type="button" className="btn btn--ghost" onClick={() => handleOpen(run)}>
                    View
                  </button>
                </td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td className="p-3 text-sm text-[var(--muted)]" colSpan={4}>
                  No close runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {detail !== null && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold m-0">
              {detail.periodStartsOn} to {detail.periodEndsOn} — {detail.status}
            </h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy || detail.status === 'CLOSED'}
                onClick={handleRerun}
              >
                Re-run checks
              </button>
              {canClose && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy || detail.status !== 'READY'}
                  onClick={() => setConfirmingClose(true)}
                >
                  Close period
                </button>
              )}
            </div>
          </div>

          <ul className="flex flex-col gap-2 m-0 p-0 list-none">
            {detail.checks.map((check) => (
              <li key={check.kind} className="flex items-start gap-2 text-sm">
                {check.result === 'PASS' ? (
                  <CheckCircle2 size={16} className="text-emerald-500 shrink-0 mt-0.5" aria-hidden="true" />
                ) : (
                  <XCircle size={16} className="text-red-500 shrink-0 mt-0.5" aria-hidden="true" />
                )}
                <span>
                  {CHECK_LABELS[check.kind] ?? check.kind}
                  {check.result === 'FAIL' && check.detail !== '' && (
                    <span className="text-[var(--muted)]"> — {check.detail}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirmingClose && detail !== null && (
        <ConfirmDialog
          title="Close this period?"
          body={
            <>
              Closing {detail.periodStartsOn} to {detail.periodEndsOn} prevents any further postings into it
              until it is reopened in LedgerCore.
            </>
          }
          confirmLabel="Close period"
          tone="danger"
          busy={busy}
          onConfirm={handleConfirmClose}
          onCancel={() => setConfirmingClose(false)}
        />
      )}
    </section>
  );
}
