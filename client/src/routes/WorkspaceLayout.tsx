import { useLayoutEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/layout/Sidebar';
import OnboardingBanner from '../Pages/home/OnboardingBanner';
import VerifyEmailBanner from '../components/layout/VerifyEmailBanner';
import { prefersMotion } from '../utils/motion';

/**
 * Sidebar plus page: every product page renders inside this.
 *
 * Each navigation replays one entrance on the page container. The Web Animations
 * API rather than a `key` on the container because a key would remount the page,
 * throwing away its state and refetching its data just to animate it. It leaves
 * nothing behind on the element, and a layout effect starts it before the browser
 * paints the new page in its final position.
 */
export default function WorkspaceLayout({ showBanner = false }: { showBanner?: boolean }) {
  const { pathname } = useLocation();
  const pageRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!prefersMotion()) return;
    pageRef.current?.animate(
      [
        { opacity: 0, transform: 'translateY(10px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 450, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }, [pathname]);

  return (
    <div className="flex flex-col md:flex-row md:gap-8 px-4 md:px-7">
      <Sidebar />
      <div ref={pageRef} className="min-w-0 flex-1 py-6 md:py-8 max-w-[90rem]">
        <VerifyEmailBanner />
        {showBanner && <OnboardingBanner />}
        <Outlet />
      </div>
    </div>
  );
}
