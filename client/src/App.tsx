import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { OrgProvider } from './context/OrgContext';
import ProtectedRoute from './components/ProtectedRoute';
import PlatformLayout from './components/layout/PlatformLayout';
import AppShell from './components/layout/AppShell';
import LoginPage from './Pages/auth/LoginPage';
import RegisterPage from './Pages/auth/RegisterPage';
import AppChooserPage from './Pages/AppChooserPage';
import AccountPage from './Pages/AccountPage';
import NotFoundPage from './Pages/NotFoundPage';
import { APP_ELEMENTS } from './apps/registry';

/**
 * Provider composition, outermost first:
 *
 *   BrowserRouter → AuthProvider → OrgProvider → routes
 *
 * The router has to be outermost because the providers and ProtectedRoute use
 * router hooks (`useLocation`, `<Navigate>`), and a hook cannot reach a
 * context that is mounted below it. OrgProvider sits inside AuthProvider
 * because the active organization is derived from the session rather than
 * stored separately — see context/OrgContext.tsx.
 *
 * Two nested layouts inside ProtectedRoute: PlatformLayout is the suite shell
 * (brand, org switcher, account, sign out); AppShell is the per-app shell,
 * mounted only under /app/:appSlug. The chooser at "/" and /account render
 * directly inside PlatformLayout — they are suite-level, not app-level.
 */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <OrgProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />

            {/* Everything below requires a session. */}
            <Route element={<ProtectedRoute />}>
              <Route element={<PlatformLayout />}>
                <Route path="/" element={<AppChooserPage />} />
                <Route path="/account" element={<AccountPage />} />
                <Route path="/dashboard" element={<Navigate to="/account" replace />} />

                {/*
                  One child Route per app, keyed by slug. A "/*" catch-all for
                  an app's own nested routes lands here once an app ships more
                  than an index page — none has yet.
                */}
                <Route path="/app/:appSlug" element={<AppShell />}>
                  {Object.entries(APP_ELEMENTS).map(([slug, Element]) => (
                    <Route key={slug} index element={<Element />} />
                  ))}
                </Route>
              </Route>
            </Route>

            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </OrgProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
