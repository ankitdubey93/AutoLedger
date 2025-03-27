import Logo from '../../public/Logo-text-big.png';
import { useState, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import SignInForm from '../components/SignInForm';
import SignUpForm from '../components/SignUpForm';

const HomePage: React.FC = () => {
    const authContext = useContext(AuthContext);

    const isAuthenticated = authContext?.isAuthenticated || false;
    const login = authContext?.login || (() => {});

    const [isSignUp, setIsSignUp] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const navigate = useNavigate();

    useEffect(() => {
        if (isAuthenticated) {
            navigate('/dashboard');
        }
    }, [navigate, isAuthenticated]);

    const handleSignIn = async (username: string, password: string) => {
        setError('');
        try {
            const response = await fetch('/api/users/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                setError(errorData.message || 'Login failed.');
                return;
            }

            const data = await response.json();
            login(data.token, username);
            navigate('/dashboard');
        } catch (err) {
            console.log('API error:', err);
            setError('An unexpected error occurred.');
        }
    };

    const handleSignUp = async (
        username: string,
        password: string,
        confirmPassword: string
    ) => {
        setError('');
        setSuccess('');
        if (password !== confirmPassword) {
            setError('Passwords do not match.');
            return;
        }
        try {
            const response = await fetch('/api/users/signup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                setError(errorData.message || 'Signup failed.');
                return;
            }

            setSuccess('Signup Successful, please login.');
            setIsSignUp(false);
        } catch (err) {
            console.error('API error:', err);
            setError('An unexpected error occurred.');
        }
    };

    return (
        <div className="flex flex-col items-center justify-start">
            <div>
                <img
                    width={200}
                    src={Logo}
                    alt="AutoLedger Logo"
                    className="max-w-xs mx-auto"
                />
            </div>
            <div className="bg-white p-8 rounded-md shadow-md w-96 mt-4">
                <h2 className="text-2xl font-semibold mb-4 text-center">
                    {error && (
                        <p className="text-red-500 text-sm mb-2">{error}</p>
                    )}
                    {success && (
                        <p className="text-green-500 text-sm mb-2">{success}</p>
                    )}
                    {isSignUp ? 'Sign Up' : 'Sign In'}
                </h2>
                {isSignUp ? (
                    <SignUpForm onSignUp={handleSignUp} error={error} />
                ) : (
                    <SignInForm onSignIn={handleSignIn} />
                )}
                <p className="text-center mt-4">
                    {isSignUp ? (
                        <>
                            Already have an account?{' '}
                            <button
                                className="text-blue-500 hover:underline"
                                onClick={() => setIsSignUp(false)}
                            >
                                Sign In
                            </button>
                        </>
                    ) : (
                        <>
                            Don't have an account?{' '}
                            <button
                                className="text-blue-500 hover:underline"
                                onClick={() => setIsSignUp(true)}
                            >
                                Sign Up
                            </button>
                        </>
                    )}
                </p>
            </div>
        </div>
    );
};

export default HomePage;
