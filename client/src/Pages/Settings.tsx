import React from 'react';
import Layout from '../components/layout/Layout';

const Settings: React.FC = () => {
    return (
        <Layout>
            <div className="h-full p-6 w-full">
                {/* Header Section */}
                <header className="mb-8">
                    <h1 className="text-3xl font-bold text-gray-800">⚙️ Settings & Configuration</h1>
                    <p className="text-gray-500 mt-2">
                        Manage your account details, security settings, and app preferences.
                    </p>
                </header>

                {/* Settings Sections */}
                <div className="max-w-4xl space-y-6">
                    
                    {/* Section 1: Account Details */}
                    <div className="bg-white p-6 rounded-lg shadow-md border border-gray-200">
                        <h2 className="text-xl font-semibold text-indigo-600 mb-3">Account Details</h2>
                        <p className="text-gray-700">
                            View and update your registered user information, company name, and contact details.
                        </p>
                        <button 
                            className="mt-4 bg-gray-100 text-gray-700 px-4 py-2 rounded-md hover:bg-gray-200 transition cursor-not-allowed opacity-75"
                            disabled
                        >
                            Edit Profile
                        </button>
                    </div>

                    {/* Section 2: Security & Password */}
                    <div className="bg-white p-6 rounded-lg shadow-md border border-gray-200">
                        <h2 className="text-xl font-semibold text-indigo-600 mb-3">Security</h2>
                        <p className="text-gray-700">
                            Change your current password for enhanced security.
                        </p>
                        <button 
                            className="mt-4 bg-red-500 text-white px-4 py-2 rounded-md hover:bg-red-600 transition cursor-not-allowed opacity-75"
                            disabled
                        >
                            Reset Password
                        </button>
                    </div>

                    {/* Section 3: Other Settings */}
                    <div className="bg-white p-6 rounded-lg shadow-md border border-gray-200">
                        <h2 className="text-xl font-semibold text-indigo-600 mb-3">Other Settings</h2>
                        <p className="text-gray-700">
                            Future options such as currency preference, starting fiscal year, or notification settings will appear here.
                        </p>
                        <button 
                            className="mt-4 bg-gray-100 text-gray-700 px-4 py-2 rounded-md hover:bg-gray-200 transition cursor-not-allowed opacity-75"
                            disabled
                        >
                            Manage Preferences
                        </button>
                    </div>

                </div>
            </div>
        </Layout>
    );
}

export default Settings;