import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { OrgProvider } from './context/OrgContext';
import ProtectedRoute from './components/ProtectedRoute';
import AppLayout from './components/layout/AppLayout';
import LoginPage from './Pages/auth/LoginPage';
import RegisterPage from './Pages/auth/RegisterPage';
import DashboardPage from './Pages/DashboardPage';
import NotFoundPage from './Pages/NotFoundPage';

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
              <Route element={<AppLayout />}>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/dashboard" element={<Navigate to="/" replace />} />
              </Route>
            </Route>

            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </OrgProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
