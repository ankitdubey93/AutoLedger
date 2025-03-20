import { useState, ReactNode, useEffect, useCallback } from 'react';
import { AuthContext } from './AuthContext';
import { useNavigate } from 'react-router-dom';

const AuthProvider = ({ children }: { children: ReactNode }) => {
    const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
    const [username, setUsername] = useState<string | null>(null);
    const navigate = useNavigate();

    const logout = useCallback(() => {
        console.log('Logging out...');
        localStorage.removeItem('token');
        localStorage.removeItem('username');
        setIsAuthenticated(false);
        setUsername(null);
        navigate('/');
    }, [navigate]);

    useEffect(() => {
        const verifyToken = async () => {
            console.log('Verifying token....');
            const token = localStorage.getItem('token');
            const storedUsername = localStorage.getItem('username');

            if (!token || !storedUsername) {
                console.log('No token or username found, logging out.');
                logout();
                return;
            }

            try {
                const response = await fetch('/api/auth/verify', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`,
                    },
                });

                if (response.ok) {
                    console.log('Token is valid!');
                    setUsername(storedUsername);
                    setIsAuthenticated(true);
                } else {
                    console.log('Invalid token, logging out.');
                    logout();
                }
            } catch (error) {
                console.error('Error verifying token:', error);
                logout();
            }
        };

        verifyToken();
    }, [logout]);

    const login = (token: string, username: string) => {
        console.log('Logging in with:', { token, username });
        localStorage.setItem('token', token);
        localStorage.setItem('username', username);
        setUsername(username);
        setIsAuthenticated(true);
        navigate('/dashboard');
    };

    return (
        <AuthContext.Provider
            value={{ isAuthenticated, username, login, logout }}
        >
            {children}
        </AuthContext.Provider>
    );
};

export default AuthProvider;
