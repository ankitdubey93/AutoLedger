import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listFxRevaluations, type FxRevaluation } from '../../services/fetchServices';
import { useAppBasePath } from '../../apps/useAppBasePath';
import { formatCents } from './money';

/** Past revaluations, newest first — each expands to its per-document lines. */
export default function FxRevaluationsPage() {
  const base = useAppBasePath();
  const [revaluations, setRevaluations] = useState<FxRevaluation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    listFxRevaluations({ limit: 50 })
      .then((res) => {
        if (!ignore) setRevaluations(res.revaluations);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load revaluations');
      });
    return () => {
      ignore = true;
    };
  }, []);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Revaluations</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Every period-end FX revaluation ever posted, each with an automatic next-day reversal.
          </p>
        </div>
        <Link
          to={`${base}/fx-exposure`}
          className="px-3 py-1.5 rounded-md text-sm font-medium no-underline bg-[var(--text)] text-[var(--bg)]"
        >
          Post a revaluation
        </Link>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      {revaluations === null && error === null && <p className="muted">Loading…</p>}

      {revaluations !== null && revaluations.length === 0 && (
        <p className="text-sm text-[var(--muted)]">No revaluations posted yet.</p>
      )}

      {revaluations !== null && revaluations.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[40rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">As of</th>
                <th className="p-3 font-medium text-right">Documents</th>
                <th className="p-3 font-medium text-right">Total delta</th>
                <th className="p-3 font-medium">Posted by</th>
                <th className="p-3 font-medium text-right">Entries</th>
              </tr>
            </thead>
            <tbody>
              {revaluations.map((rev) => (
                <Fragment key={rev.id}>
                  <tr
                    className="border-t border-[var(--border)] cursor-pointer"
                    onClick={() => setExpandedId((id) => (id === rev.id ? null : rev.id))}
                  >
                    <td className="p-3">{rev.asOfDate}</td>
                    <td className="p-3 text-right">{rev.lineCount}</td>
                    <td className={`p-3 text-right font-mono ${rev.totalDeltaCents < 0 ? 'text-red-500' : ''}`}>
                      {formatCents(rev.totalDeltaCents)}
                    </td>
                    <td className="p-3">{rev.createdBy}</td>
                    <td className="p-3 text-right">
                      <Link to={`${base}/journals/${rev.journalEntryId}`} onClick={(e) => e.stopPropagation()}>
                        Entry
                      </Link>{' '}
                      ·{' '}
                      <Link
                        to={`${base}/journals/${rev.reversalJournalEntryId}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        Reversal
                      </Link>
                    </td>
                  </tr>
                  {expandedId === rev.id && (
                    <tr className="border-t border-[var(--border)] bg-[var(--bg)]">
                      <td colSpan={5} className="p-3">
                        <table className="w-full border-collapse text-xs">
                          <thead>
                            <tr className="text-left text-[var(--muted)] uppercase tracking-wide">
                              <th className="p-2 font-medium">Document</th>
                              <th className="p-2 font-medium">Counterparty</th>
                              <th className="p-2 font-medium">Currency</th>
                              <th className="p-2 font-medium text-right">Outstanding</th>
                              <th className="p-2 font-medium text-right">Delta</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rev.lines.map((line) => (
                              <tr key={line.id} className="border-t border-[var(--border)]">
                                <td className="p-2">
                                  {line.documentType === 'INVOICE' ? 'Invoice' : 'Bill'} {line.documentNumber ?? ''}
                                </td>
                                <td className="p-2">{line.counterpartyName}</td>
                                <td className="p-2">{line.currencyCode}</td>
                                <td className="p-2 text-right font-mono">{formatCents(line.outstandingCents)}</td>
                                <td className="p-2 text-right font-mono">{formatCents(line.deltaCents)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
