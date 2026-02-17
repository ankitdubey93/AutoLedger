import { useEffect, useState } from 'react';
import Layout from '../components/layout/Layout';
import { getTrialBalance } from '../services/fetchServices';
import { Wallet, TrendingUp, Receipt, Scale, ArrowUpRight, ArrowDownRight } from 'lucide-react';

const Dashboard = () => {
  const [metrics, setMetrics] = useState({
    cashBalance: 0,
    totalRevenue: 0,
    totalExpenses: 0,
    netProfit: 0,
    isBalanced: true
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const report = await getTrialBalance();
        
        // Logic: Calculate metrics from the Trial Balance data
        let cash = 0;
        let revenue = 0;
        let expenses = 0;

        report.data.forEach((account: any) => {
          const balance = Number(account.net_balance);
          
          // Categorize based on account type
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
      } catch (err) {
        console.error("Dashboard load error:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  if (loading) return <Layout><div className="p-8 text-white">Calculating metrics...</div></Layout>;

  return (
    <Layout>
      <div className="p-8 max-w-7xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex justify-between items-end">
          <div>
            <h1 className="text-4xl font-black text-white tracking-tight">Financial Overview</h1>
            <p className="text-gray-500 mt-1">Real-time summary of your business ledger.</p>
          </div>
          {!metrics.isBalanced && (
            <div className="bg-red-500/10 text-red-400 border border-red-500/20 px-4 py-2 rounded-xl flex items-center gap-2 text-sm font-bold">
              <Scale size={18} /> Critical: Ledger Unbalanced
            </div>
          )}
        </div>

        {/* Stat Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <StatCard 
            title="Cash on Hand" 
            value={metrics.cashBalance} 
            icon={<Wallet className="text-blue-400" />} 
            trend="+2.5%" 
            isPositive={true}
          />
          <StatCard 
            title="Total Revenue" 
            value={metrics.totalRevenue} 
            icon={<TrendingUp className="text-green-400" />} 
            trend="+12%" 
            isPositive={true}
          />
          <StatCard 
            title="Operating Expenses" 
            value={metrics.totalExpenses} 
            icon={<Receipt className="text-orange-400" />} 
            trend="+5%" 
            isPositive={false}
          />
          <StatCard 
            title="Net Profit" 
            value={metrics.netProfit} 
            icon={<ArrowUpRight className="text-indigo-400" />} 
            trend="Target: 20%" 
            isPositive={metrics.netProfit > 0}
            highlight={true}
          />
        </div>

        {/* Secondary Section */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-gray-900 border border-gray-800 rounded-3xl p-8 h-80 flex items-center justify-center text-gray-600 italic border-dashed">
            Revenue vs Expense Chart (Coming Soon)
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-8">
            <h3 className="text-white font-bold mb-4">Quick Actions</h3>
            <div className="space-y-3">
              <ActionButton label="Record New Sale" color="bg-indigo-600" />
              <ActionButton label="Log Business Expense" color="bg-gray-800" />
              <ActionButton label="Download Trial Balance" color="bg-gray-800" />
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
};

// --- Helper Components ---

const StatCard = ({ title, value, icon, trend, isPositive, highlight = false }: any) => (
  <div className={`p-6 rounded-3xl border transition-all hover:scale-[1.02] duration-300 ${highlight ? 'bg-indigo-600 border-indigo-500 shadow-xl shadow-indigo-500/20' : 'bg-gray-900 border-gray-800'}`}>
    <div className="flex justify-between items-start mb-4">
      <div className={`p-3 rounded-2xl ${highlight ? 'bg-white/10' : 'bg-gray-800'}`}>
        {icon}
      </div>
      <span className={`text-[10px] font-bold px-2 py-1 rounded-lg flex items-center gap-1 ${highlight ? 'text-indigo-200' : isPositive ? 'text-green-400 bg-green-400/10' : 'text-red-400 bg-red-400/10'}`}>
        {isPositive ? <ArrowUpRight size={12}/> : <ArrowDownRight size={12}/>} {trend}
      </span>
    </div>
    <p className={`text-xs font-bold uppercase tracking-widest ${highlight ? 'text-indigo-200' : 'text-gray-500'}`}>{title}</p>
    <h2 className="text-3xl font-black text-white mt-1 font-mono">
      ${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}
    </h2>
  </div>
);

const ActionButton = ({ label, color }: { label: string, color: string }) => (
  <button className={`w-full ${color} text-white py-3 rounded-xl font-bold text-sm transition-opacity hover:opacity-90`}>
    {label}
  </button>
);

export default Dashboard;