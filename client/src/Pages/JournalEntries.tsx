import { useState, useMemo } from 'react';
import Layout from '../components/layout/Layout';

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


const AddJournalEntryModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {

  const today = new Date().toISOString().split('T')[0];
  const [newEntry, setNewEntry] = useState<NewJournalEntry>({
    date: today,
    description: '',
  
    lines: [
      { id: Date.now(), account: '', debit: 0, credit: 0 },
      { id: Date.now() + 1, account: '', debit: 0, credit: 0 },
    ],
  });

 
  const totalDebit = useMemo(() => newEntry.lines.reduce((sum, line) => sum + line.debit, 0), [newEntry.lines]);
  const totalCredit = useMemo(() => newEntry.lines.reduce((sum, line) => sum + line.credit, 0), [newEntry.lines]);
  const isBalanced = totalDebit === totalCredit && totalDebit > 0;
  const isValid = isBalanced && newEntry.description.trim() !== '' && newEntry.lines.every(l => l.account.trim() !== '');
  // ----------------------------------------

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

  const handlePostEntry = () => {
    if (!isValid) {
      alert("Please ensure the entry is balanced (Debit = Credit), has a description, and all account fields are filled.");
      return;
    }
    
    
    console.log('Posting Journal Entry:', newEntry);

    
    setNewEntry({
      date: today,
      description: '',
      lines: [
        { id: Date.now(), account: '', debit: 0, credit: 0 },
        { id: Date.now() + 1, account: '', debit: 0, credit: 0 },
      ],
    });
    onClose();
  };

  if (!isOpen) return null;

  return (
    
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm"> 
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto text-black">
        <div className="p-6">
          <h3 className="text-xl font-semibold mb-4 border-b pb-2">Add New Journal Entry</h3>
          
          
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

          <h4 className="text-lg font-medium my-4">Accounts Detail</h4>
          <div className="space-y-3">
            {newEntry.lines.map((line) => (
              <div key={line.id} className="flex gap-2 items-center">
                <input
                  type="text"
                  placeholder="Account Name (e.g., Cash, Sales, Rent Exp)"
                  value={line.account}
                  onChange={(e) => handleLineChange(line.id, 'account', e.target.value)}
                  className="flex-grow border border-gray-300 rounded px-3 py-2 text-sm"
                  required
                />
                
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
            
            
            <button
              onClick={handleAddLine}
              className="mt-2 text-blue-600 hover:text-blue-800 text-sm font-medium"
            >
              + Add Another Line
            </button>
          </div>

          
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
                  className="bg-gray-200 text-gray-800 px-4 py-2 rounded-md mr-2 hover:bg-gray-300 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={handlePostEntry}
                  disabled={!isValid}
                  className={`px-4 py-2 rounded-md transition ${isValid ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-gray-400 text-gray-700 cursor-not-allowed'}`}
                >
                  Post Entry
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};



const JournalEntries: React.FC = () => {
    const [searchTerm, setSearchTerm] = useState<string>("");
    const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  
 
    return (
        <Layout>
        
            <AddJournalEntryModal 
                isOpen={isModalOpen} 
                onClose={() => setIsModalOpen(false)} 
            />

            <div className="h-full p-6 w-full">
                <div className='flex flex-col sm:flex-row  w-full max-w-6xl mb-4 gap-2'>
                    <button
                        onClick={() => setIsModalOpen(true)}
                        className="bg-indigo-600 text-white px-4 py-2 rounded shadow-md hover:bg-indigo-700 transition w-full sm:w-auto"
                    >
                        + Add Entry
                    </button>
                    <input
                        type="text"
                        placeholder="Search..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="border border-gray-300 rounded px-4 py-2 w-full sm:w-64"
                    />
                </div>
                
                <div className="w-full overflow-x-auto rounded shadow">
                    <table className="table-auto w-full text-left">
                        <thead>
                            <tr className="border-b">
                                <th className="px-4 py-2 w-1/12">S.No.</th>
                                <th className="px-4 py-2 w-1/12">Date</th>
                                <th className="px-4 py-2 w-1/4 max-w-xs text-center">Description</th>
                                <th className="px-4 py-2 w-1/8">Accounts</th>
                                <th className="px-4 py-2 w-1/8">Debit</th>
                                <th className="px-4 py-2 w-1/8">Credit</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td className="px-4 py-2"></td>
                                <td className="px-4 py-2"></td>
                                <td className="px-4 py-2"></td>
                                <td className="px-4 py-2"></td>
                                <td className="px-4 py-2"></td>
                                <td className="px-4 py-2"></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </Layout>
    )
}

export default JournalEntries;