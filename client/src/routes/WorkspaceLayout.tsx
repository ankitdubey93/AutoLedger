import { Outlet } from 'react-router-dom';
import Sidebar from '../components/layout/Sidebar';
import OnboardingBanner from '../Pages/home/OnboardingBanner';

/** Sidebar plus page: every product page renders inside this. */
export default function WorkspaceLayout({ showBanner = false }: { showBanner?: boolean }) {
  return (
    <div className="flex flex-col md:flex-row md:gap-6 px-4 md:px-6">
      <Sidebar />
      <div className="min-w-0 flex-1 py-6">
        {showBanner && <OnboardingBanner />}
        <Outlet />
      </div>
    </div>
  );
}
