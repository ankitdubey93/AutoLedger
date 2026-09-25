import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Play, Pause, StopCircle } from 'lucide-react';
import {
  ApiRequestError,
  getRecurringSchedule,
  runRecurringSchedule,
  pauseRecurringSchedule,
  resumeRecurringSchedule,
  endRecurringSchedule,
  type RecurringScheduleDetail,
} from '../../services/fetchServices';
import BackLink from '../../components/BackLink';
import ConfirmDialog from '../../components/ConfirmDialog';

/**
 * Phase 34b — one recurring schedule detail. Shows the template, runs,
 * and state transitions.
 */

function frequencyLabel(frequency: string, intervalCount: number): string {
  const plural = intervalCount > 1 ? 's' : '';
  if (frequency === 'WEEKLY') return `Every ${intervalCount} week${plural}`;
  if (frequency === 'MONTHLY') return `Every ${intervalCount} month${plural}`;
  if (frequency === 'QUARTERLY') return `Every ${intervalCount} quarter${plural}`;
  return `Every ${intervalCount} year${plural}`;
}

function kindLabel(kind: string): string {
  if (kind === 'INVOICE') return 'Invoice';
  if (kind === 'BILL') return 'Bill';
  return 'Journal';
}

function documentLink(schedule: RecurringScheduleDetail): string {
  if (schedule.kind === 'INVOICE') return `/invoices/${schedule.sourceId}`;
  if (schedule.kind === 'BILL') return `/expenses/${schedule.sourceId}`;
  return `/journals/${schedule.sourceId}`;
}

function runDocumentLink(schedule: RecurringScheduleDetail, runIdx: number): string | null {
  const run = schedule.runs[runIdx];
  if (!run) return null;
  if (run.invoiceId) return `/invoices/${run.invoiceId}`;
  if (run.billId) return `/expenses/${run.billId}`;
  if (run.journalEntryId) return `/journals/${run.journalEntryId}`;
  return null;
}

