import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { Boxes } from 'lucide-react';
import EmptyState from '../components/ui/EmptyState';
import { fetchStockSettings, type StockSettings } from '../services/fetchServices';

/**
 * Inventory is optional. An organization that has never applied an industry
 * template has no categories to put an item in, so every inventory page
 * shows one "not tracking stock yet" state. Its first action is the plain
 * product form with "Track inventory" ticked — creating a tracked product sets
 * inventory up silently — and the template picker is the second. Before Phase 33 this was a hard redirect
 * to the setup page, which made a Products & inventory link look broken to
 * someone who does not keep stock.
 */
export default function InventoryGate() {
  const location = useLocation();
  const [settings, setSettings] = useState<StockSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchStockSettings(controller.signal)
      .then((res) => setSettings(res.settings))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Could not load inventory settings');
      });
    return () => controller.abort();
  }, []);

  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-[var(--bad)]">
        {error}
      </p>
    );
  }

  if (settings === null) {
    return (
      <div aria-busy="true">
        <div className="skeleton skeleton--title" />
        <span className="visually-hidden">Loading inventory…</span>
      </div>
    );
  }

  if (!settings.configured) {
    const returnTo = encodeURIComponent(`${location.pathname}${location.search}`);
    return (
      <EmptyState
        icon={Boxes}
        title="You are not tracking stock yet"
        body="Add a product and tick “Track inventory” — AutoLedger sets inventory up for you. Or start from an industry template with ready-made categories and item codes."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Link to="/products?new=1&track=1" className="btn no-underline">
              Add a tracked product
            </Link>
            <Link to={`/inventory/setup?returnTo=${returnTo}`} className="btn btn--ghost no-underline">
              Choose an industry template
            </Link>
          </div>
        }
      />
    );
  }

  return <Outlet />;
}
