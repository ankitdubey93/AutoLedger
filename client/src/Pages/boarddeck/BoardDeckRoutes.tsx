import { Navigate, Route, Routes } from 'react-router-dom';
import BoardDeckSidebar from './BoardDeckSidebar';
import BoardDeckCloseRunsPage from './BoardDeckCloseRunsPage';
import BoardDeckBvaPage from './BoardDeckBvaPage';
import BoardDeckDecksPage from './BoardDeckDecksPage';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * BoardDeck's own routes, rendered inside AppFrame's outlet — the app owns
 * its internal routing rather than registering pages in App.tsx
 * (guardrails rule 16's client-side counterpart).
 *
 * No onboarding gate here, mirroring FP&A Engine, AP-Flow, ForecasterPro and
 * UnitEcon: Phase 15 has no setup wizard for BoardDeck.
 */
export default function BoardDeckRoutes() {
  const base = useAppBasePath();

  return (
    <div className="flex flex-col md:flex-row md:gap-6 px-4 md:px-6">
      <BoardDeckSidebar />
      <div className="min-w-0 flex-1 py-6 max-w-[76rem]">
        <Routes>
          <Route index element={<Navigate to="close" replace />} />
          <Route path="close" element={<BoardDeckCloseRunsPage />} />
          <Route path="bva" element={<BoardDeckBvaPage />} />
          <Route path="decks" element={<BoardDeckDecksPage />} />
          <Route path="*" element={<Navigate to={base} replace />} />
        </Routes>
      </div>
    </div>
  );
}
