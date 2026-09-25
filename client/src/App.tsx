import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { OrgProvider } from './context/OrgContext';
import ProtectedRoute from './components/ProtectedRoute';
import AppShell from './components/layout/AppShell';
import WorkspaceLayout from './routes/WorkspaceLayout';
import ProductRoutes from './routes/ProductRoutes';
import LegacyAppRedirect from './routes/LegacyAppRedirect';
import LoginPage from './Pages/auth/LoginPage';
import RegisterPage from './Pages/auth/RegisterPage';
import NotFoundPage from './Pages/NotFoundPage';
import AccountPage from './Pages/AccountPage';
import DocumentsPage from './Pages/DocumentsPage';

/**
 * Provider composition, outermost first:
 *
 *   BrowserRouter → AuthProvider → OrgProvider → routes
 *
 * The router is outermost because the providers and ProtectedRoute use router
 * hooks, and a hook cannot reach a context mounted below it.
 *
 * Phase 33: one product, one route tree. Every signed-in page renders in
 * AppShell. Product pages sit behind SetupGate, which sends a new
 * organization to the setup wizard. /account and /documents do not, so an
 * organization that is mid-setup can still reach them. Pre-Phase-33
 * `/app/<slug>/...` URLs, including printed QR labels, go through
 * LegacyAppRedirect.
 */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <OrgProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />

            <Route element={<ProtectedRoute />}>
              <Route element={<AppShell />}>
                <Route path="/app/:appSlug/*" element={<LegacyAppRedirect />} />

                <Route element={<WorkspaceLayout />}>
                  <Route path="/account" element={<AccountPage />} />
                  <Route path="/documents" element={<DocumentsPage />} />
                </Route>

                <Route path="/*" element={<ProductRoutes />} />
              </Route>
            </Route>

            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </OrgProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
