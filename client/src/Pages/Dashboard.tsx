import { useAuth } from "../context/AuthContext";

const Dashboard: React.FC = () => {
  const { user } = useAuth();

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-black via-gray-900 to-gray-800 text-white">
      {/* Sidebar */}
      <aside className="w-64 border-r border-gray-700 flex flex-col p-6">
        <h2 className="text-2xl font-bold mb-8">AutoLedger</h2>
        <nav className="flex flex-col space-y-4">
          <a href="#" className="hover:bg-gray-800/60 p-2 rounded-lg transition">
            Dashboard
          </a>
          <a href="#" className="hover:bg-gray-800/60 p-2 rounded-lg transition">
            Journal Entries
          </a>
          <a href="#" className="hover:bg-gray-800/60 p-2 rounded-lg transition">
            Reports
          </a>
          <a href="#" className="hover:bg-gray-800/60 p-2 rounded-lg transition">
            Settings
          </a>
        </nav>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <header className="p-4 border-b border-gray-700 flex justify-between items-center">
          <h1 className="text-xl font-semibold">
            Welcome, {user?.name || "User"}
          </h1>
        </header>

        {/* Content */}
        <main className="flex-1 p-6">
          <div className="border-2 border-dashed border-gray-600 rounded-lg h-full flex items-center justify-center text-gray-300">
            Key metrics will appear here
          </div>
        </main>
      </div>
    </div>
  );
};

export default Dashboard;
