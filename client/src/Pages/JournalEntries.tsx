import { useState, useMemo, useEffect, useCallback } from 'react';
import Layout from '../components/layout/Layout';
import React from 'react';
// Import fetch services and necessary types
import { getJournalEntries, addJournalEntry, JournalEntryPayload } from '../services/fetchServices';

// --- TYPE DEFINITIONS (Unchanged) ---
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

interface JournalEntryLine {
  id: number;
  account: string;
  debit: number;
  credit: number;
}

interface NewJournalEntry {
  date: string;
  description: string;
  lines: JournalEntryLine[];
}
// -----------------------


// Helper function to format date for display (Unchanged)
const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
};


/**
 * 📝 Modal component for adding a new journal entry. (Unchanged)
 * ... (AddJournalEntryModal component code remains exactly the same as previous response)
 */
const AddJournalEntryModal: React.FC<{ 
    isOpen: boolean; 
    onClose: () => void; 
    onSuccess: () => void; 
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
        
        const payload: JournalEntryPayload = {
            date: newEntry.date,
            description: newEntry.description,
            accounts: newEntry.lines.map(({ account, debit, credit }) => ({ account, debit, credit })),
        };
        
        try {
            await addJournalEntry(payload);
            alert("Journal Entry posted successfully!");
            onSuccess(); 

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
                                        <path fillRule="evenodd" d="M9 2a1 1 10-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 102 0v6a1 1 0 10-2 0V8z" clipRule="evenodd" />
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

    // Function to fetch data from API (Unchanged)
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

    // Fetch data on initial component mount (Unchanged)
    useEffect(() => {
        fetchEntries();
    }, [fetchEntries]);

    // Function to trigger refresh after successful entry post (Unchanged)
    const handleEntrySuccess = () => {
        fetchEntries();
    };

    // Filtered entries for display (Unchanged)
    const filteredEntries = entries.filter(entry => 
        entry.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
        entry.accounts.some(line => line.account.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    
    return (
        <Layout>
            <AddJournalEntryModal 
                isOpen={isModalOpen} 
                onClose={() => setIsModalOpen(false)} 
                onSuccess={handleEntrySuccess}
            />

            <div className="h-full p-6 w-full">
                <div className='flex flex-col sm:flex-row  w-full max-w-6xl mb-4 gap-2'>
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
                
                <div className="w-full rounded shadow">
                    {/* Header Row using CSS Grid */}
                    <div className="grid grid-cols-[80px_80px_1fr_250px_100px_100px] border-b bg-gray-50 text-sm uppercase text-gray-600 font-semibold sticky top-0">
                        <div className="px-4 py-3">S.No.</div>
                        <div className="px-4 py-3">Date</div>
                        <div className="px-4 py-3">Description</div>
                        <div className="px-4 py-3">Accounts</div>
                        <div className="px-4 py-3 text-right">Debit</div>
                        <div className="px-4 py-3 text-right">Credit</div>
                    </div>

                    {/* Content */}
                    <div className="max-h-[70vh] overflow-y-auto">
                        {isLoading ? (
                            <div className="text-center py-8 text-gray-500">Loading journal entries...</div>
                        ) : error ? (
                            <div className="text-center py-8 text-red-500 font-medium">Error: {error}</div>
                        ) : filteredEntries.length === 0 ? (
                            <div className="text-center py-8 text-gray-500">No journal entries found. Start by adding one!</div>
                        ) : (
                            filteredEntries.map((entry, entryIndex) => (
                                /**
                                 * 🎯 THIS IS THE NEW WRAPPER DIV YOU WANTED! 
                                 * It allows you to select, style, or handle events for the entire entry.
                                 */
                                <div 
                                    key={entry.id} 
                                    className="border-b-4 border-gray-200 hover:bg-gray-900 transition cursor-pointer"
                                    // Example of how you can add an onClick handler to the whole entry box
                                    // onClick={() => console.log('Clicked entry:', entry.id)}
                                >
                                    {entry.accounts.map((line, lineIndex) => {
                                        const isFirstLine = lineIndex === 0;
                                        
                                        // Determine if this is a Credit line (has a credit amount but no debit amount)
                                        const isCreditLine = line.credit > 0 && line.debit === 0;

                                        // Each line is now a row in the Grid
                                        return (
                                            <div 
                                                key={`${entry.id}-${lineIndex}`} 
                                                className={`grid grid-cols-[80px_80px_1fr_250px_100px_100px] text-sm ${!isFirstLine ? 'border-t border-gray-100' : ''}`}
                                            >
                                                
                                                {/* S.No. - Shown only on the first line (Empty div otherwise to hold space) */}
                                                <div className="px-4 py-2 align-top text-gray-500">
                                                    {isFirstLine ? `${entryIndex + 1}.` : ''}
                                                </div>
                                                
                                                {/* Date - Shown only on the first line */}
                                                <div className="px-4 py-2 align-top font-medium text-gray-700">
                                                    {isFirstLine ? formatDate(entry.date) : ''}
                                                </div>

                                                {/* Description - Shown only on the first line, wraps text */}
                                                <div className="px-4 py-2 align-top whitespace-pre-wrap text-gray-700">
                                                    {isFirstLine ? entry.description : ''}
                                                </div>

                                                {/* Account Name (Indented for Credit lines) */}
                                                <div className={`px-4 py-2 font-semibold ${isCreditLine ? 'pl-8' : ''}`}>
                                                    {isCreditLine && <span className="mr-2 italic text-gray-500 text-xs">To </span>}
                                                    {line.account}
                                                </div>
                                                
                                                {/* Debit Amount */}
                                                <div className="px-4 py-2 text-right font-medium">
                                                    {line.debit > 0 ? `$${line.debit.toFixed(2)}` : ''}
                                                </div>
                                                
                                                {/* Credit Amount */}
                                                <div className="px-4 py-2 text-right font-medium">
                                                    {line.credit > 0 ? `$${line.credit.toFixed(2)}` : ''}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </Layout>
    )
}

export default JournalEntries;