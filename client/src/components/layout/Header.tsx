import { useAuth } from "../../context/AuthContext";

const Header: React.FC<{ toggleSidebar: () => void }> = ({ toggleSidebar }) => {
  const { user, logout } = useAuth();

  return (
    <header className="p-4 border-b border-gray-700 flex justify-between items-center">
      <div className="flex items-center space-x-4">
        <button
          onClick={toggleSidebar}
          className="hover:bg-gray-700 p-2 rounded-lg transition"
        >
          ☰
        </button>
        <h1 className="text-xl font-semibold">
          Welcome, {user?.name || "User"}
        </h1>
      </div>
      <button
        onClick={logout}
        className="hover:bg-gray-600 p-2 rounded-lg transition cursor-pointer"
      >
        Logout
      </button>
    </header>
  );
};

export default Header;
