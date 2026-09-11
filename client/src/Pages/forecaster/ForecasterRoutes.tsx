import { Navigate, Route, Routes } from 'react-router-dom';
import ForecasterSidebar from './ForecasterSidebar';
import ForecasterPlansPage from './ForecasterPlansPage';
import NewForecasterPlanPage from './NewForecasterPlanPage';
import ForecasterPlanDetailPage from './ForecasterPlanDetailPage';
import ForecasterForecastPage from './ForecasterForecastPage';
import ForecasterBudgetPage from './ForecasterBudgetPage';
import ForecasterVariancePage from './ForecasterVariancePage';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * ForecasterPro's own routes, rendered inside AppFrame's outlet — the app
 * owns its internal routing rather than registering pages in App.tsx
 * (guardrails rule 16's client-side counterpart).
 *
 * No onboarding gate here, mirroring FP&A Engine and AP-Flow: Phase 13 has
 * no setup wizard for ForecasterPro.
 *
 * Literal path segments ("new", "plans/:planId/forecast", etc.) are
 * declared before the sibling ":id" route — a sibling param route would
 * otherwise swallow them as an id, the same ordering rule FpaRoutes.tsx
 * documents.
 */
export default function ForecasterRoutes() {
  const base = useAppBasePath();

  return (
    <div className="flex flex-col md:flex-row md:gap-6 px-4 md:px-6">
      <ForecasterSidebar />
      <div className="min-w-0 flex-1 py-6 max-w-[76rem]">
        <Routes>
          <Route index element={<ForecasterPlansPage />} />
          <Route path="new" element={<NewForecasterPlanPage />} />
          <Route path="plans/:planId/forecast" element={<ForecasterForecastPage />} />
          <Route path="plans/:planId/budget" element={<ForecasterBudgetPage />} />
          <Route path="plans/:planId/variance" element={<ForecasterVariancePage />} />
          <Route path=":id" element={<ForecasterPlanDetailPage />} />
          <Route path="*" element={<Navigate to={base} replace />} />
        </Routes>
      </div>
    </div>
  );
}
