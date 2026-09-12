import { Navigate, Route, Routes } from 'react-router-dom';
import TaxGuardSidebar from './TaxGuardSidebar';
import TaxGuardCorpusPage from './TaxGuardCorpusPage';
import TaxGuardCorpusDetailPage from './TaxGuardCorpusDetailPage';
import TaxGuardAskPage from './TaxGuardAskPage';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * TaxGuard's own routes, rendered inside AppFrame's outlet — the app owns
 * its internal routing rather than registering pages in App.tsx
 * (guardrails rule 16's client-side counterpart).
 *
 * No onboarding gate here, mirroring FP&A Engine, AP-Flow, ForecasterPro,
 * UnitEcon and BoardDeck: Phase 16 has no setup wizard for TaxGuard.
 */
export default function TaxGuardRoutes() {
  const base = useAppBasePath();

  return (
    <div className="flex flex-col md:flex-row md:gap-6 px-4 md:px-6">
      <TaxGuardSidebar />
      <div className="min-w-0 flex-1 py-6 max-w-[76rem]">
        <Routes>
          <Route index element={<Navigate to="corpus" replace />} />
          <Route path="corpus" element={<TaxGuardCorpusPage />} />
          <Route path="corpus/:id" element={<TaxGuardCorpusDetailPage />} />
          <Route path="ask" element={<TaxGuardAskPage />} />
          <Route path="*" element={<Navigate to={base} replace />} />
        </Routes>
      </div>
    </div>
  );
}
