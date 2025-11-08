import React from 'react';
import Layout from '../components/layout/Layout';

const Reports: React.FC = () => {
    return (
        <Layout>
            <div className="h-full p-6 w-full">
                {/* Header Section */}
                <header className="mb-8">
                    <h1 className="text-3xl font-bold text-gray-800">📊 Financial Reports</h1>
                    <p className="text-gray-500 mt-2">
                        View and generate your essential financial statements and reports here.
                    </p>
                </header>

                {/* Placeholder Content */}
                <div className="max-w-6xl">
                    
                    {/* Feature Card: Balance Sheet */}
                    <div className="bg-white p-6 rounded-lg shadow-md mb-4 border border-gray-200">
                        <h2 className="text-xl font-semibold text-indigo-600">Balance Sheet</h2>
                        <p className="text-gray-700 mt-2">
                            A snapshot of your company's assets, liabilities, and equity at a specific point in time. (Coming Soon!)
                        </p>
                        <button 
                            className="mt-4 bg-gray-200 text-gray-700 px-4 py-2 rounded-md cursor-not-allowed opacity-75"
                            disabled
                        >
                            Generate Report
                        </button>
                    </div>

                    {/* Feature Card: Income Statement */}
                    <div className="bg-white p-6 rounded-lg shadow-md mb-4 border border-gray-200">
                        <h2 className="text-xl font-semibold text-indigo-600">Income Statement (P&L)</h2>
                        <p className="text-gray-700 mt-2">
                            A summary of your revenues and expenses over a period of time. (Coming Soon!)
                        </p>
                        <button 
                            className="mt-4 bg-gray-200 text-gray-700 px-4 py-2 rounded-md cursor-not-allowed opacity-75"
                            disabled
                        >
                            Generate Report
                        </button>
                    </div>

                    {/* Feature Card: Trial Balance */}
                    <div className="bg-white p-6 rounded-lg shadow-md border border-gray-200">
                        <h2 className="text-xl font-semibold text-indigo-600">Trial Balance</h2>
                        <p className="text-gray-700 mt-2">
                            A list of all accounts and their balances to ensure Debit equals Credit. (Coming Soon!)
                        </p>
                        <button 
                            className="mt-4 bg-gray-200 text-gray-700 px-4 py-2 rounded-md cursor-not-allowed opacity-75"
                            disabled
                        >
                            Generate Report
                        </button>
                    </div>

                </div>
            </div>
        </Layout>
    );
}

export default Reports;