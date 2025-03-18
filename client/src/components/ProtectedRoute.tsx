import { JSX } from 'react';
import { useContext } from 'react';
import { AuthContext } from '../context/AuthContext';
import { Navigate } from 'react-router-dom';

const ProtectedRoute = ({ children }: { children: JSX.Element }) => {
    const authContext = useContext(AuthContext);

    if (!authContext) {
        return <Navigate to="/" />;
    }

    const { isAuthenticated } = authContext;

    return isAuthenticated ? children : <Navigate to="/" replace />;

    return children;
};

export default ProtectedRoute;
