import { Navigate, Route, Routes } from 'react-router-dom';
import UniteconSidebar from './UniteconSidebar';
import UniteconCohortsPage from './UniteconCohortsPage';
import UniteconUnitEconomicsPage from './UniteconUnitEconomicsPage';
import UniteconPvmPage from './UniteconPvmPage';
import UniteconSettingsPage from './UniteconSettingsPage';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * UnitEcon's own routes, rendered inside AppFrame's outlet — the app owns
 * its internal routing rather than registering pages in App.tsx
 * (guardrails rule 16's client-side counterpart).
 *
 * No onboarding gate here, mirroring FP&A Engine, AP-Flow and ForecasterPro:
 * Phase 14 has no setup wizard for UnitEcon.
 */
export default function UniteconRoutes() {
  const base = useAppBasePath();

  return (
    <div className="flex flex-col md:flex-row md:gap-6 px-4 md:px-6">
      <UniteconSidebar />
      <div className="min-w-0 flex-1 py-6 max-w-[76rem]">
        <Routes>
          <Route index element={<Navigate to="cohorts" replace />} />
          <Route path="cohorts" element={<UniteconCohortsPage />} />
          <Route path="unit-economics" element={<UniteconUnitEconomicsPage />} />
          <Route path="pvm" element={<UniteconPvmPage />} />
          <Route path="settings" element={<UniteconSettingsPage />} />
          <Route path="*" element={<Navigate to={base} replace />} />
        </Routes>
      </div>
    </div>
  );
}
