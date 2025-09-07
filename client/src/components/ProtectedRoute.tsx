import { useAuth } from "../context/AuthContext";
import { Navigate } from "react-router-dom";


interface ProtectedRouteProps {
    children: React.ReactNode;
}


const ProtectedRoute: React.FC<ProtectedRouteProps> = ({children}) => {
    const {isLoggedIn} = useAuth();

    if (!isLoggedIn) {
    return <Navigate to="/" replace />;
  }


    return <>{children}</>
};


export default ProtectedRoute;