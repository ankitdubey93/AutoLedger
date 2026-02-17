import React, { useEffect, useState} from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { getTrialBalance, getJournalEntries } from '../services/fetchServices';
import { 
  Wallet, 
  TrendingUp, 
  Receipt, 
  Scale, 
  ArrowUpRight, 
   
  Clock, 
  ArrowRight,
  FileText
} from 'lucide-react';

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [recentEntries, setRecentEntries] = useState<any[]>([]);
  const [metrics, setMetrics] = useState({
    cashBalance: 0,
    totalRevenue: 0,
    totalExpenses: 0,
    netProfit: 0,
    isBalanced: true
  });

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        setLoading(true);
        // Fetching both datasets in parallel for performance
        const [report, journals] = await Promise.all([
          getTrialBalance(),
          getJournalEntries()
        ]);

        // 1. Calculate Metrics from Trial Balance
        let cash = 0;
        let revenue = 0;
        let expenses = 0;

        report.data.forEach((account: any) => {
          const balance = Number(account.net_balance);
          // Standard SaaS Logic: Categorize balances
          if (account.type === 'Asset' && (account.name.toLowerCase().includes('bank') || account.name.toLowerCase().includes('cash'))) {
            cash += balance;
          } else if (account.type === 'Revenue') {
            revenue += balance;
          } else if (account.type === 'Expense') {
            expenses += balance;
          }
        });

        setMetrics({
          cashBalance: cash,
          totalRevenue: revenue,
          totalExpenses: expenses,
          netProfit: revenue - expenses,
          isBalanced: report.isBalanced
        });

        // 2. Set Recent Activity (Last 5)
        setRecentEntries(journals.entries.slice(0, 5));

      } catch (err) {
        console.error("Dashboard data fetch failed:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchDashboardData();
  }, []);

  if (loading) {
    return (
      <Layout>
        <div className="h-full flex items-center justify-center">
          <div className="animate-pulse text-gray-500 font-bold tracking-widest uppercase text-xs">
            Synchronizing Ledger...
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-8 max-w-7xl mx-auto space-y-10">
        
        {/* Header Section */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
          <div>
            <h1 className="text-4xl font-black text-white tracking-tight">Financial Command</h1>
            <p className="text-gray-500 mt-1">Real-time fiscal health for your business entity.</p>
          </div>
          
          <div className="flex items-center gap-3">
            <div className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold border ${
              metrics.isBalanced 
                ? 'bg-green-500/10 text-green-400 border-green-500/20' 
                : 'bg-red-500/10 text-red-400 border-red-500/20'
            }`}>
              <Scale size={16} />
              {metrics.isBalanced ? 'SYSTEM BALANCED' : 'LEDGER DISCREPANCY'}
            </div>
          </div>
        </div>

        {/* Top Tier Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <StatCard 
            title="Liquid Cash" 
            value={metrics.cashBalance} 
            icon={<Wallet size={20} className="text-blue-400" />} 
          />
          <StatCard 
            title="Gross Revenue" 
            value={metrics.totalRevenue} 
            icon={<TrendingUp size={20} className="text-green-400" />} 
          />
          <StatCard 
            title="Total Expenses" 
            value={metrics.totalExpenses} 
            icon={<Receipt size={20} className="text-orange-400" />} 
          />
          <StatCard 
            title="Net Profit" 
            value={metrics.netProfit} 
            icon={<ArrowUpRight size={20} className="text-white" />} 
            highlight={true}
          />
        </div>

        {/* Lower Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Recent Activity Table */}
          <div className="lg:col-span-2 space-y-4">
            <div className="flex justify-between items-center px-2">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Clock size={18} className="text-indigo-400" /> Recent Activity
              </h3>
              <button 
                onClick={() => navigate('/journal-entries')}
                className="text-xs font-bold text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1"
              >
                Full Ledger <ArrowRight size={14} />
              </button>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-3xl overflow-hidden shadow-sm">
              <table className="w-full text-left">
                <thead className="bg-gray-800/30 text-[10px] font-bold text-gray-500 uppercase tracking-widest border-b border-gray-800">
                  <tr>
                    <th className="px-6 py-4">Date</th>
                    <th className="px-6 py-4">Description</th>
                    <th className="px-6 py-4 text-right">Value Impact</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {recentEntries.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-6 py-12 text-center text-gray-600 italic text-sm">
                        No transactions found.
                      </td>
                    </tr>
                  ) : (
                    recentEntries.map((entry) => (
                      <tr key={entry.id} className="hover:bg-gray-800/30 transition-colors group">
                        <td className="px-6 py-4 text-xs font-mono text-indigo-400">
                          {new Date(entry.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </td>
                        <td className="px-6 py-4">
                          <p className="text-sm font-bold text-gray-200">{entry.description}</p>
                          <p className="text-[10px] text-gray-600 uppercase tracking-tighter">{entry.lines?.length || 0} Accounts Affected</p>
                        </td>
                        <td className="px-6 py-4 text-right font-mono text-sm text-white">
                          ${Number(entry.lines?.reduce((sum: number, l: any) => sum + Number(l.debit), 0) || 0).toLocaleString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Quick Actions & Reports */}
          <div className="space-y-6">
            <h3 className="text-lg font-bold text-white px-2">Operational Tasks</h3>
            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6 space-y-4 shadow-sm">
              <ActionButton 
                onClick={() => navigate('/journal-entries')} 
                label="New Journal Entry" 
                sub="Manual double-entry"
                color="bg-indigo-600 shadow-indigo-500/20"
              />
              <ActionButton 
                onClick={() => navigate('/accounts')} 
                label="Modify Chart" 
                sub="Manage account codes"
                color="bg-gray-800"
              />
              <div className="pt-4 border-t border-gray-800">
                 <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-4 px-2">Generate Statements</p>
                 <div className="grid grid-cols-2 gap-3">
                   <button onClick={() => navigate('/reports')} className="p-3 bg-gray-800/50 rounded-2xl hover:bg-gray-800 transition-all text-center">
                     <FileText size={16} className="mx-auto mb-2 text-indigo-400" />
                     <span className="text-[10px] text-white font-bold">P&L</span>
                   </button>
                   <button onClick={() => navigate('/reports')} className="p-3 bg-gray-800/50 rounded-2xl hover:bg-gray-800 transition-all text-center">
                     <Scale size={16} className="mx-auto mb-2 text-indigo-400" />
                     <span className="text-[10px] text-white font-bold">Balance</span>
                   </button>
                 </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </Layout>
  );
};

// --- Sub-components for Cleanliness ---

const StatCard = ({ title, value, icon, highlight = false }: any) => (
  <div className={`p-6 rounded-3xl border transition-all hover:scale-[1.02] duration-300 ${
    highlight 
      ? 'bg-indigo-600 border-indigo-500 shadow-xl shadow-indigo-500/20' 
      : 'bg-gray-900 border-gray-800'
  }`}>
    <div className="flex justify-between items-start mb-6">
      <div className={`p-3 rounded-2xl ${highlight ? 'bg-white/10' : 'bg-gray-800'}`}>
        {icon}
      </div>
    </div>
    <p className={`text-[10px] font-bold uppercase tracking-widest ${highlight ? 'text-indigo-200' : 'text-gray-500'}`}>
      {title}
    </p>
    <h2 className="text-3xl font-black text-white mt-1 font-mono tracking-tighter">
      ${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}
    </h2>
  </div>
);

const ActionButton = ({ label, sub, color, onClick }: any) => (
  <button 
    onClick={onClick}
    className={`w-full ${color} p-4 rounded-2xl text-left transition-all hover:translate-x-1 shadow-lg`}
  >
    <p className="text-sm font-bold text-white leading-none">{label}</p>
    <p className="text-[10px] text-white/50 font-medium mt-1 uppercase tracking-tighter">{sub}</p>
  </button>
);

export default Dashboard;