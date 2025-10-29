import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import HomePage from './Pages/HomePage';
import { AuthProvider } from './context/AuthContext';
import Dashboard from './Pages/Dashboard';
import ProtectedRoute from './components/ProtectedRoute';
import JournalEntries from './Pages/JournalEntries';
import Transaction from './Pages/Transactions';

const App = () => {
    return (
        <Router>
            <AuthProvider>
            <Routes>
                <Route path='/' element={<HomePage />}/>
                <Route path='/dashboard' element={<ProtectedRoute><Dashboard/></ProtectedRoute>}/>
                <Route path='/transactions' element={<ProtectedRoute><Transaction/></ProtectedRoute>}/>
                <Route path='/journal-entries' element={<ProtectedRoute><JournalEntries/></ProtectedRoute>}/>
            </Routes>
            </AuthProvider>
        </Router>
    );
};

export default App;
