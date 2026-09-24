export type AccountTab = 'organization' | 'apps' | 'members' | 'session' | 'system';

export interface AccountTabsProps {
  active: AccountTab;
  onChange: (tab: AccountTab) => void;
}

/** The tab strip for the Account page. */
export default function AccountTabs({ active, onChange }: AccountTabsProps) {
  const tabClass = (isActive: boolean) =>
    [
      'px-3 py-1.5 text-sm no-underline rounded-md',
      isActive
        ? 'bg-[var(--panel)] text-[var(--text)] font-medium'
        : 'text-[var(--muted)] hover:text-[var(--text)]',
    ].join(' ');

  const tabs: Array<{ id: AccountTab; label: string }> = [
    { id: 'organization', label: 'Organisation' },
    { id: 'apps', label: 'Apps' },
    { id: 'members', label: 'Members' },
    { id: 'session', label: 'Session' },
    { id: 'system', label: 'System' },
  ];

  return (
    <nav aria-label="Account" role="tablist" className="flex gap-1 border-b border-[var(--border)] pb-2">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={tabClass(active === tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
