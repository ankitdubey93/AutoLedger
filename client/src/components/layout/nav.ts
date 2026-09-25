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
      { to: '/invoices', label: 'Invoices', icon: FileText, end: false },
      { to: '/credit-notes', label: 'Credit notes', icon: FileMinus, end: false },
      { to: '/customers', label: 'Customers', icon: Users, end: false },
      { to: '/payments', label: 'Payments', icon: Banknote, end: false },
    ],
  },
  {
    heading: 'Purchases',
    items: [
      { to: '/expenses', label: 'Expenses', icon: ReceiptText, end: false },
      { to: '/inbox', label: 'Bill inbox', icon: Inbox, end: true },
      { to: '/inbox/review', label: 'Review queue', icon: ListChecks, end: false },
      { to: '/debit-notes', label: 'Debit notes', icon: FileMinus, end: false },
      { to: '/vendors', label: 'Vendors', icon: Building2, end: false },
    ],
  },
  {
    heading: 'Products & inventory',
    items: [
      { to: '/products', label: 'Products & services', icon: Package, end: false },
      { to: '/inventory/items', label: 'Stock on hand', icon: Boxes, end: false },
      { to: '/inventory/movements', label: 'Stock movements', icon: ArrowRightLeft, end: false },
      { to: '/inventory/locations', label: 'Locations', icon: MapPin, end: false },
      { to: '/inventory/labels', label: 'Labels', icon: Tags, end: false },
      { to: '/inventory/lookup', label: 'Lookup', icon: Search, end: false },
    ],
  },
  {
    heading: 'Banking',
    items: [
      { to: '/bank', label: 'Bank lines', icon: Landmark, end: true },
      { to: '/bank/import', label: 'Import statement', icon: Upload, end: false },
      { to: '/bank/reconciliation', label: 'Reconciliation', icon: GitCompareArrows, end: false },
      { to: '/bank/rules', label: 'Bank rules', icon: Filter, end: false },
    ],
  },
  {
    heading: 'Accounting',
    items: [
      { to: '/accounts', label: 'Chart of accounts', icon: ListTree, end: false },
      { to: '/journals', label: 'Journal entries', icon: BookOpen, end: false },
      { to: '/recurring', label: 'Recurring', icon: Repeat, end: false },
      { to: '/fiscal-periods', label: 'Fiscal periods', icon: CalendarCheck, end: false },
      { to: '/fx-rates', label: 'Exchange rates', icon: Coins, end: false },
      { to: '/fx-exposure', label: 'FX exposure', icon: GitCompareArrows, end: false },
      { to: '/fx-revaluations', label: 'Revaluations', icon: RefreshCw, end: false },
      { to: '/migration-imports', label: 'Imports', icon: Upload, end: false },
    ],
  },
  {
    heading: 'Reports',
    items: [
      { to: '/reports', label: 'Reports', icon: FileBarChart, end: false },
      { to: '/trial-balance', label: 'Trial balance', icon: Scale, end: false },
    ],
  },
  {
    heading: 'Workspace',
    items: [
      { to: '/documents', label: 'Documents', icon: FolderOpen, end: false },
      { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false },
    ],
  },
];
