import {
  ArrowRightLeft,
  Banknote,
  BookOpen,
  Boxes,
  Building2,
  CalendarCheck,
  Coins,
  FileBarChart,
  FileMinus,
  FileText,
  Filter,
  FolderOpen,
  GitCompareArrows,
  Inbox,
  Landmark,
  LayoutDashboard,
  ListChecks,
  ListTree,
  MapPin,
  Package,
  ReceiptText,
  RefreshCw,
  Repeat,
  Scale,
  ScrollText,
  Search,
  Settings as SettingsIcon,
  Tags,
  Upload,
  Users,
} from 'lucide-react';
import type { SidebarNavGroup } from './AppSidebar';

/**
 * The product's one navigation, as data (Phase 33). The sidebar renders it
 * and the command palette searches it, so a page reachable from one is
 * reachable from the other.
 *
 * Phase 38c — an entry with a `permission` is shown only to members who
 * hold it (`visibleNavGroups`); the server refuses the page's requests
 * regardless, so this is about not showing doors that are locked.
 *
 * Every `to` is absolute. `end: true` means "active only on this exact path",
 * which the list pages whose detail routes sit elsewhere in the tree need,
 * and so does `/`, which would otherwise match every page.
 */
export const NAV_GROUPS: readonly SidebarNavGroup[] = [
  {
    heading: 'Overview',
    items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true }],
  },
  {
    heading: 'Sales',
    items: [
      { to: '/invoices', label: 'Invoices', icon: FileText, end: false, permission: 'invoices.view' },
      { to: '/credit-notes', label: 'Credit notes', icon: FileMinus, end: false, permission: 'credit_notes.view' },
      { to: '/customers', label: 'Customers', icon: Users, end: false, permission: 'customers.view' },
      { to: '/statements/customers', label: 'Statements', icon: ScrollText, end: false, permission: 'customers.view' },
      { to: '/payments', label: 'Payments', icon: Banknote, end: false, permission: 'payments.view' },
    ],
  },
  {
    heading: 'Purchases',
    items: [
      { to: '/expenses', label: 'Expenses', icon: ReceiptText, end: false, permission: 'bills.view' },
      { to: '/inbox', label: 'Bill inbox', icon: Inbox, end: true, permission: 'capture.view' },
      { to: '/inbox/review', label: 'Review queue', icon: ListChecks, end: false, permission: 'capture.view' },
      { to: '/debit-notes', label: 'Debit notes', icon: FileMinus, end: false, permission: 'debit_notes.view' },
      { to: '/vendors', label: 'Vendors', icon: Building2, end: false, permission: 'vendors.view' },
      { to: '/statements/vendors', label: 'Vendor statements', icon: ScrollText, end: false, permission: 'vendors.view' },
    ],
  },
  {
    heading: 'Products & inventory',
    items: [
      { to: '/products', label: 'Products & services', icon: Package, end: false, permission: 'products.view' },
      { to: '/inventory/items', label: 'Stock on hand', icon: Boxes, end: false, permission: 'inventory.view' },
      { to: '/inventory/movements', label: 'Stock movements', icon: ArrowRightLeft, end: false, permission: 'inventory.view' },
      { to: '/inventory/valuation', label: 'Valuation', icon: Scale, end: false, permission: 'inventory.view' },
      { to: '/inventory/locations', label: 'Locations', icon: MapPin, end: false, permission: 'inventory.view' },
      { to: '/inventory/labels', label: 'Labels', icon: Tags, end: false, permission: 'inventory.view' },
      { to: '/inventory/lookup', label: 'Lookup', icon: Search, end: false, permission: 'inventory.view' },
    ],
  },
  {
    heading: 'Banking',
    items: [
      { to: '/bank', label: 'Bank lines', icon: Landmark, end: true, permission: 'bank.view' },
      { to: '/bank/import', label: 'Import statement', icon: Upload, end: false, permission: 'bank.reconcile' },
      { to: '/bank/reconciliation', label: 'Reconciliation', icon: GitCompareArrows, end: false, permission: 'reports.view' },
      { to: '/bank/rules', label: 'Bank rules', icon: Filter, end: false, permission: 'bank.view' },
    ],
  },
  {
    heading: 'Accounting',
    items: [
      { to: '/accounts', label: 'Chart of accounts', icon: ListTree, end: false, permission: 'accounts.view' },
      { to: '/journals', label: 'Journal entries', icon: BookOpen, end: false, permission: 'journals.view' },
      { to: '/recurring', label: 'Recurring', icon: Repeat, end: false, permission: 'recurring.view' },
      { to: '/fiscal-periods', label: 'Fiscal periods', icon: CalendarCheck, end: false, permission: 'periods.view' },
      { to: '/fx-rates', label: 'Exchange rates', icon: Coins, end: false, permission: 'fx.view' },
      { to: '/fx-exposure', label: 'FX exposure', icon: GitCompareArrows, end: false, permission: 'reports.view' },
      { to: '/fx-revaluations', label: 'Revaluations', icon: RefreshCw, end: false, permission: 'fx.view' },
      { to: '/migration-imports', label: 'Imports', icon: Upload, end: false, permission: 'imports.view' },
    ],
  },
  {
    heading: 'Reports',
    items: [
      { to: '/reports', label: 'Reports', icon: FileBarChart, end: false, permission: 'reports.view' },
      { to: '/trial-balance', label: 'Trial balance', icon: Scale, end: false, permission: 'reports.view' },
    ],
  },
  {
    heading: 'Workspace',
    items: [
      { to: '/documents', label: 'Documents', icon: FolderOpen, end: false, permission: 'documents.view' },
      { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false },
    ],
  },
];

/** Phase 38c — the nav as this member may use it: entries they lack the permission for are dropped, then empty groups. */
export function visibleNavGroups(can: (permission: string) => boolean): SidebarNavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.permission === undefined || can(item.permission)),
  })).filter((group) => group.items.length > 0);
}
