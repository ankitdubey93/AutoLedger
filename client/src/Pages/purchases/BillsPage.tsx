import StatusPill from '../../components/ui/StatusPill';
import SlidingTabs from '../../components/ui/SlidingTabs';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  listBills,
  type Bill,
  type BillStatus,
  type SettlementFilter,
  type SettlementStatus,
  type BillSortKey,
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
 * The bill register — every accounts-payable document, filterable and
 * paginated. The tab strip maps directly onto server-side `status` and
 * `settlement` query params — nothing is filtered client-side, matching the
 * existing invoice register's filter-lives-in-the-URL idiom.
 *
 * "To review" is the bill approval queue — bills entered but not yet
 * approved. This is not an employee expense-claim inbox; AutoLedger has no
 * such document.
 */

const PAGE_LIMIT = 50;

interface Tab {
  key: string;
  label: string;
  status: BillStatus | '';
  settlement: SettlementFilter | '';
}

const TABS: Tab[] = [
  { key: 'all', label: 'All', status: '', settlement: '' },
  { key: 'draft', label: 'Draft', status: 'DRAFT', settlement: '' },
  { key: 'review', label: 'To review', status: 'AWAITING_APPROVAL', settlement: '' },
  { key: 'outstanding', label: 'Awaiting payment', status: 'POSTED', settlement: 'OUTSTANDING' },
  { key: 'overdue', label: 'Overdue', status: 'POSTED', settlement: 'OVERDUE' },
  { key: 'paid', label: 'Paid', status: 'POSTED', settlement: 'PAID' },
  { key: 'void', label: 'Void', status: 'VOID', settlement: '' },
];

function statusPill(status: BillStatus, settlement: SettlementStatus) {
  if (status === 'DRAFT') return <StatusPill tone="neutral" label="Draft" />;
  if (status === 'AWAITING_APPROVAL') return <StatusPill tone="warn" label="In review" />;
  if (status === 'VOID') return <StatusPill tone="neutral" label="Void" voided />;
  if (settlement === 'OVERDUE') return <StatusPill tone="danger" label="Overdue" />;
  if (settlement === 'PAID') return <StatusPill tone="good" label="Paid" />;
  if (settlement === 'PARTIALLY_PAID') return <StatusPill tone="info" label="Partially paid" />;
  if (settlement === 'UNPAID') return <StatusPill tone="info" label="Awaiting payment" />;
  return <StatusPill tone="good" label="Posted" />;
}

