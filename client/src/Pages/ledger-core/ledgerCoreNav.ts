import {
  Banknote,
  FileMinus,
  BookOpen,
  Building2,
  CalendarCheck,
  Coins,
  FileBarChart,
  FileText,
  GitCompareArrows,
  History,
  Landmark,
  LayoutDashboard,
  ListTree,
  Package,
  ReceiptText,
  RefreshCw,
  Scale,
  Send,
  Settings as SettingsIcon,
  Upload,
  Users,
  Webhook,
} from 'lucide-react';

/**
 * LedgerCore's navigation as data, extracted from LedgerCoreSidebar verbatim
 * (Phase 31) so the render component (AppSidebar) can be shared with
 * StockLedger and AP-Flow instead of three copies of the same JSX.
 */
export const LEDGER_CORE_NAV_GROUPS = [
  {
    heading: 'Overview',
    items: [{ to: '', label: 'Dashboard', icon: LayoutDashboard, end: true }],
  },
  {
    heading: 'Bookkeeping',
    items: [
      { to: 'accounts', label: 'Chart of Accounts', icon: ListTree, end: false },
      { to: 'journals', label: 'Journal Entries', icon: BookOpen, end: false },
    ],
  },
  {
    heading: 'Sales',
    items: [
      { to: 'invoices', label: 'Invoices', icon: FileText, end: false },
      { to: 'credit-notes', label: 'Credit notes', icon: FileMinus, end: false },
      { to: 'customers', label: 'Customers', icon: Users, end: false },
      { to: 'items', label: 'Items & Services', icon: Package, end: false },
      { to: 'payments', label: 'Payments', icon: Banknote, end: false },
    ],
  },
  {
    heading: 'Purchases',
    items: [
      { to: 'expenses', label: 'Expenses', icon: ReceiptText, end: false },
      { to: 'debit-notes', label: 'Debit notes', icon: FileMinus, end: false },
      { to: 'vendors', label: 'Vendors', icon: Building2, end: false },
    ],
  },
  {
    heading: 'Banking',
    items: [
      { to: 'bank', label: 'Bank Lines', icon: Landmark, end: true },
      { to: 'bank/import', label: 'Import Statement', icon: Upload, end: false },
      { to: 'bank/reconciliation', label: 'Reconciliation', icon: GitCompareArrows, end: false },
    ],
  },
  {
    heading: 'Reporting',
    items: [
      { to: 'trial-balance', label: 'Trial Balance', icon: Scale, end: false },
      { to: 'reports', label: 'Reports', icon: FileBarChart, end: false },
    ],
  },
  {
    heading: 'Currency',
    items: [
      { to: 'fx-rates', label: 'Rates', icon: Coins, end: false },
      { to: 'fx-exposure', label: 'Exposure', icon: GitCompareArrows, end: false },
      { to: 'fx-revaluations', label: 'Revaluations', icon: RefreshCw, end: false },
    ],
  },
  {
    heading: 'Configure',
    items: [
      { to: 'fiscal-periods', label: 'Fiscal Periods', icon: CalendarCheck, end: false },
      { to: 'settings', label: 'Settings', icon: SettingsIcon, end: false },
      { to: 'audit', label: 'Audit Trail', icon: History, end: false },
    ],
  },
  {
    heading: 'Automation',
    items: [
      { to: 'webhooks', label: 'Webhooks', icon: Webhook, end: true },
      { to: 'webhooks/deliveries', label: 'Deliveries', icon: Send, end: false },
    ],
  },
  {
    heading: 'Data migration',
    items: [{ to: 'migration-imports', label: 'Imports', icon: Upload, end: false }],
  },
] as const;
