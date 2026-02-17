import React, { useEffect, useState } from 'react';
import Layout from '../components/layout/Layout';
import { getAccounts } from '../services/fetchServices'; // Assuming you add a createAccount service
import { Plus, ListTree } from 'lucide-react';

const AccountsPage = () => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newAccount, setNewAccount] = useState({ name: '', code: '', type: 'Asset', description: '' });

  const loadAccounts = async () => {
    const data = await getAccounts();
    setAccounts(data.accounts);
  };

  useEffect(() => { loadAccounts(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      // Direct call to your POST /api/accounts endpoint
      await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newAccount),
        credentials: 'include'
      });
      setIsModalOpen(false);
      setNewAccount({ name: '', code: '', type: 'Asset', description: '' });
      loadAccounts();
    } catch (err) { alert("Failed to add account"); }
  };

  return (
    <Layout>
      <div className="p-8">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold text-white flex items-center gap-2">
            <ListTree className="text-indigo-500" /> Chart of Accounts
          </h1>
          <button 
            onClick={() => setIsModalOpen(true)}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg flex items-center gap-2"
          >
            <Plus size={20} /> Add Account
          </button>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-left">
            <thead className="bg-gray-800 text-gray-400 uppercase text-xs font-bold">
              <tr>
                <th className="px-6 py-4">Code</th>
                <th className="px-6 py-4">Name</th>
                <th className="px-6 py-4">Type</th>
                <th className="px-6 py-4">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800 text-gray-300">
              {accounts.map(acc => (
                <tr key={acc.id} className="hover:bg-gray-800/50">
                  <td className="px-6 py-4 font-mono text-indigo-400">{acc.code}</td>
                  <td className="px-6 py-4 font-bold text-white">{acc.name}</td>
                  <td className="px-6 py-4">
                    <span className="px-2 py-1 rounded-md bg-gray-800 text-[10px] font-bold uppercase tracking-wider">
                      {acc.type}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">{acc.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Account Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <form onSubmit={handleSubmit} className="bg-gray-900 border border-gray-800 p-8 rounded-2xl w-full max-w-md shadow-2xl">
            <h2 className="text-2xl font-bold text-white mb-6">Create New Account</h2>
            <div className="space-y-4">
              <input type="text" placeholder="Account Name (e.g. Rent Expense)" className="w-full bg-gray-800 border-gray-700 rounded-xl p-3 text-white" 
                value={newAccount.name} onChange={e => setNewAccount({...newAccount, name: e.target.value})} required />
              <input type="text" placeholder="Account Code (e.g. 6050)" className="w-full bg-gray-800 border-gray-700 rounded-xl p-3 text-white" 
                value={newAccount.code} onChange={e => setNewAccount({...newAccount, code: e.target.value})} required />
              <select className="w-full bg-gray-800 border-gray-700 rounded-xl p-3 text-white"
                value={newAccount.type} onChange={e => setNewAccount({...newAccount, type: e.target.value})}>
                <option value="Asset">Asset</option>
                <option value="Liability">Liability</option>
                <option value="Equity">Equity</option>
                <option value="Revenue">Revenue</option>
                <option value="Expense">Expense</option>
              </select>
              <textarea placeholder="Description" className="w-full bg-gray-800 border-gray-700 rounded-xl p-3 text-white" 
                value={newAccount.description} onChange={e => setNewAccount({...newAccount, description: e.target.value})} />
            </div>
            <div className="flex gap-4 mt-8">
              <button type="button" onClick={() => setIsModalOpen(false)} className="flex-1 text-gray-400 font-bold">Cancel</button>
              <button type="submit" className="flex-1 bg-indigo-600 text-white p-3 rounded-xl font-bold shadow-lg shadow-indigo-500/20">Save Account</button>
            </div>
          </form>
        </div>
      )}
    </Layout>
  );
};

export default AccountsPage;