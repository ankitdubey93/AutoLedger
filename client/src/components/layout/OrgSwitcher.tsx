import { Building2, Check, ChevronsUpDown, Plus, Settings2 } from 'lucide-react';
import { useOrg } from '../../context/OrgContext';
import Menu, { type MenuItem } from '../ui/Menu';

/**
 * The organization menu in the top bar: every organization the user belongs
 * to (the active one ticked), then "Add organization" and "Manage
 * organizations".
 *
 * Phase 37: always shown. Before, it hid itself at one membership because
 * the only control in it was a picker — but adding a second organization now
 * starts here, so a user with one organization needs it most.
 */
export default function OrgSwitcher() {
  const { organization, memberships, switching, error, switchTo } = useOrg();

  const items: MenuItem[] = [
    ...memberships.map((m) => {
      const active = m.orgId === organization?.id;
      return {
        label: `${m.orgName} · ${m.role}`,
        icon: active ? Check : Building2,
        disabled: switching,
        onSelect: () => {
          if (!active) void switchTo(m.orgId);
        },
      };
    }),
    { type: 'separator' as const },
    { label: 'Add organization', icon: Plus, to: '/organizations/new' },
    { label: 'Manage organizations', icon: Settings2, to: '/account?tab=organizations' },
  ];

  return (
    <div className="flex items-center gap-1.5">
      <Menu
        panelLabel="Organizations"
        align="right"
        items={items}
        trigger={({ buttonProps }) => (
          <button
            {...buttonProps}
            type="button"
            aria-label={`Organization: ${organization?.name ?? 'none'}. Switch or add an organization`}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm text-[var(--text)] hover:bg-[var(--panel-2)] transition-colors"
          >
            <Building2 size={15} aria-hidden="true" className="text-[var(--muted)]" />
            <span className="hidden sm:inline truncate max-w-[12rem]">{organization?.name ?? 'Organization'}</span>
            <ChevronsUpDown size={13} aria-hidden="true" className="text-[var(--muted)]" />
          </button>
        )}
      />
      {switching && <span className="muted text-xs">Switching…</span>}
      {error !== null && (
        <span className="status--bad text-xs" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
