import { Outlet } from 'react-router-dom';
import { useOrg } from '../../context/OrgContext';
import AppTopBar from './AppTopBar';
import AppFooter from './AppFooter';
import CommandPalette from './CommandPalette';
import { ShellProvider } from './ShellContext';

/**
 * The one shell every signed-in page renders inside (Phase 33). It replaces
 * the two sibling shells the suite had, PlatformLayout (chooser, account)
 * and AppFrame (one per app). There is one product now, so there is one
 * chrome and no app to resolve from the URL.
 *
 * The sidebar is not rendered here. `WorkspaceLayout` adds it, so the setup
 * wizard can render full width inside the same top bar.
 */
export default function AppShell() {
  const { organization, orgVersion } = useOrg();

  return (
    <ShellProvider>
      <div className="min-h-screen flex flex-col bg-[var(--bg)]">
        <AppTopBar />
        {/*
          Keyed on the active organization: switching tenants remounts the whole
          subtree, so every page refetches instead of briefly showing the previous
          organization's data, and switching into a not-yet-set-up organization
          correctly lands on the setup wizard again. Do not "optimise" it away.
        */}
        <main key={`${organization?.id ?? 'none'}-${orgVersion}`} className="flex-1 min-h-0">
          <Outlet />
        </main>
        <AppFooter />
        <CommandPalette />
      </div>
    </ShellProvider>
  );
}
