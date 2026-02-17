import { NavLink } from "react-router-dom";
import { 
  LayoutDashboard, 
  BookText, 
  PieChart, 
  Settings, 
  ListTree, 
  Sparkles 
} from "lucide-react";

interface SidebarProps {
  isOpen: boolean;
}

const Sidebar: React.FC<SidebarProps> = ({ isOpen }) => {
  const navItems = [
    { name: "Dashboard", path: "/dashboard", icon: <LayoutDashboard size={20} /> },
    { 
      name: "Magic Entry", 
      path: "/magic-entry", 
      icon: <Sparkles size={20} />, 
      isMagic: true 
    },
    { name: "Journal Entries", path: "/journal-entries", icon: <BookText size={20} /> },
    { name: "Chart of Accounts", path: "/accounts", icon: <ListTree size={20} /> },
    { name: "Reports", path: "/reports", icon: <PieChart size={20} /> },
    { name: "Settings", path: "/settings", icon: <Settings size={20} /> },
  ];

  return (
    <aside
      className={`${
        isOpen ? "w-64" : "w-0"
      } border-r border-gray-700 bg-black flex flex-col overflow-hidden transition-all duration-500`}
    >
      {/* Brand Logo */}
      <div
        className={`flex items-center justify-between p-6 transform transition-all duration-500 ${
          isOpen
            ? "opacity-100 translate-x-0"
            : "opacity-0 -translate-x-4 pointer-events-none"
        }`}
      >
        <h2 className="text-2xl font-black tracking-tighter text-white whitespace-nowrap">
          AutoLedger<span className="text-blue-500">.</span>
        </h2>
      </div>

      {/* Navigation */}
      <nav
        className={`flex flex-col space-y-2 px-4 transform transition-all duration-500 delay-100 ${
          isOpen
            ? "opacity-100 translate-x-0"
            : "opacity-0 -translate-x-4 pointer-events-none"
        }`}
      >
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `flex items-center gap-3 p-3 rounded-xl transition-all duration-200 group ${
                isActive
                  ? item.isMagic 
                    ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" 
                    : "bg-gray-800 text-blue-400 font-bold"
                  : "text-gray-400 hover:bg-gray-800/60 hover:text-white"
              }`
            }
          >
            <span className={`${item.isMagic && "text-indigo-400 group-hover:text-white"}`}>
              {item.icon}
            </span>
            <span className="text-sm font-medium whitespace-nowrap">{item.name}</span>
            
            {/* Tiny "AI" badge for Magic Entry */}
            {item.isMagic && isOpen && (
              <span className="ml-auto text-[8px] bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded-md border border-indigo-500/30">
                AI
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* User Footer (Optional but looks professional) */}
      {isOpen && (
        <div className="mt-auto p-4 border-t border-gray-800">
          <div className="flex items-center gap-3 px-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center font-bold text-xs text-white">
              A
            </div>
            <div className="flex flex-col">
              <span className="text-xs font-bold text-white">Ankit</span>
              <span className="text-[10px] text-gray-500">Administrator</span>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};

export default Sidebar;