export default function BillsPage() {
  const [params, setParams] = useSearchParams();
  const [bills, setBills] = useState<Bill[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const status = (params.get('status') ?? '') as BillStatus | '';
  const settlement = (params.get('settlement') ?? '') as SettlementFilter | '';
  const q = params.get('q') ?? '';
  // Server-side sort (2026-09-30), kept in the URL like the filters so a
  // sorted view is linkable. An unknown value falls back to the default.
  const SORT_KEYS: readonly BillSortKey[] = ['billDate', 'dueDate', 'reference', 'vendor', 'total', 'status'];
  const sortParam = params.get('sort');
  const sort: SortState<BillSortKey> = {
    key: SORT_KEYS.find((k) => k === sortParam) ?? 'billDate',
    direction: params.get('dir') === 'asc' ? 'asc' : 'desc',
  };
  function toggleSort(key: BillSortKey) {
    const next = new URLSearchParams(params);
    const direction = key === sort.key ? (sort.direction === 'asc' ? 'desc' : 'asc') : 'asc';
    next.set('sort', key);
    next.set('dir', direction);
    next.delete('page');
    setParams(next);
  }
  const [qDraft, setQDraft] = useDebouncedInput(q, setSearch);
  const page = Number(params.get('page') ?? '1');

  const activeTab = TABS.find((t) => t.status === status && t.settlement === settlement)?.key ?? 'all';

  useEffect(() => {
    let ignore = false;
    setError(null);

    const filters: Parameters<typeof listBills>[0] = { page, limit: PAGE_LIMIT };
    if (status !== '') filters.status = status;
    if (settlement !== '') filters.settlement = settlement;
    if (q !== '') filters.q = q;
    if (sortParam !== null) {
      filters.sort = sort.key;
      filters.dir = sort.direction;
    }

    listBills(filters)
      .then((res) => {
        if (ignore) return;
        setBills(res.bills);
        setTotalCount(res.totalCount);
        setTotalPages(res.totalPages);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setError(err instanceof Error ? err.message : 'Could not load expenses');
        // Never leave a previous filter's results on screen under a failed one —
        // that reads as "this bill is in both tabs" instead of "this tab failed".
        setBills([]);
        setTotalCount(0);
        setLoaded(true);
      });

    return () => {
      ignore = true;
    };
  }, [status, settlement, q, page, sortParam, sort.key, sort.direction]);

  function selectTab(tab: Tab) {
    const next = new URLSearchParams(params);
    if (tab.status === '') next.delete('status');
    else next.set('status', tab.status);
    if (tab.settlement === '') next.delete('settlement');
    else next.set('settlement', tab.settlement);
    next.delete('page');
    setParams(next);
  }

  function setSearch(value: string) {
    const next = new URLSearchParams(params);
    if (value === '') next.delete('q');
    else next.set('q', value);
    next.delete('page');
    setParams(next);
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
          <h2 className="page-title m-0">Expenses</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Expenses entered against vendors. Approving one posts a balanced journal entry; correcting one
            means voiding it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ImportButton kind="BILLS" returnTo="/expenses" />
          <Link
            to="/expenses/new"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium no-underline bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors"
          >
            <Plus size={15} /> New expense
          </Link>
        </div>
      </header>

      <SlidingTabs ariaLabel="Expense status" tabs={TABS} isActive={(tab) => activeTab === tab.key} onSelect={(tab) => selectTab(tab)} />

      <label className="flex flex-col gap-1 text-sm max-w-xs">
        <span className="text-[var(--muted)]">Search</span>
        <input
          type="text"
          value={qDraft}
          onChange={(e) => setQDraft(e.target.value)}
          placeholder="Vendor reference or name"
          className={inputClass}
        />
      </label>

      {error !== null && <p className="status status--bad">{error}</p>}
      {!loaded && error === null && <LoadingState />}

      {loaded && (
        <>
          {totalCount === 0 ? (
            <p className="muted">
              {activeTab !== 'all' || q !== '' ? (
                'No expenses match these filters.'
              ) : (
                <>
                  Nothing entered yet. <Link to="/expenses/new">Create the first expense</Link>
                </>
              )}
            </p>
          ) : (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[54rem]">
                <thead>
                  <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                    <SortableHeader label="Vendor" sortKey="vendor" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Reference" sortKey="reference" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Expense date" sortKey="billDate" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Due date" sortKey="dueDate" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Total" sortKey="total" sort={sort} onSort={toggleSort} align="right" />
                    <th className="p-3 font-medium text-right">Due</th>
                    <th className="p-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((bill) => {
                    return (
                      <tr key={bill.id} className={`border-t border-[var(--border)] ${bill.settlementStatus === 'OVERDUE' ? 'bg-[var(--bad-soft)] hover:!bg-[var(--bad-soft)]' : ''}`}>
                        <td className="p-3">{bill.vendorNameSnapshot}</td>
                        <td className="p-3 font-mono text-xs">{bill.vendorReference}</td>
                        <td className="p-3 tabular-nums whitespace-nowrap">{formatDate(bill.billDate)}</td>
                        <td className="p-3 tabular-nums whitespace-nowrap">{formatDate(bill.dueDate)}</td>
                        <td className="p-3">
                          {statusPill(bill.status, bill.settlementStatus)}
                        </td>
                        <td className="p-3 text-right tabular-nums">{formatCents(bill.totalCents)}</td>
                        <td className="p-3 text-right tabular-nums">
                          {bill.status === 'POSTED' ? formatCents(bill.amountDueCents) : '—'}
                        </td>
                        <td className="p-3">
                          <div className="flex items-center justify-end gap-2">
                            <Link
                              to={`/expenses/${bill.id}`}
                              className="px-2 py-1 rounded-md text-xs no-underline text-[var(--muted)] hover:text-[var(--text)] border border-[var(--border)]"
                            >
                              View
                            </Link>
                            <Link
                              to={`/expenses/new?copyFrom=${bill.id}`}
                              className="px-2 py-1 rounded-md text-xs no-underline text-[var(--muted)] hover:text-[var(--text)] border border-[var(--border)]"
                            >
                              Duplicate
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {totalCount > 0 && (
            <Pagination
              page={page}
              totalPages={totalPages}
              shownCount={bills.length}
              totalCount={totalCount}
              noun="expenses"
              onPageChange={goToPage}
            />
          )}
        </>
      )}
    </section>
  );
}
