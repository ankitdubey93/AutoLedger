import { jwtDecode } from 'jwt-decode';
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

interface JournalEntry {
    _id: string;
    date: string;
    description: string;
    amount: number;
    userId: string;
}

interface DecodedToken {
    user: {
        id: string;
    };

    exp: number;
}


const JournalEntries: React.FC = () => {
    
    const [entries, setEntries] = useState<JournalEntry[]>([]);
    const [newDate, setNewDate] = useState<string>('');
    const [newDescription, setNewDescription] = useState<string>('');
    const [newAmount, setNewAmount] = useState<number>(0);
    const [editingEntry, setEditingEntry] = useState<JournalEntry | null>(null);
    const [editDate,setEditDate] = useState<string>('');
    const [editDescription, setEditDescription] = useState<string>('');
    const [editAmount, setEditAmount] = useState<number>(0);
    const [isAuthenticated, setIsAuthenticated] = useState<boolean>(true);

    const navigate = useNavigate();


    const checkAuth = useCallback(() => {
        const token = localStorage.getItem("token");
        if(!token) {
            setIsAuthenticated(false);
            return;
        }

        try {
            const decoded = jwtDecode<DecodedToken>(token);
            if(decoded.exp < Math.floor(Date.now()/1000)) {
            console.warn("Token expired!");
            localStorage.removeItem("token");
            setIsAuthenticated(false);
            }
        } catch (error) {
            console.error("Error decoding token: ", error);
            localStorage.removeItem("token");
            setIsAuthenticated(false);
        }
    }, []);

    useEffect(() => {
        checkAuth();
        const interval = setInterval(checkAuth, 5000);
        const handleStorageChange = (e: StorageEvent) => {
            if(e.key === "token" && !e.newValue) {
                setIsAuthenticated(false);
            }
        };
        window.addEventListener("storage", handleStorageChange);


        return () => {
            clearInterval(interval);
            window.removeEventListener("storage", handleStorageChange);
        }
    }, [checkAuth]);


    useEffect(() => {
        if(!isAuthenticated) {
            navigate('/');
        }
    }, [navigate, isAuthenticated]);


    const fetchEntries =useCallback( async() => {
        try {
            const token = localStorage.getItem('token');
            const response = await fetch('/api/journal-entries', {
                headers: {
                    Authorization: `Bearer ${token}`
                },
            });
            if(!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            console.log(data);
            setEntries(data);
        } catch (error) {
            console.error('Error fetching journal entries: ', error);
        }
    }, [setEntries]);

    useEffect(() => {
        fetchEntries();
    },[fetchEntries]);


    const handleAddEntry = async () => {
        try {
            console.log('button clicked')
            const token = localStorage.getItem('token');
            const response = await fetch('/api/journal-entries', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    date: new Date(newDate),
                    description: newDescription,
                    amount: newAmount,
                }),
            });
            if(!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            fetchEntries();
            setNewDate('');
            setNewDescription('');
            setNewAmount(0);
        } catch (error) {
            console.error('Error adding journal entry: ', error);        }
    }

    const handleEdit = (entry: JournalEntry) => {
        setEditingEntry(entry);
        setEditDate(entry.date.slice(0,10));
        setEditDescription(entry.description);
        setEditAmount(entry.amount);
    };

    const handleUpdateEntry = async () => {
        try {
            if (!editingEntry) return;

            const token = localStorage.getItem('token');
            const response = await fetch(`/api/journal-entries/${editingEntry._id}`,{
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    date: new Date(editDate).toISOString(),
                    description: editDescription,
                    amount: editAmount,
                }),
            });

            if(!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            fetchEntries();
            setEditingEntry(null);
        } catch (error) {
            console.error('Error updating journal entry:', error);
        }
    };

    const handleDeleteEntry = async (id: string) => {
        try {
            const token = localStorage.getItem('token');
            const response = await fetch(`/api/journal-entries/${id}`,{
                method: 'DELETE',
                headers: {
                    Authorization: `Bearer ${token}`
                },
            });
            if(!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            fetchEntries();
        } catch (error) {
            console.error('Error deleting journal entry: ', error);
        }
    };



    return (
        <div className="p-4">
            <h2 className="text-2xl font-bold mb-4">Journal Entries</h2>
            <div className="mb-4 flex space-x-2">
                <input type='date' value={newDate} onChange={(e) => setNewDate(e.target.value)} className="border rounded p-2" />
                <input type='text' placeholder='Description' value={newDescription} onChange={(e) => setNewDescription(e.target.value)} className="border rounded p-2" />
                <input type='number' placeholder='Amount' value={newAmount} onChange={(e) => setNewAmount(Number(e.target.value))} className="border rounded p-2" />
                <button onClick={handleAddEntry} className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded">Add Entry</button>
            </div>
            <div>
                <ul className="space-y-2">
                    {entries.map(entry => (
                        <li key={entry._id} className="border rounded p-2 flex justify-between items-center">
                            {editingEntry?._id === entry._id ? (
                                <div className="flex space-x-2 items-center">
                                    <input type='date' value={editDate} onChange={(e) => setEditDate(e.target.value)} className="border rounded p-1" />
                                    <input type='text' value={editDescription} onChange={(e) => setEditDescription(e.target.value)} className="border rounded p-1" />
                                    <input type='number' value={editAmount} onChange={(e) => setEditAmount(Number(e.target.value))} className="border rounded p-1" />
                                    <button onClick={handleUpdateEntry} className="bg-green-500 hover:bg-green-700 text-white font-bold py-1 px-2 rounded">Update</button>
                                    <button onClick={() => setEditingEntry(null)} className="bg-gray-500 hover:bg-gray-700 text-white font-bold py-1 px-2 rounded">Cancel</button>
                                </div>
                            ) : (
                                <span className="flex-grow">
                                    {entry.date.slice(0, 10)} - {entry.description} - {entry.amount}
                                </span>
                            )}
                            {editingEntry?._id !== entry._id && (
                                <div className="space-x-2">
                                    <button onClick={() => handleEdit(entry)} className="bg-yellow-500 hover:bg-yellow-700 text-white font-bold py-1 px-2 rounded">Edit</button>
                                    <button onClick={() => handleDeleteEntry(entry._id)} className="bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded">Delete</button>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}



export default JournalEntries;