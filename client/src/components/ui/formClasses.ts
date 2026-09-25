/**
 * The settings-form class strings that used to be copied by hand into every
 * Accounting/Capture/Stock settings page (GeneralSettingsPage, ChartSettingsPage,
 * InboxSettingsPage, InventoryCatalogueSettingsPage, and others). One copy here
 * means a future style change lands once instead of N times.
 */
export const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full disabled:opacity-50';

export const primaryButtonClass =
  'px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

export const secondaryButtonClass =
  'px-4 py-2 rounded-md text-sm font-medium border border-[var(--border)] cursor-pointer bg-transparent text-[var(--text)] hover:bg-[var(--panel-2)] hover:border-[var(--border-strong)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
