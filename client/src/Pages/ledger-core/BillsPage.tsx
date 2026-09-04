import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  listBills,
  type Bill,
  type BillStatus,
  type SettlementFilter,
  type SettlementStatus,
} from '../../services/fetchServices';
import { formatCents } from './money';
import { useAppBasePath } from '../../apps/useAppBasePath';

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

function statusPill(status: BillStatus) {
  if (status === 'DRAFT') {
    return <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Draft</span>;
  }
  if (status === 'AWAITING_APPROVAL') {
    return (
      <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 ring-1 ring-inset ring-sky-500/20">
        In review
      </span>
    );
  }
  if (status === 'POSTED') {
    return (
      <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
        Posted
      </span>
    );
  }
  return (
    <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20">
      Void
    </span>
  );
}

function settlementLabel(status: SettlementStatus): string | null {
  if (status === 'OVERDUE') return 'Overdue';
  if (status === 'PARTIALLY_PAID') return 'Partially paid';
  if (status === 'PAID') return 'Paid';
  if (status === 'UNPAID') return 'Unpaid';
  return null;
}

export default function BillsPage() {
  const base = useAppBasePath();
  const [params, setParams] = useSearchParams();
  const [bills, setBills] = useState<Bill[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const status = (params.get('status') ?? '') as BillStatus | '';
  const settlement = (params.get('settlement') ?? '') as SettlementFilter | '';
  const q = params.get('q') ?? '';
  const page = Number(params.get('page') ?? '1');

  const activeTab = TABS.find((t) => t.status === status && t.settlement === settlement)?.key ?? 'all';

  useEffect(() => {
    let ignore = false;
    setError(null);

    const filters: Parameters<typeof listBills>[0] = { page, limit: PAGE_LIMIT };
    if (status !== '') filters.status = status;
    if (settlement !== '') filters.settlement = settlement;
    if (q !== '') filters.q = q;

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
        setError(err instanceof Error ? err.message : 'Could not load bills');
        // Never leave a previous filter's results on screen under a failed one —
        // that reads as "this bill is in both tabs" instead of "this tab failed".
        setBills([]);
        setTotalCount(0);
        setLoaded(true);
      });

    return () => {
      ignore = true;
    };
  }, [status, settlement, q, page]);

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
          <h2 className="text-lg font-semibold m-0">Bills</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Bills entered against vendors. Approving one posts a balanced journal entry; correcting one
            means voiding it.
          </p>
        </div>
        <Link
          to={`${base}/bills/new`}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium no-underline bg-[var(--text)] text-[var(--bg)]"
        >
          <Plus size={15} /> New bill
        </Link>
      </header>

      <nav className="flex flex-wrap gap-1 border-b border-[var(--border)]" aria-label="Bill status">
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

      <label className="flex flex-col gap-1 text-sm max-w-xs">
        <span className="text-[var(--muted)]">Search</span>
        <input
          type="text"
          value={q}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Vendor reference or name"
          className={inputClass}
        />
      </label>

      {error !== null && <p className="status status--bad">{error}</p>}
      {!loaded && error === null && <p className="muted">Loading…</p>}

      {loaded && (
        <>
          {totalCount === 0 ? (
            <p className="muted">
              {activeTab !== 'all' || q !== '' ? (
                'No bills match these filters.'
              ) : (
                <>
                  Nothing entered yet. <Link to={`${base}/bills/new`}>Create the first bill</Link>
                </>
              )}
            </p>
          ) : (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[54rem]">
                <thead>
                  <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                    <th className="p-3 font-medium">Vendor</th>
                    <th className="p-3 font-medium">Reference</th>
                    <th className="p-3 font-medium">Bill date</th>
                    <th className="p-3 font-medium">Due date</th>
                    <th className="p-3 font-medium">Status</th>
                    <th className="p-3 font-medium text-right">Total</th>
                    <th className="p-3 font-medium text-right">Due</th>
                    <th className="p-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((bill) => {
                    const label = settlementLabel(bill.settlementStatus);
                    return (
                      <tr key={bill.id} className="border-t border-[var(--border)]">
                        <td className="p-3">{bill.vendorNameSnapshot}</td>
                        <td className="p-3 font-mono text-xs">{bill.vendorReference}</td>
                        <td className="p-3 tabular-nums whitespace-nowrap">{bill.billDate}</td>
                        <td className="p-3 tabular-nums whitespace-nowrap">{bill.dueDate}</td>
                        <td className="p-3">
                          <div className="flex flex-col gap-1">
                            {statusPill(bill.status)}
                            {label !== null && (
                              <span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
                                {label}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="p-3 text-right tabular-nums">{formatCents(bill.totalCents)}</td>
                        <td className="p-3 text-right tabular-nums">
                          {bill.status === 'POSTED' ? formatCents(bill.amountDueCents) : '—'}
                        </td>
                        <td className="p-3">
                          <div className="flex items-center justify-end gap-2">
                            <Link
                              to={`${base}/bills/${bill.id}`}
                              className="px-2 py-1 rounded-md text-xs no-underline text-[var(--muted)] hover:text-[var(--text)] border border-[var(--border)]"
                            >
                              View
                            </Link>
                            <Link
                              to={`${base}/bills/new?copyFrom=${bill.id}`}
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
            <div className="flex items-center justify-between gap-4 text-sm text-[var(--muted)]">
              <span>
                Showing {bills.length} of {totalCount}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={page >= totalPages}
                  onClick={() => goToPage(page + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
