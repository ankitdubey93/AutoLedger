import { NavLink } from "react-router-dom";


interface SidebarProps {
  isOpen: boolean;
}

const Sidebar: React.FC<SidebarProps> = ({ isOpen }) => {

    const navItems = [
        {name: "Dashboard", path: "/dashboard"},
        {name: "Journal Entries", path: "/journal-entries"},
        {name: "Reports", path: "/reports"},
        {name: "Settings", path: "/settings"},
        {name: "Chart of Accounts", path: "/accounts"},
    ];

  return (
    <aside
      className={`${
        isOpen ? "w-64" : "w-0"
      } border-r border-gray-700 flex flex-col overflow-hidden transition-all duration-500`}
    >
   
      <div
        className={`flex items-center justify-between p-4 transform transition-all duration-500 ${
          isOpen
            ? "opacity-100 translate-x-0"
            : "opacity-0 -translate-x-4 pointer-events-none"
        }`}
      >
        <h2 className="text-2xl font-bold whitespace-nowrap">AutoLedger</h2>
      </div>

   
      <nav
        className={`flex flex-col space-y-4 px-4 transform transition-all duration-500 delay-100 ${
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
              `p-2 rounded-lg transition ${
                isActive
                  ? "bg-gray-800 text-blue-400 font-semibold"
                  : "hover:bg-gray-800/60"
              }`
            }
          >
            {item.name}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
};

export default Sidebar;
