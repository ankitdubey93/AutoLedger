import { Navigate, Route, Routes } from 'react-router-dom';
import FpaSidebar from './FpaSidebar';
import FpaModelsPage from './FpaModelsPage';
import NewFpaModelPage from './NewFpaModelPage';
import FpaModelDetailPage from './FpaModelDetailPage';
import FpaProjectionPage from './FpaProjectionPage';
import FpaComparisonPage from './FpaComparisonPage';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * FP&A Engine's own routes, rendered inside AppFrame's outlet — the app owns
 * its internal routing rather than registering pages in App.tsx (guardrails
 * rule 16's client-side counterpart).
 *
 * No onboarding gate here, unlike LedgerCore's: Phase 12 has no setup wizard
 * for FP&A Engine, exactly as AP-Flow has none.
 *
 * Literal path segments ("new", "compare/:modelId", "scenarios/:scenarioId")
 * are declared before the sibling ":id" route — a sibling param route would
 * otherwise swallow them as an id, the same ordering rule ApFlowRoutes.tsx
 * documents.
 */
export default function FpaRoutes() {
  const base = useAppBasePath();

  return (
    <div className="flex flex-col md:flex-row md:gap-6 px-4 md:px-6">
      <FpaSidebar />
      <div className="min-w-0 flex-1 py-6 max-w-[76rem]">
        <Routes>
          <Route index element={<FpaModelsPage />} />
          <Route path="new" element={<NewFpaModelPage />} />
          <Route path="compare/:modelId" element={<FpaComparisonPage />} />
          <Route path="scenarios/:scenarioId" element={<FpaProjectionPage />} />
          <Route path=":id" element={<FpaModelDetailPage />} />
          <Route path="*" element={<Navigate to={base} replace />} />
        </Routes>
      </div>
    </div>
  );
}
