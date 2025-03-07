import { BrowserRouter as Router, Routes, Route } from "react-router-dom"
import HomePage from "./Pages/HomePage"
import Dashboard from "./Pages/Dashboard"
import JournalEntriesPage from "./Pages/JournalEntries"

const App = () => {
  
  return (
    <Router>
      
      
      
      
      <Routes>
        <Route path="/" element={<HomePage />}/>
        <Route path="/dashboard" element={<Dashboard/>}/>
        <Route path="/journal-entries" element={<JournalEntriesPage/>}/>
      </Routes>
      
      
   
    </Router>
  )
}

export default App
