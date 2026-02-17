import React, { useEffect, useState } from 'react';
import Layout from '../components/layout/Layout';
import { getTrialBalance } from '../services/fetchServices';

const Reports: React.FC = () => {
    const [data, setData] = useState<any>(null);

    useEffect(() => {
        getTrialBalance().then(res => setData(res));
    }, []);

    if (!data) return <Layout><div className="p-8">Loading Report...</div></Layout>;

    return (
        <Layout>
            <div className="p-8 max-w-5xl mx-auto">
                <header className="mb-10 text-center">
                    <h1 className="text-4xl font-extrabold text-white mb-2">Trial Balance</h1>
                    <p className="text-gray-400">As of {new Date().toLocaleDateString()}</p>
                    <div className="mt-4 inline-block px-4 py-1 rounded-full bg-green-900/30 text-green-400 text-sm font-bold border border-green-800">
                        Status: {data.isBalanced ? 'Balanced' : 'Unbalanced'}
                    </div>
                </header>

                <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden shadow-2xl">
                    <table className="w-full text-left">
                        <thead className="bg-gray-800/50 text-gray-400 uppercase text-[10px] tracking-widest font-bold">
                            <tr>
                                <th className="px-8 py-4">Account</th>
                                <th className="px-8 py-4 text-right">Debit</th>
                                <th className="px-8 py-4 text-right">Credit</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-800">
                            {data.data.map((row: any) => (
                                <tr key={row.id} className="hover:bg-gray-800/30 transition-colors">
                                    <td className="px-8 py-4">
                                        <div className="font-bold text-white">{row.name}</div>
                                        <div className="text-xs text-gray-500 font-mono">{row.code} | {row.type}</div>
                                    </td>
                                    <td className="px-8 py-4 text-right font-mono text-white">
                                        {row.total_debit > 0 ? Number(row.total_debit).toLocaleString(undefined, {minimumFractionDigits: 2}) : '-'}
                                    </td>
                                    <td className="px-8 py-4 text-right font-mono text-white">
                                        {row.total_credit > 0 ? Number(row.total_credit).toLocaleString(undefined, {minimumFractionDigits: 2}) : '-'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot className="bg-indigo-900/20 border-t-2 border-indigo-500/30">
                            <tr className="font-bold text-indigo-400">
                                <td className="px-8 py-6 uppercase tracking-wider">Total</td>
                                <td className="px-8 py-6 text-right font-mono text-xl">${Number(data.totals.debit).toLocaleString()}</td>
                                <td className="px-8 py-6 text-right font-mono text-xl">${Number(data.totals.credit).toLocaleString()}</td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            </div>
        </Layout>
    );
}

export default Reports;