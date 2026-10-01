import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  listInvoices,
  type Invoice,
  type InvoiceStatus,
  type SettlementFilter,
  type SettlementStatus,
  type InvoiceSortKey,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { formatDate } from '../../utils/date';
import { useDebouncedInput } from '../../utils/useDebouncedInput';
import type { SortState } from '../../utils/useTableSort';
import SortableHeader from '../../components/ui/SortableHeader';
import Pagination from '../../components/ui/Pagination';
import LoadingState from '../../components/ui/LoadingState';
import ImportButton from '../../components/imports/ImportButton';

/**
 * The invoice register — every sales invoice, filterable and paginated.
 *
 * Filters live in the URL, the same idiom JournalsPage uses. Correcting an
 * issued invoice means voiding it (from the detail page), never editing it
 * here — Edit is offered only on a DRAFT row. The tab strip maps directly
 * onto server-side `status`/`settlement` query params, mirroring BillsPage.
 */

const PAGE_LIMIT = 50;

interface Tab {
  key: string;
  label: string;
  status: InvoiceStatus | '';
  settlement: SettlementFilter | '';
}

const TABS: Tab[] = [
  { key: 'all', label: 'All', status: '', settlement: '' },
  { key: 'draft', label: 'Draft', status: 'DRAFT', settlement: '' },
  { key: 'outstanding', label: 'Awaiting payment', status: 'ISSUED', settlement: 'OUTSTANDING' },
  { key: 'overdue', label: 'Overdue', status: 'ISSUED', settlement: 'OVERDUE' },
  { key: 'paid', label: 'Paid', status: 'ISSUED', settlement: 'PAID' },
  { key: 'void', label: 'Void', status: 'VOID', settlement: '' },
];

function settlementLabel(status: SettlementStatus): string | null {
  if (status === 'OVERDUE') return 'Overdue';
  if (status === 'PARTIALLY_PAID') return 'Partially paid';
  if (status === 'PAID') return 'Paid';
  if (status === 'UNPAID') return 'Unpaid';
  return null;
}

function statusPill(status: InvoiceStatus) {
  if (status === 'DRAFT') {
    return <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Draft</span>;
  }
  if (status === 'ISSUED') {
    return (
      <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
        Issued
      </span>
    );
  }
  return (
    <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20">
      Void
    </span>
  );
}

