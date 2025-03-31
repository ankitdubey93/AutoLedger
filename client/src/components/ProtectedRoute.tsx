import { ReactNode } from 'react';
import { useContext } from 'react';
import { AuthContext } from '../context/AuthContext';
import { Navigate, Outlet } from 'react-router-dom';

interface ProtectedRouteProps {
    children?: ReactNode; // Accepts both direct children and nested routes
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
    const authContext = useContext(AuthContext);

    if (!authContext) {
        return <Navigate to="/" />;
    }

    const { isAuthenticated } = authContext;

    return isAuthenticated ? (
        children || <Outlet />
    ) : (
        <Navigate to="/" replace />
    );
};

export default ProtectedRoute;
