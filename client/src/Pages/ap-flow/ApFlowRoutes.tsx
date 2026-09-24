import { Navigate, Route, Routes } from 'react-router-dom';
import ApFlowDocumentsPage from './ApFlowDocumentsPage';
import ApFlowDocumentDetailPage from './ApFlowDocumentDetailPage';
import ApFlowReviewQueuePage from './ApFlowReviewQueuePage';
import ApFlowSettingsPage from './ApFlowSettingsPage';
import ApFlowUsagePage from './ApFlowUsagePage';
import ApFlowSidebar from './ApFlowSidebar';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * AP-Flow's own routes, rendered inside AppFrame's outlet — the app owns its
 * internal routing rather than registering pages in App.tsx (guardrails
 * rule 16's client-side counterpart).
 *
 * No onboarding gate here, unlike LedgerCore's: Phase 10 has no setup
 * wizard for AP-Flow.
 *
 * "review", "settings" and "usage" are literal paths and must come before
 * ":id" — a sibling param route would otherwise swallow any of them as an id.
 *
 * Phase 31 gives AP-Flow the same sidebar wrapper LedgerCore and StockLedger
 * already had, in place of the header links its pages used to carry alone.
 */
export default function ApFlowRoutes() {
  const base = useAppBasePath();

  return (
    <div className="flex flex-col md:flex-row md:gap-6 px-4 md:px-6">
      <ApFlowSidebar />
      <div className="min-w-0 flex-1 py-6">
        <Routes>
          <Route index element={<ApFlowDocumentsPage />} />
          <Route path="review" element={<ApFlowReviewQueuePage />} />
          <Route path="settings" element={<ApFlowSettingsPage />} />
          <Route path="usage" element={<ApFlowUsagePage />} />
          <Route path=":id" element={<ApFlowDocumentDetailPage />} />
          <Route path="*" element={<Navigate to={base} replace />} />
        </Routes>
      </div>
    </div>
  );
}
