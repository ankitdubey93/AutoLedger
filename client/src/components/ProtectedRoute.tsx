import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Gates every authenticated route.
 *
 * The `checking` branch is the important one. Without it, the first render on
 * a page reload sees "not authenticated yet" and redirects to /login — then
 * the session check resolves a moment later and bounces the user back. That
 * flash is the single most common bug in cookie-session React apps, and it is
 * caused by treating "we do not know yet" as "logged out".
 *
 * This is a client-side gate for UX only. It is not security: every protected
 * route is independently enforced by the auth middleware on the server, which
 * is the boundary that actually matters.
 */
export default function ProtectedRoute() {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === 'checking') {
    return (
      <div className="shell" aria-busy="true">
        <div className="skeleton skeleton--title" />
        <div className="skeleton skeleton--card" />
        <span className="visually-hidden">Restoring your session…</span>
      </div>
    );
  }

  if (auth.status === 'anonymous') {
    // `replace` keeps the protected URL out of history, so Back does not land
    // on a page that will immediately redirect again. `state.from` lets the
    // login page return the user where they were headed.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}
