import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import HomePage from './Pages/HomePage';
import { AuthProvider } from './context/AuthContext';
import Dashboard from './Pages/Dashboard';
import ProtectedRoute from './components/ProtectedRoute';
import JournalEntries from './Pages/JournalEntries';
import Reports from './Pages/Reports';
import Settings from './Pages/Settings';

const App = () => {
    return (
        <Router>
            <AuthProvider>
            <Routes>
                <Route path='/' element={<HomePage />}/>
                <Route path='/dashboard' element={<ProtectedRoute><Dashboard/></ProtectedRoute>}/>
                <Route path='/journal-entries' element={<ProtectedRoute><JournalEntries/></ProtectedRoute>}/>
                <Route path='/reports' element={<ProtectedRoute><Reports/></ProtectedRoute>}/>
                <Route path='/settings' element={<ProtectedRoute><Settings/></ProtectedRoute>}/>
            </Routes>
            </AuthProvider>
        </Router>
    );
};

export default App;
