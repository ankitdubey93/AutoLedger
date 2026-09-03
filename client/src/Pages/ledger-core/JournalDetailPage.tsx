import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import {
  ApiRequestError,
  getJournal,
  reverseJournal,
  type JournalEntry,
} from '../../services/fetchServices';
import { formatCents } from './money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import BackLink from './BackLink';
import ConfirmDialog from './ConfirmDialog';

/**
 * One journal entry, in full: every field, both totals, and every line.
 *
 * There is no edit and no delete control anywhere on this page, and there
 * never will be — a posted entry is immutable (guardrails rule 6). The only
 * correction path is the Reverse button, which posts a brand-new entry.
 */

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</dt>
      <dd className="m-0 text-sm">{children}</dd>
    </div>
  );
}

export default function JournalDetailPage() {
  const { entryId } = useParams<{ entryId: string }>();
  const base = useAppBasePath();
  const navigate = useNavigate();

  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (entryId === undefined) return;
    let ignore = false;
    setEntry(null);
    setNotFound(false);
    setError(null);

    getJournal(entryId)
      .then((res) => {
        if (!ignore) setEntry(res.entry);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setNotFound(true);
        } else {
          setError(err instanceof Error ? err.message : 'Could not load the entry');
        }
      });

    return () => {
      ignore = true;
    };
  }, [entryId]);

  async function handleReverse() {
    if (entry === null) return;
    setBusy(true);
    setError(null);
    try {
      const { entry: reversal } = await reverseJournal(entry.id);
      navigate(`${base}/journals/${reversal.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not reverse the entry');
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to={`${base}/journals`} label="Back to journal entries" />
        <p className="status status--bad">Journal entry not found.</p>
      </section>
    );
  }

  if (entry === null) {
    return (
      <div className="shell" aria-busy="true">
        <div className="skeleton skeleton--title" />
        <span className="visually-hidden">Loading entry…</span>
      </div>
    );
  }

  const canReverse = entry.reversesEntryId === null && entry.reversedByEntryId === null;
  const balanced = entry.totalDebitCents === entry.totalCreditCents;

  return (
    <section className="flex flex-col gap-6">
      <BackLink to={`${base}/journals`} label="Back to journal entries" />

      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">{entry.description ?? 'Journal entry'}</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">{entry.entryDate}</p>
        </div>
        {canReverse && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy}
            className="flex items-center gap-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] rounded-md cursor-pointer px-3 py-1.5 disabled:opacity-40"
          >
            <RotateCcw size={14} /> {busy ? 'Reversing…' : 'Reverse'}
          </button>
        )}
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 m-0">
        <DetailRow label="Date">{entry.entryDate}</DetailRow>
        <DetailRow label="Reference">
          <span className="font-mono select-all">{entry.id}</span>
        </DetailRow>
        <DetailRow label="Description">{entry.description ?? '—'}</DetailRow>
        <DetailRow label="Source">
          {entry.sourceType}
          {entry.sourceId !== null && <span className="text-[var(--muted)]"> · {entry.sourceId}</span>}
        </DetailRow>
        <DetailRow label="Posted by">
          {entry.createdByName ?? entry.createdByEmail ?? '—'}
          {entry.createdByName !== null && entry.createdByEmail !== null && (
            <span className="text-[var(--muted)]"> · {entry.createdByEmail}</span>
          )}
        </DetailRow>
        <DetailRow label="Posted at">{new Date(entry.createdAt).toLocaleString()}</DetailRow>
        <DetailRow label="Status">
          {entry.reversesEntryId !== null
            ? 'Reversal'
            : entry.reversedByEntryId !== null
              ? 'Reversed'
              : 'Posted'}
        </DetailRow>
        {entry.reversesEntryId !== null && (
          <DetailRow label="Reverses">
            <Link to={`${base}/journals/${entry.reversesEntryId}`}>
              {entry.reversesEntryId.slice(0, 8)}
            </Link>
          </DetailRow>
        )}
        {entry.reversedByEntryId !== null && (
          <DetailRow label="Reversed by">
            <Link to={`${base}/journals/${entry.reversedByEntryId}`}>
              {entry.reversedByEntryId.slice(0, 8)}
            </Link>
          </DetailRow>
        )}
      </dl>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm min-w-[34rem]">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className="p-3 font-medium">Code</th>
              <th className="p-3 font-medium">Account</th>
              <th className="p-3 font-medium">Currency</th>
              <th className="p-3 font-medium text-right">Debit</th>
              <th className="p-3 font-medium text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((line) => (
              <tr key={line.id} className="border-t border-[var(--border)]">
                <td className="p-3 font-mono text-xs text-[var(--muted)]">
                  <Link to={`${base}/accounts/${line.accountId}`}>{line.accountCode}</Link>
                </td>
                <td className="p-3">
                  <Link
                    to={`${base}/accounts/${line.accountId}`}
                    className="text-[var(--text)] no-underline hover:underline"
                  >
                    {line.accountName}
                  </Link>
                </td>
                <td className="p-3 text-[var(--muted)]">{line.currencyCode}</td>
                <td className="p-3 text-right tabular-nums">
                  {line.debitCents > 0 ? formatCents(line.debitCents) : ''}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {line.creditCents > 0 ? formatCents(line.creditCents) : ''}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[var(--border)] font-semibold">
              <td className="p-3" colSpan={3}>
                {balanced ? 'Balanced' : 'Out of balance — this should be impossible'}
              </td>
              <td className="p-3 text-right tabular-nums">{formatCents(entry.totalDebitCents)}</td>
              <td className="p-3 text-right tabular-nums">{formatCents(entry.totalCreditCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {confirming && (
        <ConfirmDialog
          title="Reverse this entry?"
          body={
            <>
              This posts a new offsetting entry dated {entry.entryDate}. The original entry is
              never changed or deleted. This cannot be undone.
            </>
          }
          confirmLabel="Reverse entry"
          tone="danger"
          busy={busy}
          onConfirm={() => {
            setConfirming(false);
            void handleReverse();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
