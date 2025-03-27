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
    const [editingEntry, setEditingEntry] = useState<JournalEntry | null>(null);
    const [editDate, setEditDate] = useState<string>('');
    const [editDescription, setEditDescription] = useState<string>('');
    const [editAccounts, setEditAccounts] = useState<AccountEntry[]>([]);
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
    }, []);

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

    const handleEdit = (entry: JournalEntry) => {
        setEditingEntry(entry);
        setEditDate(entry.date.slice(0, 10));
        setEditDescription(entry.description);
        setEditAccounts(entry.accounts);
    };

    const handleEditAccountChange = (
        index: number,
        field: keyof AccountEntry,
        value: string | number
    ) => {
        const updatedAccounts = [...editAccounts];
        updatedAccounts[index][field] = value as never;
        setEditAccounts(updatedAccounts);
    };

    const handleUpdateEntry = async () => {
        if (!editingEntry) return;

        try {
            const token = localStorage.getItem('token');
            if (!token) return;

            const response = await fetch(
                `/api/journal-entries/${editingEntry._id}`,
                {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({
                        date: new Date(editDate).toISOString(),
                        description: editDescription,
                        accounts: editAccounts,
                    }),
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            await fetchEntries();
            setEditingEntry(null);
        } catch (error) {
            console.error('Error updating journal entry:', error);
        }
    };

    const handleDeleteEntry = async (id: string) => {
        try {
            const token = localStorage.getItem('token');
            if (!token) return;

            const response = await fetch(`/api/journal-entries/${id}`, {
                method: 'DELETE',
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            fetchEntries();
        } catch (error) {
            console.error('Error deleting journal entry: ', error);
        }
    };

    const handleDeleteAccount = (
        index: number,
        isEditingPhase: boolean = false
    ) => {
        if (isEditingPhase) {
            const updatedAccounts = [...editAccounts];
            updatedAccounts.splice(index, 1);
            setEditAccounts(updatedAccounts);
        } else {
            const updatedAccounts = [...newAccounts];
            updatedAccounts.splice(index, 1);
            setNewAccounts(updatedAccounts);
        }
    };

    return (
        <div>
            <header className="bg-blue-600 text-white p-4 flex justify-between items-center">
                <h1 className="text-2xl font-semibold">Journal Entries</h1>
                <button
                    onClick={() => navigate('/dashboard')}
                    className="text-white font-bold py-2 px-4 rounded"
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
                        <button
                            onClick={() => handleDeleteAccount(index)}
                            className="bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded"
                        >
                            Delete Account
                        </button>
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
            <div className="overflow-x-auto">
                <table className="table-auto w-full mt-4">
                    <thead>
                        <tr className="border-b-2">
                            <th className="px-4 py-2 text-left">Date</th>
                            <th className="px-4 py-2 text-left">Description</th>
                            <th className="px-4 py-2 text-left">Accounts</th>
                            <th className="px-4 py-2 text-left">Debit</th>
                            <th className="px-4 py-2 text-left">Credit</th>
                        </tr>
                    </thead>
                    <tbody>
                        {entries.map((entry) => (
                            <tr key={entry._id} className="border-b">
                                <td className="px-4 py-2">
                                    {entry.date.slice(0, 10)}
                                </td>
                                <td className="px-4 py-2">
                                    {entry.description}
                                </td>
                                <td className="px-4 py-2">
                                    {entry.accounts.map((account, index) => (
                                        <div
                                            key={index}
                                            className="flex space-x-4"
                                        >
                                            <span>{account.accountName}</span>
                                        </div>
                                    ))}
                                </td>
                                <td className="px-4 py-2">
                                    {entry.accounts.map((account, index) => (
                                        <div
                                            key={index}
                                            className="flex space-x-4"
                                        >
                                            <span>{account.debit}</span>
                                        </div>
                                    ))}
                                </td>
                                <td className="px-4 py-2">
                                    {entry.accounts.map((account, index) => (
                                        <div
                                            key={index}
                                            className="flex space-x-4"
                                        >
                                            <span>{account.credit}</span>
                                        </div>
                                    ))}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
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

                            <div className="space-x-2">
                                <button
                                    onClick={() => handleEdit(entry)}
                                    className="bg-yellow-500 hover:bg-yellow-700 text-white font-bold py-1 px-2 rounded"
                                >
                                    Edit
                                </button>
                                <button
                                    onClick={() => handleDeleteEntry(entry._id)}
                                    className="bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded"
                                >
                                    Delete
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            </div>

            {editingEntry && (
                <div className="mt-4">
                    <h2>Edit Journal Entry</h2>
                    <div className="mb-4 flex space-x-2">
                        <input
                            type="date"
                            value={editDate}
                            onChange={(e) => setEditDate(e.target.value)}
                            className="border rounded p-2"
                        />
                        <input
                            type="text"
                            placeholder="Description"
                            value={editDescription}
                            onChange={(e) => setEditDescription(e.target.value)}
                            className="border rounded p-2"
                        />
                    </div>

                    {editAccounts.map((account, index) => (
                        <div key={index} className="mb-2 flex space-x-2">
                            <input
                                type="text"
                                placeholder="Account Name"
                                value={account.accountName}
                                onChange={(e) =>
                                    handleEditAccountChange(
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
                                    handleEditAccountChange(
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
                                    handleEditAccountChange(
                                        index,
                                        'credit',
                                        Number(e.target.value)
                                    )
                                }
                                className="border rounded p-2"
                            />
                            <button
                                onClick={() => handleDeleteAccount(index, true)}
                                className="bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded"
                            >
                                Delete Account
                            </button>
                        </div>
                    ))}

                    <button
                        onClick={handleUpdateEntry}
                        className="bg-green-500 hover:bg-green-700 text-white font-bold py-2 px-4 rounded"
                    >
                        Update Entry
                    </button>
                    <button
                        onClick={() => setEditingEntry(null)}
                        className="bg-gray-500 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded"
                    >
                        Cancel
                    </button>
                </div>
            )}
        </div>
    );
};

export default JournalEntries;