export default function RecurringScheduleDetailPage() {
  const { scheduleId } = useParams<{ scheduleId: string }>();
  const [schedule, setSchedule] = useState<RecurringScheduleDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<'end' | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (scheduleId === undefined) return;
    let ignore = false;
    setSchedule(null);
    setNotFound(false);
    setError(null);

    getRecurringSchedule(scheduleId)
      .then((res) => {
        if (!ignore) setSchedule(res.schedule);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setNotFound(true);
        } else {
          setError(err instanceof Error ? err.message : 'Could not load the schedule');
        }
      });

    return () => {
      ignore = true;
    };
  }, [scheduleId, reloadToken]);

  async function handleRun() {
    if (schedule === null) return;
    setBusy(true);
    setError(null);
    try {
      await runRecurringSchedule(schedule.id);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not run the schedule');
      setBusy(false);
    }
  }

  async function handlePause() {
    if (schedule === null) return;
    setBusy(true);
    setError(null);
    try {
      await pauseRecurringSchedule(schedule.id);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not pause the schedule');
      setBusy(false);
    }
  }

  async function handleResume() {
    if (schedule === null) return;
    setBusy(true);
    setError(null);
    try {
      await resumeRecurringSchedule(schedule.id);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not resume the schedule');
      setBusy(false);
    }
  }

  async function handleEnd() {
    if (schedule === null) return;
    setConfirming(null);
    setBusy(true);
    setError(null);
    try {
      await endRecurringSchedule(schedule.id);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not end the schedule');
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to="/recurring" label="Back to recurring schedules" />
        <p className="status status--bad">Schedule not found.</p>
      </section>
    );
  }

  if (schedule === null) {
    return (
      <div className="shell" aria-busy="true">
        <div className="skeleton skeleton--title" />
        <span className="visually-hidden">Loading schedule…</span>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <BackLink to="/recurring" label="Back to recurring schedules" />

      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">{schedule.name}</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            {kindLabel(schedule.kind)} · {frequencyLabel(schedule.frequency, schedule.intervalCount)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleRun()}
            disabled={busy || schedule.status !== 'ACTIVE'}
            className="flex items-center gap-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] rounded-md cursor-pointer px-3 py-1.5 disabled:opacity-40"
          >
            <Play size={14} /> {busy ? 'Running…' : 'Run now'}
          </button>
          {schedule.status === 'ACTIVE' && (
            <button
              type="button"
              onClick={() => void handlePause()}
              disabled={busy}
              className="flex items-center gap-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] rounded-md cursor-pointer px-3 py-1.5 disabled:opacity-40"
            >
              <Pause size={14} /> Pause
            </button>
          )}
          {schedule.status === 'PAUSED' && (
            <button
              type="button"
              onClick={() => void handleResume()}
              disabled={busy}
              className="flex items-center gap-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] rounded-md cursor-pointer px-3 py-1.5 disabled:opacity-40"
            >
              <Play size={14} /> Resume
            </button>
          )}
          {schedule.status !== 'ENDED' && (
            <button
              type="button"
              onClick={() => setConfirming('end')}
              disabled={busy}
              className="flex items-center gap-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] rounded-md cursor-pointer px-3 py-1.5 disabled:opacity-40"
            >
              <StopCircle size={14} /> End
            </button>
          )}
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      {schedule.lastError !== null && (
        <div className="rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] p-3">
          <p className="text-sm text-[var(--warning-text)] m-0">
            <strong>Last error:</strong> {schedule.lastError}
          </p>
        </div>
      )}

      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 m-0">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Status</dt>
          <dd className="m-0 text-sm">
            <span
              className={`inline-block px-2 py-1 rounded-md text-xs font-medium ${
                schedule.status === 'ACTIVE'
                  ? 'bg-[var(--success-bg)] text-[var(--success-text)]'
                  : schedule.status === 'PAUSED'
                    ? 'bg-[var(--muted-bg)] text-[var(--muted-text)]'
                    : 'bg-[var(--muted-bg)] text-[var(--muted-text)]'
              }`}
            >
              {schedule.status}
            </span>
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Mode</dt>
          <dd className="m-0 text-sm">{schedule.mode === 'DRAFT' ? 'Draft' : 'Posted'}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Start date</dt>
          <dd className="m-0 text-sm">{schedule.startDate}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">End date</dt>
          <dd className="m-0 text-sm">{schedule.endDate ?? '—'}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Next run</dt>
          <dd className="m-0 text-sm">{schedule.nextRunDate ?? '—'}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Last run</dt>
          <dd className="m-0 text-sm">{schedule.lastRunDate ?? '—'}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Template</dt>
          <dd className="m-0 text-sm">
            <Link to={documentLink(schedule)} className="text-[var(--accent)] hover:underline">
              View {kindLabel(schedule.kind).toLowerCase()}
            </Link>
          </dd>
        </div>
        {schedule.autoReverse && (
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Auto-reverse</dt>
            <dd className="m-0 text-sm">Yes</dd>
          </div>
        )}
      </dl>

      {schedule.runs.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold m-0 mb-3">Runs (newest first)</h3>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[36rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium">Date</th>
                  <th className="p-3 font-medium">#</th>
                  <th className="p-3 font-medium">Document</th>
                  <th className="p-3 font-medium">Reversal</th>
                </tr>
              </thead>
              <tbody>
                {schedule.runs.map((run, idx) => (
                  <tr key={run.id} className="border-t border-[var(--border)]">
                    <td className="p-3">{run.runDate}</td>
                    <td className="p-3">{run.occurrenceNumber}</td>
                    <td className="p-3">
                      {runDocumentLink(schedule, idx) ? (
                        <Link to={runDocumentLink(schedule, idx)!} className="text-[var(--accent)] hover:underline">
                          {run.invoiceId ? 'Invoice' : run.billId ? 'Bill' : 'Journal'}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="p-3">
                      {run.reversalEntryId ? (
                        <Link to={`/journals/${run.reversalEntryId}`} className="text-[var(--accent)] hover:underline">
                          Journal
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {confirming === 'end' && (
        <ConfirmDialog
          title="End this schedule?"
          body="The schedule will no longer generate new documents. This cannot be undone."
          confirmLabel="End schedule"
          tone="danger"
          busy={busy}
          onConfirm={() => void handleEnd()}
          onCancel={() => setConfirming(null)}
        />
      )}
    </section>
  );
}
