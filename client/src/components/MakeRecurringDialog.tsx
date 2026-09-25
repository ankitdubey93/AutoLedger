import { useState } from 'react';
import {
  createRecurringSchedule,
  type RecurringKind,
  RECURRING_FREQUENCIES,
} from '../services/fetchServices';
import { inputClass } from './ui/formClasses';

/**
 * Creates a recurring schedule from a source document (invoice, bill, or journal entry).
 * Opened from a document's detail page.
 */

export interface MakeRecurringDialogProps {
  kind: RecurringKind;
  sourceId: string;
  defaultName: string;
  onClose: () => void;
  onCreated: (scheduleId: string) => void;
}

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

export default function MakeRecurringDialog({
  kind,
  sourceId,
  defaultName,
  onClose,
  onCreated,
}: MakeRecurringDialogProps) {
  const [name, setName] = useState(defaultName);
  const [frequency, setFrequency] = useState<'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY'>('MONTHLY');
  const [interval, setInterval] = useState('1');
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState('');
  const [mode, setMode] = useState<'DRAFT' | 'POST'>(kind === 'JOURNAL' ? 'POST' : 'DRAFT');
  const [autoReverse, setAutoReverse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const intervalNum = parseInt(interval) || 1;
  const canSave =
    !busy &&
    name.trim() !== '' &&
    intervalNum >= 1 &&
    intervalNum <= 12 &&
    startDate !== '' &&
    (!endDate || endDate >= startDate);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave) return;

    setBusy(true);
    setError(null);

    try {
      const result = await createRecurringSchedule({
        kind,
        sourceId,
        name: name.trim(),
        frequency,
        intervalCount: intervalNum,
        startDate,
        endDate: endDate || null,
        mode,
        autoReverse,
      });
      onCreated(result.schedule.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the schedule');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-[var(--panel)] rounded-lg border border-[var(--border)] max-w-md w-full max-h-[90vh] overflow-y-auto">
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4 p-6">
          <h3 className="text-lg font-semibold m-0">Make recurring</h3>

          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Name</span>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                className={inputClass}
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Frequency</span>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY')}
                className={inputClass}
              >
                {RECURRING_FREQUENCIES.map((freq) => (
                  <option key={freq} value={freq}>
                    {freq === 'WEEKLY'
                      ? 'Weekly'
                      : freq === 'MONTHLY'
                        ? 'Monthly'
                        : freq === 'QUARTERLY'
                          ? 'Quarterly'
                          : 'Yearly'}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Every (count)</span>
              <input
                type="number"
                min={1}
                max={12}
                required
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                className={inputClass}
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Start date</span>
              <input
                type="date"
                required
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={inputClass}
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">End date (optional)</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className={inputClass}
              />
            </label>

            {kind !== 'JOURNAL' && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-[var(--muted)]">Mode</span>
                <select value={mode} onChange={(e) => setMode(e.target.value as 'DRAFT' | 'POST')} className={inputClass}>
                  <option value="DRAFT">Draft</option>
                  <option value="POST">Posted</option>
                </select>
              </label>
            )}

            {kind === 'JOURNAL' && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={autoReverse}
                  onChange={(e) => setAutoReverse(e.target.checked)}
                  className="cursor-pointer"
                />
                <span className="text-[var(--muted)]">Auto-reverse on the 1st of next month</span>
              </label>
            )}
          </div>

          {error !== null && <p className="status status--bad m-0">{error}</p>}

          <div className="flex items-center gap-3 mt-2">
            <button
              type="submit"
              disabled={!canSave}
              className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-1"
            >
              {busy ? 'Creating…' : 'Create schedule'}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="btn btn--ghost"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
