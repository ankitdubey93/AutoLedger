import { Outlet } from 'react-router-dom';
import { useOrg } from '../../context/OrgContext';
import AppTopBar from './AppTopBar';
import AppFooter from './AppFooter';
import CommandPalette from './CommandPalette';
import { ShellProvider } from './ShellContext';

/**
 * Suite-level chrome: shown only on the app chooser ("/"), "/welcome",
 * "/account", "/documents" and "/integrations". An app under
 * /app/:appSlug is a sibling route, not a child of this layout.
 *
 * Phase 31: this now renders the same AppTopBar/AppFooter/CommandPalette
 * AppFrame does, with `app={null}` — one header component for the whole
 * workspace instead of two near-duplicate ones. Its own ShellProvider means
 * the sidebar-collapse/command-palette state here is independent of
 * whatever app the person last had open.
 */
export default function PlatformLayout() {
  const { organization, orgVersion } = useOrg();

  return (
    <ShellProvider>
      <div className="app">
        <AppTopBar app={null} />

        {/*
          Keyed on the active organization. Switching tenants remounts the whole
          subtree, so every page refetches from scratch instead of briefly
          showing the previous organization's data — cache invalidation by
          identity rather than by hand.
        */}
        <main key={`${organization?.id ?? 'none'}-${orgVersion}`} className="app-main">
          <Outlet />
        </main>
        <AppFooter app={null} />
        <CommandPalette />
      </div>
    </ShellProvider>
  );
}
