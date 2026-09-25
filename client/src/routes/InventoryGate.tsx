import { useEffect, useState } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { Boxes } from 'lucide-react';
import EmptyState from '../components/ui/EmptyState';
import { fetchStockSettings, type StockSettings } from '../services/fetchServices';

/**
 * Inventory is optional. An organization that has never applied an industry
 * template has no categories to put an item in, so every inventory page
 * shows one "set up inventory" state. Before Phase 33 this was a hard redirect
 * to the setup page, which made a Products & inventory link look broken to
 * someone who does not keep stock.
 */
export default function InventoryGate() {
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
    return (
      <EmptyState
        icon={Boxes}
        title="Inventory is not set up yet"
        body="Choose an industry template to get categories, item codes and a first location. Services and non-stock products work without it."
        action={
          <Link to="/inventory/setup" className="btn no-underline">
            Set up inventory
          </Link>
        }
      />
    );
  }

  return <Outlet />;
}
