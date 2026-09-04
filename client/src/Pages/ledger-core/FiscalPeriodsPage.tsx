import { useEffect, useState } from 'react';
import { Lock, Undo2 } from 'lucide-react';
import {
  ApiRequestError,
  closeFiscalPeriod,
  generateFiscalPeriods,
  getFiscalPeriods,
  lockFiscalPeriod,
  reopenFiscalPeriod,
  type FiscalPeriod,
} from '../../services/fetchServices';
import ConfirmDialog from './ConfirmDialog';

/**
 * Fiscal periods — the close/lock lifecycle that gates posting (Phase 4).
 *
 * LOCKED is terminal (FISCAL_PERIOD_TRANSITIONS has no outbound edge from
 * it), which is why Lock — and only Lock — is gated by a ConfirmDialog: it
 * is the one action here that cannot be undone by clicking something else.
 * Close and Reopen are both reversible and act immediately.
 *
 * No client-side role gating (the Phase 3.7 ruling): every action renders
 * for every member, and a 403 from the server renders inline.
 */

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function StatusChip({ status }: { status: FiscalPeriod['status'] }) {
  if (status === 'OPEN') {
    return (
      <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
        Open
      </span>
    );
  }
  if (status === 'CLOSED') {
    return (
      <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20">
        Closed
      </span>
    );
  }
  return (
    <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 ring-1 ring-inset ring-rose-500/20">
      Locked
    </span>
  );
}

export default function FiscalPeriodsPage() {
  const [periods, setPeriods] = useState<FiscalPeriod[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lockTarget, setLockTarget] = useState<FiscalPeriod | null>(null);

  function load() {
    setError(null);
    getFiscalPeriods()
      .then((res) => setPeriods(res.periods))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load fiscal periods');
      });
  }

  useEffect(() => {
    load();
  }, []);

  async function handleGenerate() {
    setBusyId('generate');
    setError(null);
    try {
      await generateFiscalPeriods(todayIso());
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate fiscal periods');
    } finally {
      setBusyId(null);
    }
  }

  async function handleClose(id: string) {
    setBusyId(id);
    setRowError(null);
    try {
      await closeFiscalPeriod(id);
      load();
    } catch (err) {
      const message =
        err instanceof ApiRequestError ? err.message : err instanceof Error ? err.message : 'Failed to close period';
      setRowError({ id, message });
    } finally {
      setBusyId(null);
    }
  }

  async function handleReopen(id: string) {
    setBusyId(id);
    setRowError(null);
    try {
      await reopenFiscalPeriod(id);
      load();
    } catch (err) {
      const message =
        err instanceof ApiRequestError ? err.message : err instanceof Error ? err.message : 'Failed to reopen period';
      setRowError({ id, message });
    } finally {
      setBusyId(null);
    }
  }

  async function handleLock(id: string) {
    setBusyId(id);
    setRowError(null);
    try {
      await lockFiscalPeriod(id);
      load();
    } catch (err) {
      const message =
        err instanceof ApiRequestError ? err.message : err instanceof Error ? err.message : 'Failed to lock period';
      setRowError({ id, message });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Fiscal periods</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Closing a period stops new postings dated inside it; locking is permanent.
          </p>
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {periods === null && error === null && <p className="muted">Loading…</p>}

      {periods !== null && periods.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-6 flex flex-col items-start gap-3">
          <p className="text-sm text-[var(--muted)] m-0">
            This organization has no fiscal periods yet.
          </p>
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={busyId === 'generate'}
            className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busyId === 'generate' ? 'Generating…' : 'Generate periods for this fiscal year'}
          </button>
        </div>
      )}

      {periods !== null && periods.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[40rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Period</th>
                <th className="p-3 font-medium">Range</th>
                <th className="p-3 font-medium text-right">Entries</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Closed by</th>
                <th className="p-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((period) => (
                <tr key={period.id} className="border-t border-[var(--border)] align-top">
                  <td className="p-3">
                    {period.fiscalYearLabel} · P{period.periodNumber}
                  </td>
                  <td className="p-3 text-[var(--muted)]">
                    {period.startsOn} – {period.endsOn}
                  </td>
                  <td className="p-3 text-right tabular-nums">{period.entryCount}</td>
                  <td className="p-3">
                    <StatusChip status={period.status} />
                  </td>
                  <td className="p-3 text-[var(--muted)]">{period.closedByName ?? '—'}</td>
                  <td className="p-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        {period.status === 'OPEN' && (
                          <button
                            type="button"
                            className="btn btn--ghost"
                            style={{ marginTop: 0 }}
                            disabled={busyId === period.id}
                            onClick={() => void handleClose(period.id)}
                          >
                            Close
                          </button>
                        )}
                        {period.status === 'CLOSED' && (
                          <>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              style={{ marginTop: 0 }}
                              disabled={busyId === period.id}
                              onClick={() => void handleReopen(period.id)}
                            >
                              <Undo2 size={14} aria-hidden="true" />
                              Reopen
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              style={{ marginTop: 0 }}
                              disabled={busyId === period.id}
                              onClick={() => setLockTarget(period)}
                            >
                              <Lock size={14} aria-hidden="true" />
                              Lock
                            </button>
                          </>
                        )}
                        {period.status === 'LOCKED' && (
                          <span className="text-xs text-[var(--muted)]">Locked — permanent</span>
                        )}
                      </div>
                      {rowError !== null && rowError.id === period.id && (
                        <p className="status status--bad m-0 text-xs">{rowError.message}</p>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lockTarget !== null && (
        <ConfirmDialog
          title="Lock this period?"
          body={
            <>
              Locking is permanent. A locked period can never be reopened, and no entry can ever
              be posted into it.
            </>
          }
          confirmLabel="Lock period"
          tone="danger"
          busy={busyId === lockTarget.id}
          onConfirm={() => {
            const target = lockTarget;
            setLockTarget(null);
            void handleLock(target.id);
          }}
          onCancel={() => setLockTarget(null)}
        />
      )}
    </section>
  );
}
