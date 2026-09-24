import { LayoutDashboard, Package, ArrowRightLeft, MapPin, Tags, Search, Settings, Hash } from 'lucide-react';

/**
 * StockLedger's navigation as data, extracted from StockSidebar verbatim
 * (Phase 31). One group ("Inventory") because AppSidebar always renders a
 * heading row for grouping/collapse consistency with LedgerCore's multi-group
 * rail, even where there is only one group.
 *
 * `settings` needs `end: true` — without it, `NavLink`'s default prefix
 * matching would also mark it active on `settings/codes`.
 */
export const STOCK_NAV_GROUPS = [
  {
    heading: 'Inventory',
    items: [
      { to: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, end: false },
      { to: 'items', label: 'Items', icon: Package, end: false },
      { to: 'movements', label: 'Movements', icon: ArrowRightLeft, end: false },
      { to: 'locations', label: 'Locations', icon: MapPin, end: false },
      { to: 'labels', label: 'Labels', icon: Tags, end: false },
      { to: 'lookup', label: 'Lookup', icon: Search, end: false },
      { to: 'settings', label: 'Catalogue', icon: Settings, end: true },
      { to: 'settings/codes', label: 'Item codes', icon: Hash, end: false },
    ],
  },
] as const;
