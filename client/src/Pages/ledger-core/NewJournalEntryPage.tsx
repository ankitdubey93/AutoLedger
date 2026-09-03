import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { createJournal, listAccounts, type Account } from '../../services/fetchServices';
import { formatCents, parseCentsInput } from './money';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * Post a journal entry.
 *
 * The balance check here is integer-cent equality, exactly as on the server and
 * in the database trigger — three independent implementations of one rule, none
 * of them using a tolerance. The client's copy exists to disable the button, not
 * to be trusted: the server re-checks, and Postgres re-checks again at COMMIT.
 *
 * Split out of the former JournalEntryPage, which mixed posting with the list
 * of posted entries — that list is now JournalsPage, a register with its own
 * filters, and this page's only job after a successful post is to hand off to
 * the new entry's detail page.
 */

interface DraftLine {
  accountId: string;
  debit: string;
  credit: string;
}

const EMPTY_LINE: DraftLine = { accountId: '', debit: '', credit: '' };

function today(): string {
  // Local calendar date, not toISOString() — that converts to UTC and would
  // show yesterday's date to anyone east of Greenwich. Same bug the server's
  // DATE type parser exists to avoid.
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

export default function NewJournalEntryPage() {
  const base = useAppBasePath();
  const navigate = useNavigate();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entryDate, setEntryDate] = useState(today);
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }, { ...EMPTY_LINE }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false;

    listAccounts()
      .then((res) => {
        if (ignore) return;
        // Only postable accounts can receive a line — a header account is
        // rejected by a database trigger, so it should never be offered.
        setAccounts(res.accounts.filter((a) => a.isPostable));
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load accounts');
      });

    return () => {
      ignore = true;
    };
  }, []);

  const totals = useMemo(() => {
    let debits = 0;
    let credits = 0;
    let malformed = false;

    for (const line of lines) {
      const debit = parseCentsInput(line.debit);
      const credit = parseCentsInput(line.credit);
      if (debit === null || credit === null) {
        malformed = true;
        continue;
      }
      debits += debit;
      credits += credit;
    }

    return { debits, credits, malformed, balanced: !malformed && debits === credits };
  }, [lines]);

  const complete = lines.every((line) => {
    const debit = parseCentsInput(line.debit) ?? 0;
    const credit = parseCentsInput(line.credit) ?? 0;
    // Exactly one side populated, per line — mirrors chk_exclusive_debit_credit.
    return line.accountId !== '' && (debit > 0) !== (credit > 0);
  });

  const canPost = complete && totals.balanced && totals.debits > 0 && !busy;

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  }

  async function handlePost(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const { entry } = await createJournal({
        entryDate,
        description: description.trim() === '' ? null : description.trim(),
        lines: lines.map((line) => ({
          accountId: line.accountId,
          debitCents: parseCentsInput(line.debit) ?? 0,
          creditCents: parseCentsInput(line.credit) ?? 0,
        })),
      });

      navigate(`${base}/journals/${entry.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not post the entry');
      setBusy(false);
    }
  }

  const inputClass =
    'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

  return (
    <section className="flex flex-col gap-4">
      <form onSubmit={handlePost} className="flex flex-col gap-4">
        <header>
          <h2 className="text-lg font-semibold m-0">Post a journal entry</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            At least two lines, and debits must equal credits exactly. Checked here, again
            on the server, and once more by the database at commit.
          </p>
        </header>

        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Date</span>
            <input
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
              required
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm flex-1 min-w-56">
            <span className="text-[var(--muted)]">Description</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="AWS August"
              maxLength={500}
              className={inputClass}
            />
          </label>
        </div>

        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[34rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Account</th>
                <th className="p-3 font-medium w-32 text-right">Debit</th>
                <th className="p-3 font-medium w-32 text-right">Credit</th>
                <th className="p-3 w-10" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={index} className="border-t border-[var(--border)]">
                  <td className="p-2">
                    <select
                      value={line.accountId}
                      onChange={(e) => updateLine(index, { accountId: e.target.value })}
                      className={inputClass}
                      aria-label={`Account for line ${String(index + 1)}`}
                    >
                      <option value="">Select an account…</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.code} · {account.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="p-2">
                    <input
                      inputMode="decimal"
                      value={line.debit}
                      // One side per line, enforced by clearing the other.
                      onChange={(e) => updateLine(index, { debit: e.target.value, credit: '' })}
                      placeholder="0.00"
                      aria-label={`Debit for line ${String(index + 1)}`}
                      className={`${inputClass} text-right tabular-nums`}
                    />
                  </td>
                  <td className="p-2">
                    <input
                      inputMode="decimal"
                      value={line.credit}
                      onChange={(e) => updateLine(index, { credit: e.target.value, debit: '' })}
                      placeholder="0.00"
                      aria-label={`Credit for line ${String(index + 1)}`}
                      className={`${inputClass} text-right tabular-nums`}
                    />
                  </td>
                  <td className="p-2 text-center">
                    <button
                      type="button"
                      // Two lines is the floor of double-entry.
                      disabled={lines.length <= 2}
                      onClick={() => setLines((c) => c.filter((_, i) => i !== index))}
                      aria-label={`Remove line ${String(index + 1)}`}
                      className="text-[var(--muted)] hover:text-[var(--bad)] disabled:opacity-30 disabled:cursor-not-allowed bg-transparent border-0 cursor-pointer p-1"
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[var(--border)] font-medium">
                <td className="p-3">
                  <button
                    type="button"
                    onClick={() => setLines((c) => [...c, { ...EMPTY_LINE }])}
                    className="flex items-center gap-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border-0 cursor-pointer p-0"
                  >
                    <Plus size={15} /> Add line
                  </button>
                </td>
                <td className="p-3 text-right tabular-nums">{formatCents(totals.debits)}</td>
                <td className="p-3 text-right tabular-nums">{formatCents(totals.credits)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="flex items-center gap-4 flex-wrap">
          <button
            type="submit"
            disabled={!canPost}
            className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Posting…' : 'Post entry'}
          </button>

          {totals.malformed && (
            <span className="text-sm text-[var(--bad)]">
              Amounts take at most two decimal places.
            </span>
          )}
          {!totals.malformed && !totals.balanced && (
            <span className="text-sm text-[var(--bad)] tabular-nums">
              Out of balance by {formatCents(Math.abs(totals.debits - totals.credits))}
            </span>
          )}
          {totals.balanced && totals.debits > 0 && (
            <span className="text-sm text-[var(--good)]">Balanced</span>
          )}
        </div>

        {error !== null && <p className="status status--bad">{error}</p>}
      </form>
    </section>
  );
}
