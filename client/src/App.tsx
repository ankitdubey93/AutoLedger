import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { OrgProvider } from './context/OrgContext';
import ProtectedRoute from './components/ProtectedRoute';
import AppShell from './components/layout/AppShell';
import WorkspaceLayout from './routes/WorkspaceLayout';
import ProductRoutes from './routes/ProductRoutes';
import LegacyAppRedirect from './routes/LegacyAppRedirect';
import LoginPage from './Pages/auth/LoginPage';
import RegisterPage from './Pages/auth/RegisterPage';
import ForgotPasswordPage from './Pages/auth/ForgotPasswordPage';
import ResetPasswordPage from './Pages/auth/ResetPasswordPage';
import InvitePage from './Pages/auth/InvitePage';
import EmailLinkPage from './Pages/auth/EmailLinkPage';
import NotFoundPage from './Pages/NotFoundPage';
import AccountPage from './Pages/AccountPage';
import DocumentsPage from './Pages/DocumentsPage';
import NewOrganizationPage from './Pages/organizations/NewOrganizationPage';
import DocumentTitle from './components/DocumentTitle';

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
          <DocumentTitle />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            {/* Phase 37 — public: the invitee may not have an account yet. */}
            <Route path="/invite/:token" element={<InvitePage />} />
            {/* Phase 38b — emailed links; public, the token is the proof. */}
            <Route path="/verify-email" element={<EmailLinkPage kind="verify" />} />
            <Route path="/confirm-email-change" element={<EmailLinkPage kind="change" />} />

            <Route element={<ProtectedRoute />}>
              <Route element={<AppShell />}>
                <Route path="/app/:appSlug/*" element={<LegacyAppRedirect />} />

                <Route element={<WorkspaceLayout />}>
                  <Route path="/account" element={<AccountPage />} />
                  <Route path="/documents" element={<DocumentsPage />} />
                  {/* Phase 37 — outside SetupGate, like /account: reachable from an organization mid-setup. */}
                  {/* Phase 38a — the list moved into Account settings. */}
                  <Route path="/organizations" element={<Navigate to="/account?tab=organizations" replace />} />
                  <Route path="/organizations/new" element={<NewOrganizationPage />} />
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
