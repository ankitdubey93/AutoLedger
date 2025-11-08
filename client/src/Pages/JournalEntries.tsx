import { useState, useMemo, useEffect, useCallback } from 'react';
import Layout from '../components/layout/Layout';
import React from 'react';
// Import fetch services and necessary types
import { getJournalEntries, addJournalEntry, JournalEntryPayload } from '../services/fetchServices';

// --- TYPE DEFINITIONS ---
// Define the structure of an entry fetched from the backend
interface FetchedJournalEntry {
    id: string;
    date: string;
    description: string;
    accounts: Array<{
        account: string;
        debit: number;
        credit: number;
    }>;
    created_at: string;
}

// Define the structure for a single line in a journal entry (Debit or Credit)
interface JournalEntryLine {
  id: number;
  account: string;
  debit: number;
  credit: number;
}

// Define the structure for the full journal entry being created
interface NewJournalEntry {
  date: string;
  description: string;
  lines: JournalEntryLine[];
}
// -----------------------


// Helper function to format date for display
const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
};


/**
 * 📝 Modal component for adding a new journal entry.
 * Accepts a callback function for successful post.
 */
const AddJournalEntryModal: React.FC<{ 
    isOpen: boolean; 
    onClose: () => void; 
    onSuccess: () => void; // Added success handler
}> = ({ isOpen, onClose, onSuccess }) => {

    const today = new Date().toISOString().split('T')[0];
    const [newEntry, setNewEntry] = useState<NewJournalEntry>({
        date: today,
        description: '',
        lines: [
            { id: Date.now(), account: '', debit: 0, credit: 0 },
            { id: Date.now() + 1, account: '', debit: 0, credit: 0 },
        ],
    });
    const [isLoading, setIsLoading] = useState(false);

    const totalDebit = useMemo(() => newEntry.lines.reduce((sum, line) => sum + line.debit, 0), [newEntry.lines]);
    const totalCredit = useMemo(() => newEntry.lines.reduce((sum, line) => sum + line.credit, 0), [newEntry.lines]);
    // Check if totalDebit > 0 is essential to prevent posting empty entries
    const isBalanced = totalDebit === totalCredit && totalDebit > 0; 
    const isValid = isBalanced && newEntry.description.trim() !== '' && newEntry.lines.every(l => l.account.trim() !== '');

    const handleLineChange = (id: number, field: keyof Omit<JournalEntryLine, 'id'>, value: string | number) => {
        setNewEntry(prev => ({
            ...prev,
            lines: prev.lines.map(line =>
                line.id === id
                ? { ...line, [field]: typeof value === 'string' && (field === 'debit' || field === 'credit') ? parseFloat(value) || 0 : value }
                : line
            ),
        }));
    };

    const handleAddLine = () => {
        setNewEntry(prev => ({
            ...prev,
            lines: [...prev.lines, { id: Date.now() + prev.lines.length, account: '', debit: 0, credit: 0 }],
        }));
    };

    const handleRemoveLine = (id: number) => {
        if (newEntry.lines.length <= 2) return;
        setNewEntry(prev => ({
            ...prev,
            lines: prev.lines.filter(line => line.id !== id),
        }));
    };

    const handlePostEntry = async () => {
        if (!isValid) {
            alert("Please ensure the entry is balanced (Debit = Credit > 0), has a description, and all account fields are filled.");
            return;
        }

        setIsLoading(true);
        
        // Prepare data for the API (maps the frontend structure to the backend payload structure)
        const payload: JournalEntryPayload = {
            date: newEntry.date,
            description: newEntry.description,
            // Only send account, debit, and credit fields to the backend
            accounts: newEntry.lines.map(({ account, debit, credit }) => ({ account, debit, credit })),
        };
        
        try {
            await addJournalEntry(payload);
            alert("Journal Entry posted successfully!");
            onSuccess(); // <<< Call success to trigger data refresh in main component

            // Reset modal state
            setNewEntry({
                date: today,
                description: '',
                lines: [
                    { id: Date.now(), account: '', debit: 0, credit: 0 },
                    { id: Date.now() + 1, account: '', debit: 0, credit: 0 },
                ],
            });
            onClose();

        } catch (error) {
            console.error("Post Entry Error:", error);
            // Assuming error is an object with a message, or a standard Error object
            alert(`Error posting entry: ${error instanceof Error ? error.message : 'Unknown error occurred.'}`);
        } finally {
            setIsLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm"> 
            <div className="bg-white rounded-lg shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto text-black">
                <div className="p-6">
                    <h3 className="text-xl font-semibold mb-4 border-b pb-2">Add New Journal Entry</h3>
                    
                    {/* Top Form Fields (Date and Description) */}
                    <div className="grid grid-cols-2 gap-4 mb-4">
                        <div>
                            <label htmlFor="date" className="block text-sm font-medium text-gray-700">Date</label>
                            <input
                                id="date"
                                type="date"
                                value={newEntry.date}
                                onChange={(e) => setNewEntry(prev => ({ ...prev, date: e.target.value }))}
                                className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2"
                                required
                            />
                        </div>
                        <div className="col-span-2">
                            <label htmlFor="description" className="block text-sm font-medium text-gray-700">Description</label>
                            <textarea
                                id="description"
                                rows={2}
                                value={newEntry.description}
                                onChange={(e) => setNewEntry(prev => ({ ...prev, description: e.target.value }))}
                                className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2"
                                placeholder="Brief description of the transaction"
                                required
                            />
                        </div>
                    </div>

                    {/* Accounts Section */}
                    <h4 className="text-lg font-medium my-4">Accounts Detail</h4>
                    <div className="space-y-3">
                        {newEntry.lines.map((line) => (
                            <div key={line.id} className="flex gap-2 items-center">
                                {/* Account Field */}
                                <input
                                    type="text"
                                    placeholder="Account Name (e.g., Cash, Sales, Rent Exp)"
                                    value={line.account}
                                    onChange={(e) => handleLineChange(line.id, 'account', e.target.value)}
                                    className="flex-grow border border-gray-300 rounded px-3 py-2 text-sm"
                                    required
                                />
                                
                                {/* Debit Field */}
                                <input
                                    type="number"
                                    placeholder="Debit"
                                    value={line.debit > 0 ? line.debit : ''} 
                                    onChange={(e) => {
                                        const val = parseFloat(e.target.value) || 0;
                                        handleLineChange(line.id, 'debit', val);
                                        if (val > 0) handleLineChange(line.id, 'credit', 0); 
                                    }}
                                    className="w-24 border border-gray-300 rounded px-3 py-2 text-sm text-right"
                                    min="0"
                                />
                                
                                {/* Credit Field */}
                                <input
                                    type="number"
                                    placeholder="Credit"
                                    value={line.credit > 0 ? line.credit : ''} 
                                    onChange={(e) => {
                                        const val = parseFloat(e.target.value) || 0;
                                        handleLineChange(line.id, 'credit', val);
                                        if (val > 0) handleLineChange(line.id, 'debit', 0);
                                    }}
                                    className="w-24 border border-gray-300 rounded px-3 py-2 text-sm text-right"
                                    min="0"
                                />
                                
                                {/* Remove Button */}
                                <button
                                    onClick={() => handleRemoveLine(line.id)}
                                    disabled={newEntry.lines.length <= 2}
                                    className={`text-red-500 hover:text-red-700 p-1 rounded transition ${newEntry.lines.length <= 2 ? 'opacity-50 cursor-not-allowed' : ''}`}
                                    title="Remove Account Line (Min 2 required)"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                        <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 102 0v6a1 1 0 10-2 0V8z" clipRule="evenodd" />
                                    </svg>
                                </button>
                            </div>
                        ))}
                        
                        {/* Add Line Button */}
                        <button
                            onClick={handleAddLine}
                            className="mt-2 text-blue-600 hover:text-blue-800 text-sm font-medium"
                        >
                            + Add Another Line
                        </button>
                    </div>

                    {/* Totals and Post Button */}
                    <div className="mt-6 pt-4 border-t">
                        <div className="flex justify-end gap-2 text-lg font-bold mb-4">
                            <span className="w-24 text-right">Total Debit: **${totalDebit.toFixed(2)}**</span>
                            <span className="w-24 text-right">Total Credit: **${totalCredit.toFixed(2)}**</span>
                        </div>
                        <div className="flex justify-between items-center">
                            <p className={`font-semibold ${isBalanced ? 'text-green-600' : 'text-red-600'}`}>
                                Status: **{isBalanced ? 'Balanced ✅' : 'Unbalanced ❌'}**
                            </p>
                            <div>
                                <button
                                    onClick={onClose}
                                    disabled={isLoading}
                                    className="bg-gray-200 text-gray-800 px-4 py-2 rounded-md mr-2 hover:bg-gray-300 transition disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handlePostEntry}
                                    disabled={!isValid || isLoading}
                                    className={`px-4 py-2 rounded-md transition ${isValid && !isLoading ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-gray-400 text-gray-700 cursor-not-allowed'}`}
                                >
                                    {isLoading ? 'Posting...' : 'Post Entry'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};


// -------------------------------------------------------------
// 📋 Main JournalEntries Component
// -------------------------------------------------------------
const JournalEntries: React.FC = () => {
    const [searchTerm, setSearchTerm] = useState<string>("");
    const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
    
    // State to hold fetched data
    const [entries, setEntries] = useState<FetchedJournalEntry[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Function to fetch data from API
    const fetchEntries = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const data = await getJournalEntries();
            setEntries(data.entries || []);
        } catch (err) {
            console.error("Failed to fetch entries:", err);
            setError(err instanceof Error ? err.message : "Failed to load entries.");
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Fetch data on initial component mount
    useEffect(() => {
        fetchEntries();
    }, [fetchEntries]);

    // Function to trigger refresh after successful entry post
    const handleEntrySuccess = () => {
        fetchEntries();
    };

    // Filtered entries for display (optional: for search)
    const filteredEntries = entries.filter(entry => 
        entry.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
        entry.accounts.some(line => line.account.toLowerCase().includes(searchTerm.toLowerCase()))
    );

 
    return (
        <Layout>
            {/* The Modal Component - now includes onSuccess prop */}
            <AddJournalEntryModal 
                isOpen={isModalOpen} 
                onClose={() => setIsModalOpen(false)} 
                onSuccess={handleEntrySuccess}
            />

            <div className="h-full p-6 w-full">
                <div className='flex flex-col sm:flex-row sm:justify-between w-full max-w-6xl mb-4 gap-2'>
                    {/* Reordered buttons/search for standard placement */}
                    <input
                        type="text"
                        placeholder="Search entries..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="border border-gray-300 rounded px-4 py-2 w-full sm:w-64"
                    />
                    <button
                        onClick={() => setIsModalOpen(true)}
                        className="bg-indigo-600 text-white px-4 py-2 rounded shadow-md hover:bg-indigo-700 transition w-full sm:w-auto"
                    >
                        + Add Entry
                    </button>
                </div>
                
                <div className="w-full overflow-x-auto rounded shadow">
                    <table className="table-auto w-full text-left">
                        <thead>
                            <tr className="border-b bg-gray-50 text-sm uppercase text-gray-600">
                                <th className="px-4 py-3 w-1/12">S.No.</th>
                                <th className="px-4 py-3 w-1/12">Date</th>
                                <th className="px-4 py-3 w-1/4">Description</th>
                                <th className="px-4 py-3 w-3/12">Accounts</th>
                                <th className="px-4 py-3 w-1/12 text-right">Debit</th>
                                <th className="px-4 py-3 w-1/12 text-right">Credit</th>
                            </tr>
                        </thead>
                        <tbody>
                            {isLoading ? (
                                <tr>
                                    <td colSpan={6} className="text-center py-8 text-gray-500">Loading journal entries...</td>
                                </tr>
                            ) : error ? (
                                <tr>
                                    <td colSpan={6} className="text-center py-8 text-red-500 font-medium">Error: {error}</td>
                                </tr>
                            ) : filteredEntries.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="text-center py-8 text-gray-500">No journal entries found. Start by adding one!</td>
                                </tr>
                            ) : (
                                filteredEntries.map((entry, entryIndex) => (
                                    // Use a fragment to render multiple rows per entry
                                    <React.Fragment key={entry.id}>
                                        {/* Render the first row for the entry details */}
                                        <tr className="border-b hover:bg-gray-50">
                                            <td className="px-4 py-2 font-medium">{entryIndex + 1}.</td>
                                            <td className="px-4 py-2 font-medium">{formatDate(entry.date)}</td>
                                            <td className="px-4 py-2">{entry.description}</td>
                                            <td className="px-4 py-2 font-semibold">{entry.accounts[0]?.account}</td>
                                            <td className="px-4 py-2 text-right text-green-700">
                                                {entry.accounts[0]?.debit > 0 ? `$${entry.accounts[0].debit.toFixed(2)}` : ''}
                                            </td>
                                            <td className="px-4 py-2 text-right text-red-700">
                                                {entry.accounts[0]?.credit > 0 ? `$${entry.accounts[0].credit.toFixed(2)}` : ''}
                                            </td>
                                        </tr>
                                        {/* Render subsequent rows for multi-line entries (indented) */}
                                        {entry.accounts.slice(1).map((line, lineIndex) => (
                                            <tr key={`${entry.id}-${lineIndex}`} className="border-b hover:bg-gray-50">
                                                <td className="px-4 py-2"></td>
                                                <td className="px-4 py-2"></td>
                                                <td className="px-4 py-2"></td>
                                                <td className="px-4 py-2 pl-8 italic">{line.account}</td>
                                                <td className="px-4 py-2 text-right text-green-700">
                                                    {line.debit > 0 ? `$${line.debit.toFixed(2)}` : ''}
                                                </td>
                                                <td className="px-4 py-2 text-right text-red-700">
                                                    {line.credit > 0 ? `$${line.credit.toFixed(2)}` : ''}
                                                </td>
                                            </tr>
                                        ))}
                                    </React.Fragment>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </Layout>
    )
}

export default JournalEntries;