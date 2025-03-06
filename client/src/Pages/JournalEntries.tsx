import React, {useState, useEffect} from "react";
import jwtDecode from 'jwt-decode';
import { useNavigate } from "react-router-dom";


interface JournalEntryLine {
      account: string;
      description: string;
      debit: number;
      credit: number;
}

interface JournalEntry {
    _id?: string;
    date: string;
    lines: JournalEntryLine[];
}

const JournalEntries: React.FC = () => {
    const [JournalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
    const [newEntry, setNewEntry] = useState<JournalEntry>({
        date: new Date().toISOString().split('T')[0],
        lines: [{account: '', description: '', debit: 0, credit: 0}],
    });

    const [isEditing, setIsEditing] = useState<boolean>(false);
    const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
    const navigate = useNavigate();

    useEffect(() => {
        const token = localStorage.getItem('token');
        if(token) {
            try {
                fetch(`/api/journal-entries`, {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                })
                .then((response) => response.json())
                .then((entries: JournalEntry[]) => setJournalEntries(entries))
                .catch((error) => console.error('Error fetching journal entries: ', error));
            } catch (error) {
                console.error('Error decoding token: ',error);
                navigate('/');
            }
        }else {
            navigate('/');
        }
    }, [navigate]);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => 
        setNewEntry({...newEntry, [e.target.name]: e.target.value});

    const addEntry = async () => {
        const token = localStorage.getItem('token');
        if(token) {
            try {
                await fetch('/api/journal-entries', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify(newEntry),
                });
                fetch('/api/journal-entries', {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                })
                .then((response) => response.json())
                .then((entries: JournalEntry[]) => setJournalEntries(entries));
                setNewEntry({
                    date: new Date().toISOString().split('T')[0],
                    account: '',
                    debit: 0;
                    credit: 0,
                });
            } catch (error) {
                console.error('Error adding entry: ', error);
            }
        }
    };
}