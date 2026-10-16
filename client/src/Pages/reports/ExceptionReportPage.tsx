import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import {
  GL_EXCEPTION_RULES,
  GL_EXCEPTION_RULE_LABELS,
  createGlExceptionReview,
  deleteGlExceptionReview,
  getGlExceptions,
  type GlException,
  type GlExceptionReport,
  type GlExceptionRule,
} from '../../services/fetchServices';
import { useAuth, useCan } from '../../context/AuthContext';
import { formatCents } from '../../utils/money';
import { formatDate } from '../../utils/date';
import BackLink from '../../components/BackLink';
import LoadingState from '../../components/ui/LoadingState';
import EmptyState from '../../components/ui/EmptyState';
import ExportMenu from '../../components/ui/ExportMenu';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../components/ui/formClasses';

/**
 * Ledger exceptions — four deterministic checks over posted data (unusual
 * amount, unexpected side, non-default tax rate, possible duplicate) plus the
 * review decisions accountants have recorded. The server decides what is an
 * exception; this page holds filters and the review dialog only. Dates are
 * computed in UTC so the default window does not depend on the viewer's zone.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The last three complete months: the 1st of (this month − 3) to the last day of last month. */
function defaultWindow(now: Date = new Date()): { from: string; to: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return { from: iso(new Date(Date.UTC(y, m - 3, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
}

function documentLink(e: GlException): string | null {
  if (e.documentId === null) return null;
  return e.documentType === 'INVOICE' ? `/invoices/${e.documentId}` : `/expenses/${e.documentId}`;
}

export default function ExceptionReportPage() {
  const auth = useAuth();
  const can = useCan();
  const canReview = can('reports.review_exceptions');
  const baseCurrency = auth.status === 'authenticated' ? (auth.organization?.baseCurrency ?? '') : '';

  const initial = defaultWindow();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [rules, setRules] = useState<GlExceptionRule[]>([...GL_EXCEPTION_RULES]);
  const [includeReviewed, setIncludeReviewed] = useState(false);
  const [report, setReport] = useState<GlExceptionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [reviewing, setReviewing] = useState<GlException | null>(null);

  useEffect(() => {
    if (from === '' || to === '' || rules.length === 0) return;
    const controller = new AbortController();
    setError(null);
    getGlExceptions({ from, to, rules, includeReviewed }, controller.signal)
      .then((res) => setReport(res))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setReport(null);
        setError(err instanceof Error ? err.message : 'Could not load the exceptions');
      });
    return () => controller.abort();
  }, [from, to, rules, includeReviewed, reloadKey]);

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  function toggleRule(rule: GlExceptionRule) {
    setRules((current) => (current.includes(rule) ? current.filter((r) => r !== rule) : [...current, rule]));
  }

  async function reopen(e: GlException) {
    if (e.review === null) return;
    try {
      await deleteGlExceptionReview(e.review.id);
      refetch();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not reopen the exception');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <BackLink to="/reports" label="Back to reports" />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold m-0">Ledger exceptions</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">From</span>
            <input type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">To</span>
            <input type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <ExportMenu
            path="/reports/exceptions"
            params={{ from: from || null, to: to || null, rules: rules.join(','), includeReviewed: String(includeReviewed) }}
            disabled={rules.length === 0}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {GL_EXCEPTION_RULES.map((rule) => {
          const active = rules.includes(rule);
          const open = report?.counts[rule].open ?? 0;
          return (
            <button
              key={rule}
              type="button"
              aria-pressed={active}
              onClick={() => toggleRule(rule)}
              className={`px-3 py-1.5 rounded-full text-sm border cursor-pointer ${
                active
                  ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--text)]'
                  : 'bg-transparent border-[var(--border)] text-[var(--muted)]'
              }`}
            >
              {`${GL_EXCEPTION_RULE_LABELS[rule]} (${String(open)})`}
            </button>
          );
        })}
        <label className="flex items-center gap-2 text-sm ml-2">
          <input type="checkbox" checked={includeReviewed} onChange={(e) => setIncludeReviewed(e.target.checked)} />
          Show reviewed
        </label>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
      {report?.truncated === true && (
        <p className="status">Showing the first 1,000 results for a check — narrow the date range.</p>
      )}

      {rules.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="Select at least one check" />
      ) : report === null && error === null ? (
        <LoadingState />
      ) : report !== null && report.exceptions.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No exceptions found" body="Nothing in this window needs review." />
      ) : (
        report !== null && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[56rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium">Date</th>
                  <th className="p-3 font-medium">Check</th>
                  <th className="p-3 font-medium">Account</th>
                  <th className="p-3 font-medium">Document</th>
                  <th className="p-3 font-medium text-right">Amount</th>
                  <th className="p-3 font-medium">Expected</th>
                  <th className="p-3 font-medium">Actual</th>
                  <th className="p-3 font-medium">Reason</th>
                  <th className="p-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {report.exceptions.map((e) => {
                  const docLink = documentLink(e);
                  return (
                    <tr key={`${e.rule}:${e.subjectId}`} className="border-t border-[var(--border)] align-top">
                      <td className="p-3 whitespace-nowrap">
                        {docLink === null && e.journalEntryId !== null ? (
                          <Link to={`/journals/${e.journalEntryId}`} className="text-[var(--text)] hover:underline">
                            {formatDate(e.entryDate)}
                          </Link>
                        ) : (
                          formatDate(e.entryDate)
                        )}
                      </td>
                      <td className="p-3">{GL_EXCEPTION_RULE_LABELS[e.rule]}</td>
                      <td className="p-3">{e.accountCode === null ? '—' : `${e.accountCode} ${e.accountName ?? ''}`}</td>
                      <td className="p-3">
                        {docLink === null ? (
                          '—'
                        ) : (
                          <Link to={docLink} className="text-[var(--text)] hover:underline">
                            {e.documentNumber ?? 'Open'}
                          </Link>
                        )}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {formatCents(e.amountCents)}
                        {e.currencyCode !== baseCurrency && e.currencyCode !== '' ? ` ${e.currencyCode}` : ''}
                      </td>
                      <td className="p-3">{e.expected}</td>
                      <td className="p-3">{e.actual}</td>
                      <td className="p-3">{e.reason}</td>
                      <td className="p-3">
                        {e.review === null ? (
                          canReview && (
                            <button type="button" className={secondaryButtonClass} onClick={() => setReviewing(e)}>
                              Mark reviewed
                            </button>
                          )
                        ) : (
                          <div className="flex flex-col gap-1">
                            <span className="text-[var(--muted)]">{`Reviewed by ${e.review.reviewedByName}`}</span>
                            <span className="text-xs">{e.review.note}</span>
                            {canReview && (
                              <button type="button" className={secondaryButtonClass} onClick={() => void reopen(e)}>
                                Reopen
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {reviewing !== null && (
        <ReviewDialog
          exception={reviewing}
          onClose={() => setReviewing(null)}
          onSaved={() => {
            setReviewing(null);
            refetch();
          }}
        />
      )}
    </div>
  );
}

function ReviewDialog({
  exception,
  onClose,
  onSaved,
}: {
  exception: GlException;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || note.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await createGlExceptionReview({
        rule: exception.rule,
        subjectType: exception.subjectType,
        subjectId: exception.subjectId,
        note: note.trim(),
      });
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the review');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-[var(--panel)] rounded-lg border border-[var(--border)] max-w-md w-full">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4 p-6">
          <h3 className="text-lg font-semibold m-0">Mark as reviewed</h3>
          <p className="muted m-0">{exception.reason}</p>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Note</span>
            <textarea
              className={inputClass}
              rows={3}
              maxLength={500}
              required
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {error !== null && <p className="status status--bad">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={secondaryButtonClass} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={primaryButtonClass} disabled={busy || note.trim() === ''}>
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
