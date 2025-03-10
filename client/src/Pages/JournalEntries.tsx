import React, { useState, useEffect, useCallback } from 'react';

interface JournalEntry {
    _id: string;
    date: string;
    description: string;
    amount: number;
    userId: string;
}



const JournalEntries: React.FC = () => {
    
    const [entries, setEntries] = useState<JournalEntry[]>([]);
    const [newDate, setNewDate] = useState<string>('');
    const [newDescription, setNewDescription] = useState<string>('');
    const [newAmount, setNewAmount] = useState<number>(0);


   


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





    return (
        <div>
            <h2>Journal Entries</h2>
        <div>
            <input type='date'></input>
            <input type='text' placeholder='Description'></input>
            <input type='text' placeholder='Amount'></input>
            <button onClick={handleAddEntry}>Add Entry</button>
        </div>
        <div>
            <ul>
                {entries.map(entry => (
                    <li key={entry._id}>
                        {new Date(entry.date).toLocaleDateString('en-CA')} - {entry.description}- {entry.amount}
                    </li>
                ))}
            </ul>
        </div>
      
        </div>
    )
}



export default JournalEntries;