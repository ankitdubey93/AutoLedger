import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, AlertTriangle, CalendarClock, ClipboardList, History, MapPin, Scale, Wallet } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { formatQuantityMilli } from '../../utils/quantity';
import { formatCents } from '../../utils/money';
import MetricTile from '../../components/ui/MetricTile';
import StatTile from '../../components/ui/StatTile';
import EmptyState from '../../components/ui/EmptyState';
import { SkeletonCards } from '../../components/ui/Skeleton';
import {
  fetchInventoryValuation,
  fetchStockItems,
  fetchStockSettings,
  fetchStockMovements,
  fetchStockSummary,
  type InventoryValuation,
  type StockItem,
  type StockMovement,
  type StockSummary,
} from '../../services/fetchServices';

/**
 * The inventory section of the dashboard: summary tiles, a low-stock table
 * and the latest movements. It was Inventory's own dashboard page until
 * Phase 33 folded it into the product's single dashboard. Until inventory is
 * set up it renders one invitation card instead, because inventory is
 * optional.
 *
 * `Stock value` is money, so it uses MetricTile (built around `valueCents` and
 * a currency). The other four tiles are plain counts, which a cents formatter
 * would misrepresent (42 items is not $0.42), so they render on StatTileCount
 * below in the same visual language.
 */
export default function InventoryOverview() {
  const auth = useAuth();
  const currency = auth.status === 'authenticated' ? (auth.organization?.baseCurrency ?? '') : '';

  const [summary, setSummary] = useState<StockSummary | null>(null);
  const [lowStockItems, setLowStockItems] = useState<StockItem[]>([]);
  const [recentMovements, setRecentMovements] = useState<StockMovement[]>([]);
  const [valuation, setValuation] = useState<InventoryValuation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let ignore = false;
    fetchStockSettings()
      .then(async (settingsRes) => {
        if (ignore) return;
        setConfigured(settingsRes.settings.configured);
        if (!settingsRes.settings.configured) return;
        const [summaryRes, itemsRes, movementsRes] = await Promise.all([
          fetchStockSummary(),
          fetchStockItems({ lowStock: true, limit: 10 }),
          fetchStockMovements({ limit: 10 }),
        ]);
        if (ignore) return;
        setSummary(summaryRes.summary);
        setLowStockItems(itemsRes.items);
        setRecentMovements(movementsRes.movements);
        // Valuation is a secondary tile — its own request, so a failure there
        // (e.g. a viewer without access) never blocks the rest of the page.
        fetchInventoryValuation()
          .then((valuationRes) => {
            if (!ignore) setValuation(valuationRes.valuation);
          })
          .catch(() => undefined);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load inventory');
      });
    return () => {
      ignore = true;
    };
  }, []);

  const heading = (
    <div className="flex items-baseline justify-between gap-4">
      <h2 className="text-base font-semibold m-0 flex items-center gap-2">
        <Boxes size={16} aria-hidden="true" className="text-[var(--muted)]" /> Inventory
      </h2>
      {configured === true && <Link to="/inventory/items">Stock on hand</Link>}
    </div>
  );

  if (error !== null) {
    return (
      <section aria-label="Inventory" className="space-y-3">
        {heading}
        <p role="alert" className="text-sm text-[var(--bad)]">
          {error}
        </p>
      </section>
    );
  }

  if (configured === false) {
    return (
      <section aria-label="Inventory" className="space-y-3">
        {heading}
        <EmptyState
          icon={Boxes}
          title="Keep stock? Set up inventory"
          body="Pick an industry template to track quantities and costs. Bills then receive stock and invoices post cost of goods sold automatically."
          action={
            <Link to="/inventory/setup" className="btn no-underline">
              Set up inventory
            </Link>
          }
        />
      </section>
    );
  }

  if (summary === null) {
    return (
      <section aria-label="Inventory" className="space-y-3" aria-busy="true">
        {heading}
        <SkeletonCards count={5} />
        <span className="visually-hidden">Loading inventory…</span>
      </section>
    );
  }

  return (
    <section aria-label="Inventory" className="space-y-6">
      {heading}

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

        {valuation !== null && (
          <StatTile
            label="General ledger"
            icon={Scale}
            tone={valuation.tiesOut ? 'good' : 'bad'}
            value={valuation.tiesOut ? 'Ties out' : `Differs by ${formatCents(valuation.totalDifferenceCents)} ${currency}`}
            to="/inventory/valuation"
          />
        )}

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
        <h3 className="text-sm font-medium text-[var(--text)] flex items-center gap-1.5">
          <ClipboardList size={14} aria-hidden="true" className="text-[var(--muted)]" /> Low stock
        </h3>
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
        <h3 className="text-sm font-medium text-[var(--text)] flex items-center gap-1.5">
          <History size={14} aria-hidden="true" className="text-[var(--muted)]" /> Recent movements
        </h3>
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
    </section>
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
