import { useEffect, useState } from 'react';
import { Boxes, AlertTriangle, CalendarClock, MapPin, Wallet } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { formatQuantityMilli } from '../../utils/quantity';
import MetricTile from '../ledger-core/MetricTile';
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
 * render as small local cards in the same visual language instead.
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
    return <p>Loading…</p>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-[var(--text)]">Dashboard</h1>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="card">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Active items</p>
            <Boxes size={16} aria-hidden="true" className="text-[var(--muted)]" />
          </div>
          <p className="text-2xl font-semibold m-0 mt-2 tabular-nums">{summary.activeItemCount}</p>
        </div>

        <MetricTile
          label="Stock value"
          valueCents={summary.totalValueCents}
          currency={currency}
          icon={Wallet}
          tone="neutral"
          to={null}
          hint={null}
        />

        <div className="card">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Low stock</p>
            <AlertTriangle size={16} aria-hidden="true" className={summary.lowStockItemCount > 0 ? 'text-[var(--bad)]' : 'text-[var(--muted)]'} />
          </div>
          <p className="text-2xl font-semibold m-0 mt-2 tabular-nums">{summary.lowStockItemCount}</p>
        </div>

        <div className="card">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Lots expiring in 30 days</p>
            <CalendarClock size={16} aria-hidden="true" className={summary.expiringLotCount > 0 ? 'text-[var(--bad)]' : 'text-[var(--muted)]'} />
          </div>
          <p className="text-2xl font-semibold m-0 mt-2 tabular-nums">{summary.expiringLotCount}</p>
        </div>

        <div className="card">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Locations</p>
            <MapPin size={16} aria-hidden="true" className="text-[var(--muted)]" />
          </div>
          <p className="text-2xl font-semibold m-0 mt-2 tabular-nums">{summary.locationCount}</p>
        </div>
      </div>

      <section aria-label="Low stock items" className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--text)]">Low stock</h2>
        {lowStockItems.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Nothing is below its reorder point.</p>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-[var(--muted)]">
                <th className="pr-3 py-1">Code</th>
                <th className="pr-3 py-1">Name</th>
                <th className="pr-3 py-1">On hand</th>
              </tr>
            </thead>
            <tbody>
              {lowStockItems.map((item) => (
                <tr key={item.id} className="border-t border-[var(--border)]">
                  <td className="pr-3 py-1 text-[var(--text)]">{item.code}</td>
                  <td className="pr-3 py-1 text-[var(--text)]">{item.name}</td>
                  <td className="pr-3 py-1 text-[var(--text)]">
                    {formatQuantityMilli(item.onHandQuantityMilli)} {item.uomCode}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Recent movements" className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--text)]">Recent movements</h2>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-[var(--muted)]">
              <th className="pr-3 py-1">Date</th>
              <th className="pr-3 py-1">Type</th>
              <th className="pr-3 py-1">Item</th>
              <th className="pr-3 py-1">Location</th>
              <th className="pr-3 py-1">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {recentMovements.map((m) => (
              <tr key={m.id} className="border-t border-[var(--border)]">
                <td className="pr-3 py-1 text-[var(--muted)]">{m.occurredOn}</td>
                <td className="pr-3 py-1 text-[var(--text)]">{m.movementType}</td>
                <td className="pr-3 py-1 text-[var(--text)]">{m.itemCode}</td>
                <td className="pr-3 py-1 text-[var(--muted)]">{m.locationCode}</td>
                <td className="pr-3 py-1 text-[var(--text)]">{formatQuantityMilli(m.quantityMilli)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