export default function InvoicesPage() {
  const [params, setParams] = useSearchParams();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const status = (params.get('status') ?? '') as InvoiceStatus | '';
  const settlement = (params.get('settlement') ?? '') as SettlementFilter | '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const q = params.get('q') ?? '';
  // Server-side sort (2026-09-30), kept in the URL like the filters so a
  // sorted view is linkable. An unknown value falls back to the default.
  const SORT_KEYS: readonly InvoiceSortKey[] = ['issueDate', 'dueDate', 'number', 'customer', 'total', 'status'];
  const sortParam = params.get('sort');
  const sort: SortState<InvoiceSortKey> = {
    key: SORT_KEYS.find((k) => k === sortParam) ?? 'issueDate',
    direction: params.get('dir') === 'asc' ? 'asc' : 'desc',
  };
  function toggleSort(key: InvoiceSortKey) {
    const next = new URLSearchParams(params);
    const direction = key === sort.key ? (sort.direction === 'asc' ? 'desc' : 'asc') : 'asc';
    next.set('sort', key);
    next.set('dir', direction);
    next.delete('page');
    setParams(next);
  }
  const [qDraft, setQDraft] = useDebouncedInput(q, (v) => setFilter('q', v));
  const page = Number(params.get('page') ?? '1');
  const anyFilterSet = status !== '' || settlement !== '' || from !== '' || to !== '' || q !== '';
  const activeTab = TABS.find((t) => t.status === status && t.settlement === settlement)?.key ?? 'all';

  useEffect(() => {
    let ignore = false;
    setError(null);

    const filters: Parameters<typeof listInvoices>[0] = { page, limit: PAGE_LIMIT };
    if (status !== '') filters.status = status;
    if (settlement !== '') filters.settlement = settlement;
    if (from !== '') filters.from = from;
    if (to !== '') filters.to = to;
    if (q !== '') filters.q = q;
    if (sortParam !== null) {
      filters.sort = sort.key;
      filters.dir = sort.direction;
    }

    listInvoices(filters)
      .then((res) => {
        if (ignore) return;
        setInvoices(res.invoices);
        setTotalCount(res.totalCount);
        setTotalPages(res.totalPages);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setError(err instanceof Error ? err.message : 'Could not load invoices');
        // Never leave a previous filter's results on screen under a failed one —
        // that reads as "this invoice is in both tabs" instead of "this tab failed".
        setInvoices([]);
        setTotalCount(0);
        setLoaded(true);
      });

    return () => {
      ignore = true;
    };
  }, [status, settlement, from, to, q, page, sortParam, sort.key, sort.direction]);

  function selectTab(tab: Tab) {
    const next = new URLSearchParams(params);
    if (tab.status === '') next.delete('status');
    else next.set('status', tab.status);
    if (tab.settlement === '') next.delete('settlement');
    else next.set('settlement', tab.settlement);
    next.delete('page');
    setParams(next);
  }

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    next.delete('page');
    setParams(next);
  }

  function clearFilters() {
    setParams({});
  }

  function goToPage(next: number) {
    const nextParams = new URLSearchParams(params);
    if (next <= 1) nextParams.delete('page');
    else nextParams.set('page', String(next));
    setParams(nextParams);
  }

  const inputClass =
    'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Invoices</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Sales invoices. Issuing one posts a balanced journal entry; correcting one means
            voiding it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ImportButton kind="INVOICES" returnTo="/invoices" />
          <Link
            to="/invoices/new"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium no-underline bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors"
          >
            <Plus size={15} /> New invoice
          </Link>
        </div>
      </header>

      <nav className="flex flex-wrap gap-1 border-b border-[var(--border)]" aria-label="Invoice status">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => selectTab(tab)}
            aria-current={activeTab === tab.key ? 'page' : undefined}
            className={[
              'px-3 py-2 text-sm border-0 border-b-2 bg-transparent cursor-pointer -mb-px',
              activeTab === tab.key
                ? 'border-[var(--text)] text-[var(--text)] font-medium'
                : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFilter('from', e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setFilter('to', e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
          <span className="text-[var(--muted)]">Search</span>
          <input
            type="text"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            placeholder="Invoice number or customer"
            className={inputClass}
          />
        </label>
        {anyFilterSet && (
          <button type="button" onClick={clearFilters} className="btn btn--ghost">
            Clear filters
          </button>
        )}
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
      {!loaded && error === null && <LoadingState />}

      {loaded && (
        <>
          {totalCount === 0 ? (
            <p className="muted">
              {anyFilterSet ? (
                'No invoices match these filters.'
              ) : (
                <>
                  Nothing invoiced yet.{' '}
                  <Link to="/invoices/new">Create the first invoice</Link>
                </>
              )}
            </p>
          ) : (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[48rem]">
                <thead>
                  <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                    <SortableHeader label="Number" sortKey="number" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Issue date" sortKey="issueDate" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Due date" sortKey="dueDate" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Customer" sortKey="customer" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Total" sortKey="total" sort={sort} onSort={toggleSort} align="right" />
                    <th className="p-3 font-medium text-right">Due</th>
                    <th className="p-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr key={invoice.id} className="border-t border-[var(--border)]">
                      <td className="p-3 font-mono text-xs">
                        {invoice.invoiceNumber ?? (
                          <span className="text-[var(--muted)] uppercase tracking-wide">Draft</span>
                        )}
                      </td>
                      <td className="p-3 tabular-nums whitespace-nowrap">{formatDate(invoice.issueDate)}</td>
                      <td className="p-3 tabular-nums whitespace-nowrap">{formatDate(invoice.dueDate)}</td>
                      <td className="p-3">{invoice.customerNameSnapshot}</td>
                      <td className="p-3">
                        <div className="flex flex-col gap-1">
                          {statusPill(invoice.status)}
                          {settlementLabel(invoice.settlementStatus) !== null && (
                            <span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
                              {settlementLabel(invoice.settlementStatus)}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-3 text-right tabular-nums">{formatCents(invoice.totalCents)}</td>
                      <td className="p-3 text-right tabular-nums">
                        {invoice.status === 'ISSUED' ? formatCents(invoice.amountDueCents) : '—'}
                      </td>
                      <td className="p-3">
                        <div className="flex items-center justify-end gap-2">
                          <Link
                            to={`/invoices/${invoice.id}`}
                            className="px-2 py-1 rounded-md text-xs no-underline text-[var(--muted)] hover:text-[var(--text)] border border-[var(--border)]"
                          >
                            View
                          </Link>
                          {invoice.status === 'DRAFT' && (
                            <Link
                              to={`/invoices/${invoice.id}/edit`}
                              className="px-2 py-1 rounded-md text-xs no-underline text-[var(--muted)] hover:text-[var(--text)] border border-[var(--border)]"
                            >
                              Edit
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {totalCount > 0 && (
            <Pagination
              page={page}
              totalPages={totalPages}
              shownCount={invoices.length}
              totalCount={totalCount}
              noun="invoices"
              onPageChange={goToPage}
            />
          )}
        </>
      )}
    </section>
  );
}
