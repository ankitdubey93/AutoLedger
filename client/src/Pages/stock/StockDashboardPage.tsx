import { useEffect, useState } from 'react';
import { Boxes, AlertTriangle, CalendarClock, ClipboardList, History, MapPin, Wallet } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { formatQuantityMilli } from '../../utils/quantity';
import MetricTile from '../ledger-core/MetricTile';
import PageHeader from '../../components/ui/PageHeader';
import EmptyState from '../../components/ui/EmptyState';
import { SkeletonCards } from '../../components/ui/Skeleton';
import {
  fetchStockItems,
  fetchStockMovements,
  fetchStockSummary,
  type StockItem,
  type StockMovement,
  type StockSummary,
} from '../../services/fetchServices';

/**
 * StockLedger's dashboard: the summary tiles, a low-stock table and the
 * latest movements. `Stock value` is genuine money, so it reuses
 * `ledger-core/MetricTile` (which is built around `valueCents` + a
 * currency); the other four tiles are plain counts, which running through
 * a cents formatter would misrepresent (42 items is not $0.42), so they
 * render on the shared `StatTile` primitive instead (via MetricTile's
 * sibling usage below), in the same visual language.
 */
export default function StockDashboardPage() {
  const auth = useAuth();
  const currency = auth.status === 'authenticated' ? (auth.organization?.baseCurrency ?? '') : '';

  const [summary, setSummary] = useState<StockSummary | null>(null);
  const [lowStockItems, setLowStockItems] = useState<StockItem[]>([]);
  const [recentMovements, setRecentMovements] = useState<StockMovement[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetchStockSummary(),
      fetchStockItems({ lowStock: true, limit: 10 }),
      fetchStockMovements({ limit: 10 }),
    ])
      .then(([summaryRes, itemsRes, movementsRes]) => {
        setSummary(summaryRes.summary);
        setLowStockItems(itemsRes.items);
        setRecentMovements(movementsRes.movements);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the dashboard'));
  }, []);

  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-[var(--bad)]">
        {error}
      </p>
    );
  }

  if (summary === null) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="skeleton skeleton--title" />
        <SkeletonCards count={5} />
        <span className="visually-hidden">Loading dashboard…</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader as="h1" icon={Boxes} title="Dashboard" />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatTileCount label="Active items" value={summary.activeItemCount} icon={Boxes} />

        <MetricTile
          label="Stock value"
          valueCents={summary.totalValueCents}
          currency={currency}
          icon={Wallet}
          tone="neutral"
          to={null}
          hint={null}
        />

        <StatTileCount
          label="Low stock"
          value={summary.lowStockItemCount}
          icon={AlertTriangle}
          bad={summary.lowStockItemCount > 0}
        />

        <StatTileCount
          label="Lots expiring in 30 days"
          value={summary.expiringLotCount}
          icon={CalendarClock}
          bad={summary.expiringLotCount > 0}
        />

        <StatTileCount label="Locations" value={summary.locationCount} icon={MapPin} />
      </div>

      <section aria-label="Low stock items" className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--text)] flex items-center gap-1.5">
          <ClipboardList size={14} aria-hidden="true" className="text-[var(--muted)]" /> Low stock
        </h2>
        {lowStockItems.length === 0 ? (
          <EmptyState icon={ClipboardList} title="Nothing is below its reorder point." />
        ) : (
          <div className="card p-0 overflow-hidden">
            <div className="table-scroll">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left text-[var(--muted)]">
                    <th className="px-3 py-2">Code</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">On hand</th>
                  </tr>
                </thead>
                <tbody>
                  {lowStockItems.map((item) => (
                    <tr key={item.id}>
                      <td className="px-3 py-2 text-[var(--text)]">{item.code}</td>
                      <td className="px-3 py-2 text-[var(--text)]">{item.name}</td>
                      <td className="px-3 py-2 text-[var(--text)]">
                        {formatQuantityMilli(item.onHandQuantityMilli)} {item.uomCode}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section aria-label="Recent movements" className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--text)] flex items-center gap-1.5">
          <History size={14} aria-hidden="true" className="text-[var(--muted)]" /> Recent movements
        </h2>
        {recentMovements.length === 0 ? (
          <EmptyState icon={History} title="No movements recorded yet." />
        ) : (
          <div className="card p-0 overflow-hidden">
            <div className="table-scroll">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left text-[var(--muted)]">
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2">Location</th>
                    <th className="px-3 py-2">Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {recentMovements.map((m) => (
                    <tr key={m.id}>
                      <td className="px-3 py-2 text-[var(--muted)]">{m.occurredOn}</td>
                      <td className="px-3 py-2 text-[var(--text)]">{m.movementType}</td>
                      <td className="px-3 py-2 text-[var(--text)]">{m.itemCode}</td>
                      <td className="px-3 py-2 text-[var(--muted)]">{m.locationCode}</td>
                      <td className="px-3 py-2 text-[var(--text)]">{formatQuantityMilli(m.quantityMilli)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** A plain-count tile (not money) in the same visual language as MetricTile/StatTile. */
function StatTileCount({
  label,
  value,
  icon: Icon,
  bad = false,
}: {
  label: string;
  value: number;
  icon: typeof Boxes;
  bad?: boolean;
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">{label}</p>
        <span
          aria-hidden="true"
          className={`flex size-7 items-center justify-center rounded-md ${bad ? 'bg-[var(--bad-soft)] text-[var(--bad)]' : 'bg-[var(--panel-2)] text-[var(--muted)]'}`}
        >
          <Icon size={15} />
        </span>
      </div>
      <p className="text-2xl font-semibold m-0 mt-2 tabular-nums">{value}</p>
    </div>
  );
}
