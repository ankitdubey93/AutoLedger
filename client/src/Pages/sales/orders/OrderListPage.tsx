import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  listOrders,
  type OrderBillingStatus,
  type OrderStatus,
  type OrderSummary,
} from '../../../services/fetchServices';
import { formatCents } from '../../../utils/money';
import { formatDate } from '../../../utils/date';
import { useCan } from '../../../context/AuthContext';
import Pagination from '../../../components/ui/Pagination';
import LoadingState from '../../../components/ui/LoadingState';
import type { OrderKindConfig } from './orderKinds';

/**
 * The order register (Phase 42), sales or purchase. Tabs filter on the
 * order's own status; the Billing column says how much of it has been
 * invoiced or billed yet.
 */

const PAGE_LIMIT = 50;

const TABS: { key: string; label: string; status: OrderStatus | '' }[] = [
  { key: 'all', label: 'All', status: '' },
  { key: 'draft', label: 'Draft', status: 'DRAFT' },
  { key: 'confirmed', label: 'Confirmed', status: 'CONFIRMED' },
  { key: 'closed', label: 'Closed', status: 'CLOSED' },
  { key: 'cancelled', label: 'Cancelled', status: 'CANCELLED' },
];

const STATUS_LABELS: Record<OrderStatus, string> = {
  DRAFT: 'Draft',
  CONFIRMED: 'Confirmed',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

const BILLING_LABELS: Record<OrderBillingStatus, string> = {
  NOT_BILLED: 'Not billed',
  PARTIALLY_BILLED: 'Partly billed',
  FULLY_BILLED: 'Fully billed',
};

export function orderStatusLabel(status: OrderStatus): string {
  return STATUS_LABELS[status];
}

export function orderBillingLabel(status: OrderBillingStatus): string {
  return BILLING_LABELS[status];
}

export function orderLabel(order: { orderNumber: string | null }): string {
  return order.orderNumber ?? 'Draft';
}

export function OrderStatusPill({ status }: { status: OrderStatus }) {
  const tone =
    status === 'CANCELLED'
      ? 'text-[var(--bad)] ring-[var(--bad)]'
      : status === 'DRAFT'
        ? 'text-[var(--muted)] ring-[var(--border)]'
        : 'text-[var(--good)] ring-[var(--good)]';
  return (
    <span className={`text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full ring-1 ring-inset ${tone}`}>
      {orderStatusLabel(status)}
    </span>
  );
}

export default function OrderListPage({ config }: { config: OrderKindConfig }) {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const status = (params.get('status') ?? '') as OrderStatus | '';
  const page = Number(params.get('page') ?? '1');

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    listOrders(config.direction, { page, limit: PAGE_LIMIT, status }, controller.signal)
      .then((res) => {
        setOrders(res.orders);
        setTotalCount(res.totalCount);
        setTotalPages(res.totalPages);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : `Could not load ${config.plural.toLowerCase()}`);
        setOrders([]);
        setTotalCount(0);
        setLoaded(true);
      });
    return () => controller.abort();
  }, [config, status, page]);

  function selectTab(next: OrderStatus | '') {
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
                  <th className="p-3 font-medium">Order date</th>
                  <th className="p-3 font-medium">{config.partyNoun}</th>
                  <th className="p-3 font-medium">Expected</th>
                  <th className="p-3 font-medium">Status</th>
                  <th className="p-3 font-medium">Billing</th>
                  <th className="p-3 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="border-t border-[var(--border)]">
                    <td className="p-3 font-mono text-xs">
                      <Link to={`/${config.path}/${order.id}`}>{orderLabel(order)}</Link>
                    </td>
                    <td className="p-3 tabular-nums whitespace-nowrap">{formatDate(order.orderDate)}</td>
                    <td className="p-3">{order.partyName}</td>
                    <td className="p-3 tabular-nums whitespace-nowrap">
                      {order.expectedDate === null ? '—' : formatDate(order.expectedDate)}
                    </td>
                    <td className="p-3">
                      <OrderStatusPill status={order.status} />
                    </td>
                    <td className="p-3 text-[var(--muted)]">{orderBillingLabel(order.billingStatus)}</td>
                    <td className="p-3 text-right tabular-nums whitespace-nowrap">
                      {formatCents(order.totalCents)} {order.currencyCode}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            totalPages={totalPages}
            shownCount={orders.length}
            totalCount={totalCount}
            noun="orders"
            onPageChange={goToPage}
          />
        </>
      )}
    </section>
  );
}
