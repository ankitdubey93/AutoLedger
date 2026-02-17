import { useState, useMemo, useEffect, useCallback } from 'react';
import Layout from '../components/layout/Layout';
import React from 'react';
import { 
    getJournalEntries, 
    addJournalEntry, 
    getAccounts, 
    JournalEntryPayload 
} from '../services/fetchServices';
import { Plus, Search, Trash2, CheckCircle2, AlertCircle } from 'lucide-react';

interface Account {
    id: string;
    name: string;
    code: string;
}

// --- DYNAMIC MODAL COMPONENT ---
const AddJournalEntryModal: React.FC<{ 
    isOpen: boolean; 
    onClose: () => void; 
    onSuccess: () => void; 
}> = ({ isOpen, onClose, onSuccess }) => {
    const [availableAccounts, setAvailableAccounts] = useState<Account[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const today = new Date().toISOString().split('T')[0];
    
    const [newEntry, setNewEntry] = useState({
        date: today,
        description: '',
        lines: [
            { id: 1, accountId: '', debit: 0, credit: 0 },
            { id: 2, accountId: '', debit: 0, credit: 0 },
        ],
    });

    useEffect(() => {
        if (isOpen) {
            getAccounts().then(data => setAvailableAccounts(data.accounts));
        }
    }, [isOpen]);

    const totalDebit = useMemo(() => newEntry.lines.reduce((sum, l) => sum + l.debit, 0), [newEntry.lines]);
    const totalCredit = useMemo(() => newEntry.lines.reduce((sum, l) => sum + l.credit, 0), [newEntry.lines]);
    const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0;

    const handleAddLine = () => {
        setNewEntry(prev => ({
            ...prev,
            lines: [...prev.lines, { id: Date.now(), accountId: '', debit: 0, credit: 0 }]
        }));
    };

    const handleRemoveLine = (id: number) => {
        if (newEntry.lines.length > 2) {
            setNewEntry(prev => ({
                ...prev,
                lines: prev.lines.filter(l => l.id !== id)
            }));
        }
    };

    const handlePostEntry = async () => {
        setIsLoading(true);
        try {
            const payload: JournalEntryPayload = {
                date: newEntry.date,
                description: newEntry.description,
                lines: newEntry.lines.map(({ accountId, debit, credit }) => ({ 
                    accountId, 
                    debit: Number(debit), 
                    credit: Number(credit) 
                }))
            };
            await addJournalEntry(payload);
            onSuccess();
            onClose();
            setNewEntry({
                date: today,
                description: '',
                lines: [{ id: 1, accountId: '', debit: 0, credit: 0 }, { id: 2, accountId: '', debit: 0, credit: 0 }]
            });
        } catch (error: any) {
            alert(error.message);
        } finally {
            setIsLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 text-white">
            <div className="bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl w-full max-w-4xl overflow-hidden">
                <div className="p-6 border-b border-gray-800 bg-gray-800/30 flex justify-between items-center">
                    <div>
                        <h3 className="text-xl font-bold">New Journal Entry</h3>
                        <p className="text-xs text-gray-400 mt-1">Ensure your debits and credits are equal.</p>
                    </div>
                    <div className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold transition-all ${isBalanced ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                        {isBalanced ? <CheckCircle2 size={14}/> : <AlertCircle size={14}/>}
                        {isBalanced ? 'BALANCED' : 'UNBALANCED'}
                    </div>
                </div>
                
                <div className="p-8 space-y-6 max-h-[60vh] overflow-y-auto">
                    <div className="grid grid-cols-3 gap-6">
                        <div className="col-span-1">
                            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Transaction Date</label>
                            <input type="date" value={newEntry.date} onChange={e => setNewEntry({...newEntry, date: e.target.value})} className="w-full bg-gray-800 border-gray-700 rounded-xl p-3 text-white focus:border-indigo-500 outline-none" />
                        </div>
                        <div className="col-span-2">
                            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Description / Memo</label>
                            <input type="text" value={newEntry.description} onChange={e => setNewEntry({...newEntry, description: e.target.value})} placeholder="Describe this transaction..." className="w-full bg-gray-800 border-gray-700 rounded-xl p-3 text-white focus:border-indigo-500 outline-none" />
                        </div>
                    </div>

                    <div className="space-y-4">
                        <div className="grid grid-cols-12 gap-4 px-2 text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                            <div className="col-span-6">Account</div>
                            <div className="col-span-2 text-right">Debit ($)</div>
                            <div className="col-span-2 text-right">Credit ($)</div>
                            <div className="col-span-2"></div>
                        </div>

                        {newEntry.lines.map((line, idx) => (
                            <div key={line.id} className="grid grid-cols-12 gap-4 items-center animate-in fade-in slide-in-from-top-2 duration-300">
                                <select 
                                    className="col-span-6 bg-gray-800 border-gray-700 rounded-xl p-3 text-sm text-white focus:border-indigo-500 outline-none"
                                    value={line.accountId}
                                    onChange={e => {
                                        const newLines = [...newEntry.lines];
                                        newLines[idx].accountId = e.target.value;
                                        setNewEntry({...newEntry, lines: newLines});
                                    }}
                                >
                                    <option value="">Select an account...</option>
                                    {availableAccounts.map(acc => (
                                        <option key={acc.id} value={acc.id}>{acc.code} — {acc.name}</option>
                                    ))}
                                </select>
                                <input 
                                    type="number" 
                                    className="col-span-2 bg-gray-800 border-gray-700 rounded-xl p-3 text-sm text-right text-white focus:border-green-500 outline-none" 
                                    placeholder="0.00"
                                    onChange={e => {
                                        const newLines = [...newEntry.lines];
                                        newLines[idx].debit = parseFloat(e.target.value) || 0;
                                        setNewEntry({...newEntry, lines: newLines});
                                    }}
                                />
                                <input 
                                    type="number" 
                                    className="col-span-2 bg-gray-800 border-gray-700 rounded-xl p-3 text-sm text-right text-white focus:border-red-500 outline-none" 
                                    placeholder="0.00"
                                    onChange={e => {
                                        const newLines = [...newEntry.lines];
                                        newLines[idx].credit = parseFloat(e.target.value) || 0;
                                        setNewEntry({...newEntry, lines: newLines});
                                    }}
                                />
                                <div className="col-span-2 flex justify-end">
                                    {newEntry.lines.length > 2 && (
                                        <button onClick={() => handleRemoveLine(line.id)} className="text-gray-500 hover:text-red-400 transition-colors">
                                            <Trash2 size={18} />
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>

                    <button 
                        onClick={handleAddLine} 
                        className="flex items-center gap-2 text-indigo-400 hover:text-indigo-300 text-xs font-bold uppercase tracking-widest transition-colors"
                    >
                        <Plus size={16} /> Add Line Item
                    </button>
                </div>

                <div className="p-8 bg-gray-800/30 border-t border-gray-800 flex justify-between items-center">
                    <div className="flex gap-12">
                        <div>
                            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">Total Debit</p>
                            <p className="text-2xl font-mono font-bold text-white">${totalDebit.toLocaleString(undefined, {minimumFractionDigits: 2})}</p>
                        </div>
                        <div>
                            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">Total Credit</p>
                            <p className="text-2xl font-mono font-bold text-white">${totalCredit.toLocaleString(undefined, {minimumFractionDigits: 2})}</p>
                        </div>
                    </div>
                    <div className="flex gap-4">
                        <button onClick={onClose} className="px-6 py-3 text-gray-400 font-bold hover:text-white transition-colors">Cancel</button>
                        <button 
                            disabled={!isBalanced || isLoading} 
                            onClick={handlePostEntry}
                            className={`px-8 py-3 rounded-xl font-bold text-white transition-all shadow-xl ${isBalanced && !isLoading ? 'bg-indigo-600 hover:bg-indigo-500 shadow-indigo-500/20' : 'bg-gray-700 text-gray-500 cursor-not-allowed'}`}
                        >
                            {isLoading ? 'Posting...' : 'Post Transaction'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

// --- MAIN PAGE ---
const JournalEntries: React.FC = () => {
    const [entries, setEntries] = useState<any[]>([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState("");

    const loadData = useCallback(async () => {
        const data = await getJournalEntries();
        setEntries(data.entries || []);
    }, []);

    useEffect(() => { loadData(); }, [loadData]);

    const filteredEntries = entries.filter(e => 
        e.description.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <Layout>
            <AddJournalEntryModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onSuccess={loadData} />
            <div className="p-8 max-w-6xl mx-auto">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-10">
                    <div>
                        <h1 className="text-4xl font-black text-white tracking-tight">Journal Entries</h1>
                        <p className="text-gray-500 mt-1">Reviewing all transaction logs across your accounts.</p>
                    </div>
                    <div className="flex gap-3 w-full md:w-auto">
                        <div className="relative flex-1 md:w-64">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
                            <input 
                                type="text" 
                                placeholder="Search memos..." 
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                className="w-full bg-gray-900 border border-gray-800 rounded-xl py-2.5 pl-10 pr-4 text-white text-sm focus:border-indigo-500 outline-none"
                            />
                        </div>
                        <button 
                            onClick={() => setIsModalOpen(true)} 
                            className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-xl font-bold shadow-lg shadow-indigo-500/20 transition-all flex items-center gap-2"
                        >
                            <Plus size={20} /> <span className="hidden sm:inline">New Entry</span>
                        </button>
                    </div>
                </div>

                <div className="space-y-6">
                    {filteredEntries.length === 0 ? (
                        <div className="text-center py-20 bg-gray-900/50 rounded-3xl border border-dashed border-gray-800">
                            <p className="text-gray-500">No transactions found matching your search.</p>
                        </div>
                    ) : (
                        filteredEntries.map(entry => (
                            <div key={entry.id} className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden shadow-sm hover:border-gray-700 transition-all">
                                <div className="bg-gray-800/30 px-6 py-4 border-b border-gray-800 flex justify-between items-center text-sm">
                                    <div className="flex items-center gap-4">
                                        <span className="font-mono text-indigo-400 font-bold uppercase tracking-tighter">
                                            {new Date(entry.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                                        </span>
                                        <span className="w-1 h-1 bg-gray-700 rounded-full"></span>
                                        <span className="text-white font-medium">{entry.description}</span>
                                    </div>
                                    <span className="text-[10px] font-bold text-gray-600 uppercase tracking-widest">ID: {entry.id.split('-')[0]}</span>
                                </div>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="text-[10px] text-gray-500 text-left border-b border-gray-800 uppercase tracking-widest font-black">
                                                <th className="px-8 py-3">Account</th>
                                                <th className="px-8 py-3 text-right">Debit</th>
                                                <th className="px-8 py-3 text-right">Credit</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-800/50">
                                            {entry.lines.map((line: any) => (
                                                <tr key={line.id} className="group">
                                                    <td className={`px-8 py-3 transition-all ${line.credit > 0 ? 'pl-16 text-gray-400' : 'text-gray-200 font-semibold'}`}>
                                                        <div className="flex flex-col">
                                                            <span>{line.accountName}</span>
                                                            <span className="text-[10px] text-gray-600 font-mono uppercase tracking-tighter">{line.accountCode}</span>
                                                        </div>
                                                    </td>
                                                    <td className="px-8 py-3 text-right text-green-400 font-mono">
                                                        {line.debit > 0 ? `$${Number(line.debit).toLocaleString(undefined, {minimumFractionDigits: 2})}` : '—'}
                                                    </td>
                                                    <td className="px-8 py-3 text-right text-red-400 font-mono">
                                                        {line.credit > 0 ? `$${Number(line.credit).toLocaleString(undefined, {minimumFractionDigits: 2})}` : '—'}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </Layout>
    );
};

export default JournalEntries;