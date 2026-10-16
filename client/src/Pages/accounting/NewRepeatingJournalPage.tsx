import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createRepeatingJournal,
  listAccounts,
  RECURRING_FREQUENCIES,
  type Account,
  type RecurringFrequency,
} from '../../services/fetchServices';
import BackLink from '../../components/BackLink';
import PlaceholderPicker from '../../components/placeholders/PlaceholderPicker';
import PlaceholderHints from '../../components/placeholders/PlaceholderHints';
import ManualJournalLinesEditor, {
  editorTotals,
  emptyLine,
  toInputLines,
  type EditorLine,
} from '../../components/ManualJournalLinesEditor';
import { usePlaceholderTarget } from '../../utils/usePlaceholderTarget';
import { useOrganizationName } from '../../context/OrgContext';

/**
 * Phase 44 — create a repeating journal directly, without posting one first.
 *
 * The server builds the template (a TEMPLATE manual journal) and its JOURNAL
 * schedule in one transaction. Each run then posts a fresh journal from the
 * template, optionally auto-reversed on the first of the next month.
 */

function today(): string {
  // Local calendar date, not toISOString() (which converts to UTC).
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

function twoEmptyLines(): EditorLine[] {
  return [emptyLine(), emptyLine()];
}

function frequencyText(freq: RecurringFrequency): string {
  if (freq === 'WEEKLY') return 'Weekly';
  if (freq === 'MONTHLY') return 'Monthly';
  if (freq === 'QUARTERLY') return 'Quarterly';
  return 'Yearly';
}

export default function NewRepeatingJournalPage() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [name, setName] = useState('');
  const [narration, setNarration] = useState('');
  const [startDate, setStartDate] = useState(today);
  const [frequency, setFrequency] = useState<RecurringFrequency>('MONTHLY');
  const [interval, setInterval] = useState('1');
  const [endDate, setEndDate] = useState('');
  const [autoReverse, setAutoReverse] = useState(false);
  const [lines, setLines] = useState<EditorLine[]>(twoEmptyLines);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const organisationName = useOrganizationName();
  const placeholderTarget = usePlaceholderTarget('narration');

  useEffect(() => {
    let ignore = false;
    listAccounts()
      .then((res) => {
        if (!ignore) setAccounts(res.accounts);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load accounts');
      });
    return () => {
      ignore = true;
    };
  }, []);

  const totals = editorTotals(lines);
  const canSave =
    !busy &&
    name.trim() !== '' &&
    narration.trim() !== '' &&
    totals.balanced &&
    totals.debits > 0;

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await createRepeatingJournal({
        name: name.trim(),
        narration: narration.trim(),
        entryDate: startDate,
        lines: toInputLines(lines),
        frequency,
        intervalCount: parseInt(interval, 10) || 1,
        startDate,
        endDate: endDate === '' ? null : endDate,
        autoReverse,
      });
      void navigate(`/recurring/${res.schedule.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the repeating journal');
      setBusy(false);
    }
  }

  const inputClass =
    'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';
  const primaryClass =
    'px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <section className="flex flex-col gap-4">
      <BackLink to="/manual-journals?status=repeating" label="Back to manual journals" />

      <form
        onSubmit={(event) => {
          event.preventDefault();
        }}
        className="flex flex-col gap-4"
      >
        <header>
          <h2 className="text-lg font-semibold m-0">New repeating journal</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Each run posts a journal from this template on its date. Nothing is posted until the first run.
          </p>
        </header>

        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm flex-1 min-w-56">
            <span className="text-[var(--muted)]">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              className={inputClass}
            />
          </label>
          <div className="flex flex-col gap-1 text-sm flex-1 min-w-56">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="repeating-narration" className="text-[var(--muted)]">
                Narration
              </label>
              <PlaceholderPicker
                surface="JOURNAL"
                onInsert={placeholderTarget.insert}
                preview={{ date: startDate, organisationName, occurrence: 1 }}
              />
            </div>
            <input
              id="repeating-narration"
              type="text"
              {...placeholderTarget.bind('narration', setNarration)}
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              onBlur={() => {
                // Name defaults to the narration on blur, but only while it is still empty.
                if (name.trim() === '') setName(narration.trim().slice(0, 80));
              }}
              placeholder="Accrued rent [Month]"
              maxLength={500}
              required
              className={inputClass}
            />
            <PlaceholderHints
              text={narration}
              surface="JOURNAL"
              preview={{ date: startDate, organisationName, occurrence: 1 }}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">First date</span>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              required
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Repeats</span>
            <select
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}
              className={inputClass}
            >
              {RECURRING_FREQUENCIES.map((freq) => (
                <option key={freq} value={freq}>
                  {frequencyText(freq)}
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
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">End date (optional)</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputClass} />
          </label>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoReverse}
            onChange={(e) => setAutoReverse(e.target.checked)}
            className="cursor-pointer mt-0.5"
          />
          <span className="flex flex-col gap-0.5">
            <span>Reverse on the 1st of the next month</span>
            <span className="text-xs text-[var(--muted)]">
              For accruals: each journal is reversed automatically at the start of the next month.
            </span>
          </span>
        </label>

        <ManualJournalLinesEditor lines={lines} onChange={setLines} accounts={accounts} />

        <div className="flex items-center gap-3 flex-wrap">
          <button type="button" disabled={!canSave} onClick={() => void handleSave()} className={primaryClass}>
            {busy ? 'Saving…' : 'Save repeating journal'}
          </button>
        </div>

        {error !== null && <p className="status status--bad">{error}</p>}
      </form>
    </section>
  );
}
