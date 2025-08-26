import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import HomePage from './Pages/HomePage';
import { AuthProvider } from './context/AuthContext';
import Dashboard from './Pages/Dashboard';

const App = () => {
    return (
        <Router>
            <AuthProvider>
            <Routes>
                <Route path='/' element={<HomePage />}/>
                <Route path='/dashboard' element={<Dashboard/>}/>
            </Routes>
            </AuthProvider>
        </Router>
    );
};

export default App;
