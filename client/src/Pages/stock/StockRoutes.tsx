import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import StockSidebar from './StockSidebar';
import StockSetupPage from './StockSetupPage';
import StockDashboardPage from './StockDashboardPage';
import StockItemsPage from './StockItemsPage';
import StockNewItemPage from './StockNewItemPage';
import StockItemDetailPage from './StockItemDetailPage';
import StockMovementPage from './StockMovementPage';
import StockLocationsPage from './StockLocationsPage';
import StockLabelsPage from './StockLabelsPage';
import StockLookupPage from './StockLookupPage';
import StockScanRedirect from './StockScanRedirect';
import StockCatalogueSettingsPage from './StockCatalogueSettingsPage';
import StockCodeSchemesPage from './StockCodeSchemesPage';
import { fetchStockSettings, type StockSettings } from '../../services/fetchServices';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * StockLedger's own routes, rendered inside AppFrame's outlet — the app
 * owns its internal routing rather than registering pages in App.tsx
 * (guardrails rule 16's client-side counterpart).
 *
 * Unlike UnitEcon/FP&A/AP-Flow/ForecasterPro, StockLedger DOES gate on
 * onboarding: an org that has never applied an industry profile is
 * redirected to `/setup` on every other route, because there is nothing
 * useful to show before a category exists to put an item in.
 */
export default function StockRoutes() {
  const base = useAppBasePath();
  const location = useLocation();
  const [settings, setSettings] = useState<StockSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchStockSettings(controller.signal)
      .then((res) => setSettings(res.settings))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Could not load StockLedger settings');
      });
    return () => controller.abort();
  }, []);

  if (error !== null) {
    return (
      <div className="px-4 md:px-6 py-6">
        <p role="alert" className="text-sm text-[var(--bad)]">
          {error}
        </p>
      </div>
    );
  }

  if (settings === null) {
    return (
      <div className="px-4 md:px-6 py-6">
        <p>Loading…</p>
      </div>
    );
  }

  const isSetupPath = location.pathname === `${base}/setup`;
  if (!settings.configured && !isSetupPath) {
    return <Navigate to={`${base}/setup`} replace />;
  }

  return (
    <div className="flex flex-col md:flex-row md:gap-6 px-4 md:px-6">
      <StockSidebar />
      <div className="min-w-0 flex-1 py-6">
        <Routes>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="setup" element={<StockSetupPage />} />
          <Route path="dashboard" element={<StockDashboardPage />} />
          <Route path="items" element={<StockItemsPage />} />
          <Route path="items/new" element={<StockNewItemPage />} />
          <Route path="items/:id" element={<StockItemDetailPage />} />
          <Route path="movements" element={<StockMovementPage />} />
          <Route path="locations" element={<StockLocationsPage />} />
          <Route path="labels" element={<StockLabelsPage />} />
          <Route path="lookup" element={<StockLookupPage />} />
          <Route path="scan/:kind/:id" element={<StockScanRedirect />} />
          <Route path="settings" element={<StockCatalogueSettingsPage />} />
          <Route path="settings/codes" element={<StockCodeSchemesPage />} />
          <Route path="*" element={<Navigate to={base} replace />} />
        </Routes>
      </div>
    </div>
  );
}
