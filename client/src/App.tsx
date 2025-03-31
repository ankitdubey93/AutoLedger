import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import HomePage from './Pages/HomePage';
import Dashboard from './Pages/Dashboard';
import JournalEntries from './Pages/JournalEntries';
import ProtectedRoute from './components/ProtectedRoute';
import AuthProvider from './context/AuthProvider';

const App = () => {
    return (
        <Router>
            <AuthProvider>
                <Routes>
                    <Route path="/" element={<HomePage />} />
                    <Route element={<ProtectedRoute />}>
                        <Route path="/dashboard" element={<Dashboard />} />
                        <Route
                            path="/journal-entries"
                            element={<JournalEntries />}
                        />
                    </Route>
                </Routes>
            </AuthProvider>
        </Router>
    );
};

export default App;
