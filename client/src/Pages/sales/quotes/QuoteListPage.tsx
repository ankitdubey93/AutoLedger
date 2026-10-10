import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { listQuotes, type QuoteStatus, type QuoteSummary } from '../../../services/fetchServices';
import { formatCents } from '../../../utils/money';
import { formatDate } from '../../../utils/date';
import { useCan } from '../../../context/AuthContext';
import Pagination from '../../../components/ui/Pagination';
import LoadingState from '../../../components/ui/LoadingState';
import { QuoteStatusPill, quoteLabel } from './QuoteDocument';
import type { QuoteKindConfig } from './quoteKinds';

/**
 * The quote register (Phase 41), sales or purchase. Tabs filter on the
 * *effective* status — a sent quote past its validity date shows under
 * Expired even before the hourly sweep records it. Superseded versions are
 * left out of "All"; they live on their successor's revision history.
 */

const PAGE_LIMIT = 50;

const TABS: { key: string; label: string; status: QuoteStatus | '' }[] = [
  { key: 'all', label: 'All', status: '' },
  { key: 'draft', label: 'Draft', status: 'DRAFT' },
  { key: 'sent', label: 'Awaiting response', status: 'SENT' },
  { key: 'accepted', label: 'Accepted', status: 'ACCEPTED' },
  { key: 'converted', label: 'Converted', status: 'CONVERTED' },
  { key: 'declined', label: 'Declined', status: 'DECLINED' },
  { key: 'expired', label: 'Expired', status: 'EXPIRED' },
  { key: 'void', label: 'Void', status: 'VOID' },
];

export default function QuoteListPage({ config }: { config: QuoteKindConfig }) {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [quotes, setQuotes] = useState<QuoteSummary[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const status = (params.get('status') ?? '') as QuoteStatus | '';
  const page = Number(params.get('page') ?? '1');

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    listQuotes(config.direction, { page, limit: PAGE_LIMIT, status }, controller.signal)
      .then((res) => {
        setQuotes(res.quotes);
        setTotalCount(res.totalCount);
        setTotalPages(res.totalPages);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : `Could not load ${config.plural.toLowerCase()}`);
        setQuotes([]);
        setTotalCount(0);
        setLoaded(true);
      });
    return () => controller.abort();
  }, [config, status, page]);

  function selectTab(next: QuoteStatus | '') {
    const nextParams = new URLSearchParams(params);
    if (next === '') nextParams.delete('status');
    else nextParams.set('status', next);
    nextParams.delete('page');
    setParams(nextParams);
  }

  function goToPage(next: number) {
    const nextParams = new URLSearchParams(params);
    if (next <= 1) nextParams.delete('page');
    else nextParams.set('page', String(next));
    setParams(nextParams);
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">{config.plural}</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1 max-w-2xl">{config.listHint}</p>
        </div>
        {can(config.permissions.edit) && (
          <Link
            to={`/${config.path}/new`}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium no-underline bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]"
          >
            <Plus size={14} aria-hidden="true" /> New {config.title.toLowerCase()}
          </Link>
        )}
      </header>

      <nav className="flex flex-wrap gap-1 border-b border-[var(--border)]" aria-label={`${config.title} status`}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => selectTab(tab.status)}
            aria-current={status === tab.status ? 'page' : undefined}
            className={[
              'px-3 py-2 text-sm border-0 border-b-2 bg-transparent cursor-pointer -mb-px',
              status === tab.status
                ? 'border-[var(--text)] text-[var(--text)] font-medium'
                : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {error !== null && <p className="status status--bad">{error}</p>}
      {!loaded && error === null && <LoadingState />}

      {loaded && totalCount === 0 && error === null && (
        <p className="muted">
          No {config.plural.toLowerCase()} {status === '' ? 'yet' : 'with this status'}.
        </p>
      )}

      {loaded && totalCount > 0 && (
        <>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[48rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium">Number</th>
                  <th className="p-3 font-medium">Date</th>
                  <th className="p-3 font-medium">{config.partyNoun}</th>
                  <th className="p-3 font-medium">Title</th>
                  <th className="p-3 font-medium">Valid until</th>
                  <th className="p-3 font-medium">Status</th>
                  <th className="p-3 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((quote) => (
                  <tr key={quote.id} className="border-t border-[var(--border)]">
                    <td className="p-3 font-mono text-xs">
                      <Link to={`/${config.path}/${quote.id}`}>{quoteLabel(quote)}</Link>
                    </td>
                    <td className="p-3 tabular-nums whitespace-nowrap">{formatDate(quote.quoteDate)}</td>
                    <td className="p-3">{quote.partyName}</td>
                    <td className="p-3 text-[var(--muted)]">{quote.title ?? '—'}</td>
                    <td className="p-3 tabular-nums whitespace-nowrap">{formatDate(quote.validUntil)}</td>
                    <td className="p-3">
                      <QuoteStatusPill status={quote.effectiveStatus} />
                    </td>
                    <td className="p-3 text-right tabular-nums whitespace-nowrap">
                      {formatCents(quote.totalCents)} {quote.currencyCode}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            totalPages={totalPages}
            shownCount={quotes.length}
            totalCount={totalCount}
            noun="quotes"
            onPageChange={goToPage}
          />
        </>
      )}
    </section>
  );
}
