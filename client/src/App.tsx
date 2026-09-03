import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { OrgProvider } from './context/OrgContext';
import ProtectedRoute from './components/ProtectedRoute';
import PlatformLayout from './components/layout/PlatformLayout';
import AppFrame from './components/layout/AppFrame';
import LoginPage from './Pages/auth/LoginPage';
import RegisterPage from './Pages/auth/RegisterPage';
import AppChooserPage from './Pages/AppChooserPage';
import AccountPage from './Pages/AccountPage';
import NotFoundPage from './Pages/NotFoundPage';
import ActiveAppRoutes from './apps/ActiveAppRoutes';

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
 * Two sibling shells inside ProtectedRoute, not nested: PlatformLayout is the
 * suite shell (brand, org switcher, account, sign out), used only by the
 * chooser at "/" and /account. AppFrame is the per-app shell, mounted at
 * /app/:appSlug — inside an app, the suite header does not render at all;
 * AppFrame's own AppTopBar shrinks AutoLedger to a small mark-and-link and
 * gives the app itself top billing.
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
              </Route>

              {/*
                One splat child, not one Route per app. The app that owns
                :appSlug is resolved at render time and brings its own nested
                routes — LedgerCore ships three pages, and generating sibling
                `index` routes per slug would make several routes match the
                same path with the first winning regardless of the slug.
              */}
              <Route path="/app/:appSlug" element={<AppFrame />}>
                <Route path="*" element={<ActiveAppRoutes />} />
                <Route index element={<ActiveAppRoutes />} />
              </Route>
            </Route>

            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </OrgProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
