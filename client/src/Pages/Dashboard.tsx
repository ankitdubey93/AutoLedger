import React, { useContext, useEffect } from 'react';
import { AuthContext } from '../context/AuthContext';
import { Link, useNavigate } from 'react-router-dom';

const Dashboard: React.FC = () => {
    const auth = useContext(AuthContext)!;
    const navigate = useNavigate();

    useEffect(() => {
        if (!auth?.isAuthenticated) {
            navigate('/');
        }
    }, [auth, navigate]);

    return (
        <div className="min-h-screen bg-gray-100">
            <header className="bg-blue-600 text-white p-4 flex justify-between items-center">
                <h1 className="text-2xl font-semibold">AutoLedger Dashboard</h1>
                <button
                    onClick={auth?.logout}
                    className="bg-red-500 hover:bg-red-700 text-white font-bold py-2 px-4 rounded"
                >
                    SignOut
                </button>
                <nav>
                    <ul>
                        <li>
                            <Link to="/journal-entries">Journal Entries</Link>
                        </li>
                        {/* Add other dashboard links here */}
                    </ul>
                </nav>
            </header>
            <main className="container mx-auto p-4">
                <section className="bg-white p-4 rounded-md shadow-md mb-4">
                    <h2 className="text-lg font-semibold mb-2">
                        {auth?.username
                            ? `Welcome, ${auth?.username}!`
                            : `Welcome to your Dashboard!`}
                    </h2>
                    <p>This is where you will manage your finances.</p>
                </section>
            </main>
        </div>
    );
};

export default Dashboard;
