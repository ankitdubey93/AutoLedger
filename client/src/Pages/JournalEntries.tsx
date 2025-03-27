import React, { useState, useEffect, useCallback, useContext } from 'react';

import { AuthContext } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

interface AccountEntry {
    accountName: string;
    debit: number;
    credit: number;
}

interface JournalEntry {
    _id: string;
    date: string;
    description: string;
    accounts: AccountEntry[];
    userId: string;
}

const JournalEntries: React.FC = () => {
    const { isAuthenticated, username, logout } = useContext(AuthContext)!;
    const [entries, setEntries] = useState<JournalEntry[]>([]);
    const [newDate, setNewDate] = useState<string>('');
    const [newDescription, setNewDescription] = useState<string>('');
    const [newAccounts, setNewAccounts] = useState<AccountEntry[]>([
        { accountName: '', debit: 0, credit: 0 },
    ]);
    const [error, setError] = useState<string | null>(null);
    const navigate = useNavigate();

    const fetchEntries = useCallback(async () => {
        try {
            const token = localStorage.getItem('token');
            if (!token) return;

            const response = await fetch('/api/journal-entries', {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();

            setEntries(data);
        } catch (error) {
            console.error('Error fetching journal entries: ', error);
        }
    }, [setEntries]);

    useEffect(() => {
        if (isAuthenticated) {
            fetchEntries();
        }
    }, [fetchEntries, isAuthenticated]);

    const handleAddEntry = async () => {
        if (!newDate || !newDescription.trim() || newAccounts.length === 0) {
            setError('Please fill in all fields before adding an entry.');
            return;
        }
        try {
            console.log('button clicked');
            const token = localStorage.getItem('token');

            if (!token) return;

            const response = await fetch('/api/journal-entries', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    date: new Date(newDate),
                    description: newDescription,
                    accounts: newAccounts,
                }),
            });
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            fetchEntries();
            setNewDate('');
            setNewDescription('');
            setNewAccounts([{ accountName: '', debit: 0, credit: 0 }]);
            setError(null);
        } catch (error) {
            console.error('Error adding journal entry: ', error);
            setError('Failed to add entry. Please try again.');
        }
    };

    const handleAccountChange = (
        index: number,
        field: keyof AccountEntry,
        value: string | number
    ) => {
        const updatedAccounts = [...newAccounts];
        updatedAccounts[index][field] = value as never;
        setNewAccounts(updatedAccounts);
    };

    const addAccountField = () => {
        setNewAccounts([
            ...newAccounts,
            { accountName: '', debit: 0, credit: 0 },
        ]);
    };

    return (
        <div>
            <header className="bg-blue-600 text-white p-4 flex justify-between items-center">
                <h1 className="text-2xl font-semibold">Journal Entries</h1>
                <button
                    onClick={() => navigate('/dashboard')}
                    className=" text-white font-bold py-2 px-4 rounded"
                >
                    Dashboard
                </button>
                <button
                    onClick={logout}
                    className="bg-red-500 hover:bg-red-700 text-white font-bold py-2 px-4 rounded"
                >
                    SignOut
                </button>
            </header>
            <div className="p-2">
                {username && (
                    <p className="text-gray-600 mb-4">
                        Logged in as {username}
                    </p>
                )}
                {error && <p className="text-red-500 font-semibold">{error}</p>}
                <div className="mb-4 flex space-x-2">
                    <input
                        type="date"
                        value={newDate}
                        onChange={(e) => setNewDate(e.target.value)}
                        className="border rounded p-2"
                    />
                    <input
                        type="text"
                        placeholder="Description"
                        value={newDescription}
                        onChange={(e) => setNewDescription(e.target.value)}
                        className="border rounded p-2"
                    />
                </div>
                {newAccounts.map((account, index) => (
                    <div key={index} className="mb-2 flex space-x-2">
                        <input
                            type="text"
                            placeholder="Account Name"
                            value={account.accountName}
                            onChange={(e) =>
                                handleAccountChange(
                                    index,
                                    'accountName',
                                    e.target.value
                                )
                            }
                            className="border rounded p-2"
                        />
                        <input
                            type="number"
                            placeholder="Debit"
                            value={account.debit}
                            onChange={(e) =>
                                handleAccountChange(
                                    index,
                                    'debit',
                                    Number(e.target.value)
                                )
                            }
                            className="border rounded p-2"
                        />
                        <input
                            type="number"
                            placeholder="Credit"
                            value={account.credit}
                            onChange={(e) =>
                                handleAccountChange(
                                    index,
                                    'credit',
                                    Number(e.target.value)
                                )
                            }
                            className="border rounded p-2"
                        />
                    </div>
                ))}
                <button
                    onClick={addAccountField}
                    className="bg-green-500 hover:bg-green-700 text-white font-bold py-2 px-4 rounded mb-2"
                >
                    Add Account
                </button>
                <button
                    onClick={handleAddEntry}
                    className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
                >
                    Add Entry
                </button>
            </div>
            <div>
                <ul className="space-y-2">
                    {entries.map((entry) => (
                        <li key={entry._id} className="border rounded p-2">
                            <div>
                                {entry.date.slice(0, 10)} - {entry.description}
                            </div>
                            <ul>
                                {entry.accounts.map((account, i) => (
                                    <li key={i} className="ml-4">
                                        {account.accountName} - Debit:{' '}
                                        {account.debit}, Credit:{' '}
                                        {account.credit}
                                    </li>
                                ))}
                            </ul>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
};

export default JournalEntries;
