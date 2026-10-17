import { NAV_GROUPS } from '../components/layout/nav';

/** Pages whose title the sidebar can't supply — outside the nav, or more specific than their section. */
const EXACT_TITLES: Record<string, string> = {
  '/login': 'Sign in',
  '/register': 'Create account',
  '/forgot-password': 'Reset password',
  '/reset-password': 'Choose a new password',
  '/onboarding': 'Set up',
  '/account': 'Account settings',
  '/settings/profile': 'Organization profile',
  '/settings/members': 'Members',
  '/settings/email': 'Email settings',
  '/settings/user-activity': 'User activity',
  '/settings/roles': 'Roles & permissions',
  '/verify-email': 'Verify email',
  '/confirm-email-change': 'Confirm new email',
  '/organizations/new': 'Add organization',
  '/invoices/new': 'New invoice',
  '/credit-notes/new': 'New credit note',
  '/expenses/new': 'New expense',
  '/bills/new': 'New expense',
  '/debit-notes/new': 'New debit note',
  '/manual-journals/new': 'New manual journal',
  '/manual-journals/repeating/new': 'New repeating journal',
  '/inventory/items/new': 'New stock item',
  '/inventory/setup': 'Set up inventory',
  '/reports/profit-and-loss': 'Profit & loss',
  '/reports/balance-sheet': 'Balance sheet',
  '/reports/cash-flow': 'Cash flow statement',
  '/reports/account-transactions': 'Account transactions',
  '/reports/exceptions': 'Ledger exceptions',
  '/reports/aged-receivables': 'Aged receivables',
  '/reports/aged-payables': 'Aged payables',
  '/reports/tax-summary': 'Tax summary',
  '/reports/sales-by-customer': 'Sales by customer',
  '/reports/purchases-by-vendor': 'Purchases by vendor',
  '/reports/sales-by-item': 'Sales by item',
  '/reports/purchases-by-item': 'Purchases by item',
};

/** Aliases whose section lives under another path in the nav. */
const PREFIX_ALIASES: Record<string, string> = { '/bills': '/expenses', '/items': '/products' };

const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

/**
 * The browser-tab title for a path: an exact entry above, else the label of
 * the longest nav entry the path sits under (so `/invoices/abc` is
 * "Invoices"), else just the product name. Derived from `nav.ts` so a page
 * added to the sidebar gets a title with no second edit.
 */
export function pageTitleFor(pathname: string): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const exact = EXACT_TITLES[path];
  if (exact !== undefined) return `${exact} · AutoLedger`;
  if (path.startsWith('/invite/')) return 'Invitation · AutoLedger';

  const aliasFrom = Object.keys(PREFIX_ALIASES).find((p) => path === p || path.startsWith(`${p}/`));
  const resolved = aliasFrom === undefined ? path : `${PREFIX_ALIASES[aliasFrom] ?? ''}${path.slice(aliasFrom.length)}`;

  let best: { to: string; label: string } | null = null;
  for (const item of NAV_ITEMS) {
    const matches = item.to === '/' ? resolved === '/' : resolved === item.to || resolved.startsWith(`${item.to}/`);
    if (matches && (best === null || item.to.length > best.to.length)) best = item;
  }
  return best === null ? 'AutoLedger' : `${best.label} · AutoLedger`;
}
