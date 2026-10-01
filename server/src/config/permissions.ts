/**
 * Phase 38c — the permission catalogue. Every authenticated route names one
 * of these keys (`requirePermission`) or is explicitly open to any member
 * (`allowAnyMember`); a meta-test walks the router and fails if a route
 * does neither.
 *
 * Each key carries a **tier**, and the four built-in roles are defined by
 * tier, not by hand:
 *
 *   V — every member (VIEWER and up)      A — OWNER, ADMIN, ACCOUNTANT
 *   M — OWNER and ADMIN                    O — OWNER only
 *
 * The tiers reproduce, route for route, the `requireRole(...)` lists they
 * replaced, so the built-in roles behave exactly as before Phase 38c — the
 * pre-existing role tests are the proof. Presets live in code, not in the
 * database, so they cannot drift between organizations.
 *
 * A custom role is any set of keys except owner-tier ones. `requires` names
 * keys a permission is useless without (creating an invoice needs the
 * customer and product lists); saving a role adds them, so a role is never
 * half-usable.
 */

export type PermissionTier = 'V' | 'A' | 'M' | 'O';

export interface PermissionDefinition {
  key: string;
  area: string;
  label: string;
  tier: PermissionTier;
  requires?: readonly string[];
}

export const PERMISSION_AREAS = [
  'Reports',
  'Sales',
  'Purchases',
  'Banking',
  'Accounting',
  'Bill inbox',
  'Inventory',
  'Documents',
  'Organization',
] as const;

const DEFS = [
  // Reports
  { key: 'reports.view', area: 'Reports', label: 'View dashboard and reports', tier: 'V' },

  // Sales
  { key: 'invoices.view', area: 'Sales', label: 'View invoices', tier: 'V', requires: ['customers.view'] },
  { key: 'invoices.edit', area: 'Sales', label: 'Create and edit draft invoices', tier: 'A', requires: ['invoices.view', 'customers.view', 'products.view', 'accounts.view'] },
  { key: 'invoices.issue', area: 'Sales', label: 'Issue invoices', tier: 'A', requires: ['invoices.view'] },
  { key: 'invoices.void', area: 'Sales', label: 'Void invoices', tier: 'A', requires: ['invoices.view'] },
  { key: 'credit_notes.view', area: 'Sales', label: 'View credit notes', tier: 'V', requires: ['customers.view'] },
  { key: 'credit_notes.edit', area: 'Sales', label: 'Create and edit draft credit notes', tier: 'A', requires: ['credit_notes.view', 'invoices.view', 'accounts.view'] },
  { key: 'credit_notes.issue', area: 'Sales', label: 'Issue and apply credit notes', tier: 'A', requires: ['credit_notes.view'] },
  { key: 'credit_notes.void', area: 'Sales', label: 'Void credit notes', tier: 'A', requires: ['credit_notes.view'] },
  { key: 'customers.view', area: 'Sales', label: 'View customers', tier: 'V' },
  { key: 'customers.manage', area: 'Sales', label: 'Create and edit customers', tier: 'A', requires: ['customers.view'] },

  // Purchases
  { key: 'bills.view', area: 'Purchases', label: 'View expenses (bills)', tier: 'V', requires: ['vendors.view'] },
  { key: 'bills.edit', area: 'Purchases', label: 'Create, edit and submit expenses', tier: 'A', requires: ['bills.view', 'vendors.view', 'products.view', 'accounts.view'] },
  { key: 'bills.approve', area: 'Purchases', label: 'Approve expenses', tier: 'M', requires: ['bills.view'] },
  { key: 'bills.void', area: 'Purchases', label: 'Void expenses', tier: 'A', requires: ['bills.view'] },
  { key: 'debit_notes.view', area: 'Purchases', label: 'View debit notes', tier: 'V', requires: ['vendors.view'] },
  { key: 'debit_notes.edit', area: 'Purchases', label: 'Create and edit draft debit notes', tier: 'A', requires: ['debit_notes.view', 'bills.view', 'accounts.view'] },
  { key: 'debit_notes.issue', area: 'Purchases', label: 'Issue and apply debit notes', tier: 'A', requires: ['debit_notes.view'] },
  { key: 'debit_notes.void', area: 'Purchases', label: 'Void debit notes', tier: 'A', requires: ['debit_notes.view'] },
  { key: 'vendors.view', area: 'Purchases', label: 'View vendors', tier: 'V' },
  { key: 'vendors.manage', area: 'Purchases', label: 'Create and edit vendors', tier: 'A', requires: ['vendors.view'] },

  // Banking
  { key: 'payments.view', area: 'Banking', label: 'View payments', tier: 'V' },
  { key: 'payments.create', area: 'Banking', label: 'Record payments', tier: 'A', requires: ['payments.view', 'invoices.view', 'bills.view', 'accounts.view'] },
  { key: 'payments.void', area: 'Banking', label: 'Void payments', tier: 'A', requires: ['payments.view'] },
  { key: 'bank.view', area: 'Banking', label: 'View bank statements and rules', tier: 'V' },
  { key: 'bank.reconcile', area: 'Banking', label: 'Import statements, reconcile and manage bank rules', tier: 'A', requires: ['bank.view', 'accounts.view'] },

  // Accounting
  { key: 'accounts.view', area: 'Accounting', label: 'View chart of accounts and ledgers', tier: 'V' },
  { key: 'accounts.manage', area: 'Accounting', label: 'Create and edit accounts', tier: 'A', requires: ['accounts.view'] },
  { key: 'journals.view', area: 'Accounting', label: 'View journal entries', tier: 'V', requires: ['accounts.view'] },
  { key: 'journals.create', area: 'Accounting', label: 'Post and reverse journal entries', tier: 'A', requires: ['journals.view'] },
  { key: 'products.view', area: 'Accounting', label: 'View products and services', tier: 'V' },
  { key: 'products.manage', area: 'Accounting', label: 'Create and edit products and services', tier: 'A', requires: ['products.view', 'accounts.view'] },
  { key: 'payment_terms.manage', area: 'Accounting', label: 'Manage payment terms', tier: 'A' },
  { key: 'recurring.view', area: 'Accounting', label: 'View recurring schedules', tier: 'V' },
  { key: 'recurring.manage', area: 'Accounting', label: 'Manage recurring schedules', tier: 'A', requires: ['recurring.view'] },
  { key: 'periods.view', area: 'Accounting', label: 'View fiscal periods', tier: 'V' },
  { key: 'periods.close', area: 'Accounting', label: 'Generate, close and reopen periods', tier: 'M', requires: ['periods.view'] },
  { key: 'periods.lock', area: 'Accounting', label: 'Lock periods permanently', tier: 'O', requires: ['periods.view'] },
  { key: 'fx.view', area: 'Accounting', label: 'View exchange rates and revaluations', tier: 'V' },
  { key: 'fx.rates_edit', area: 'Accounting', label: 'Enter exchange rates', tier: 'A', requires: ['fx.view'] },
  { key: 'fx.rates_delete', area: 'Accounting', label: 'Delete exchange rates', tier: 'M', requires: ['fx.view'] },
  { key: 'fx.revalue', area: 'Accounting', label: 'Run period-end revaluation', tier: 'M', requires: ['fx.view'] },
  { key: 'imports.view', area: 'Accounting', label: 'View CSV imports', tier: 'V' },
  { key: 'imports.stage', area: 'Accounting', label: 'Upload, map and fix CSV imports', tier: 'A', requires: ['imports.view'] },
  { key: 'imports.commit', area: 'Accounting', label: 'Commit CSV imports', tier: 'M', requires: ['imports.stage'] },

  // Bill inbox
  { key: 'capture.view', area: 'Bill inbox', label: 'View the bill inbox and AI usage', tier: 'V' },
  { key: 'capture.process', area: 'Bill inbox', label: 'Upload, review and post captured bills', tier: 'A', requires: ['capture.view', 'bills.edit'] },
  { key: 'capture.settings', area: 'Bill inbox', label: 'Change bill inbox settings', tier: 'M', requires: ['capture.view'] },

  // Inventory
  { key: 'inventory.view', area: 'Inventory', label: 'View stock items, balances and movements', tier: 'V' },
  { key: 'inventory.operate', area: 'Inventory', label: 'Create items and record stock movements', tier: 'A', requires: ['inventory.view', 'products.view', 'accounts.view'] },
  { key: 'inventory.configure', area: 'Inventory', label: 'Configure locations, categories, units and codes', tier: 'M', requires: ['inventory.view'] },

  // Documents
  { key: 'documents.view', area: 'Documents', label: 'View documents', tier: 'V' },
  { key: 'documents.upload', area: 'Documents', label: 'Upload and attach documents', tier: 'A', requires: ['documents.view'] },
  { key: 'documents.delete', area: 'Documents', label: 'Delete documents', tier: 'M', requires: ['documents.view'] },

  // Organization
  { key: 'settings.manage', area: 'Organization', label: 'Change organization and accounting settings', tier: 'M' },
  { key: 'members.view', area: 'Organization', label: 'View members and invitations', tier: 'M' },
  { key: 'members.manage', area: 'Organization', label: 'Invite, change roles and remove members', tier: 'M', requires: ['members.view'] },
  { key: 'roles.manage', area: 'Organization', label: 'Create and edit custom roles', tier: 'M', requires: ['members.view'] },
  { key: 'audit.view', area: 'Organization', label: 'View the audit log', tier: 'M' },
  { key: 'webhooks.manage', area: 'Organization', label: 'Manage webhooks and deliveries', tier: 'M' },
  { key: 'webhooks.secrets', area: 'Organization', label: 'Delete webhooks and rotate secrets', tier: 'O', requires: ['webhooks.manage'] },
  { key: 'integrations.view', area: 'Organization', label: 'View connections', tier: 'V' },
  { key: 'integrations.manage', area: 'Organization', label: 'Connect and configure Google Drive', tier: 'M', requires: ['integrations.view'] },
  { key: 'integrations.sync', area: 'Organization', label: 'Sync a connected folder now', tier: 'A', requires: ['integrations.view'] },
] as const satisfies readonly PermissionDefinition[];

export type Permission = (typeof DEFS)[number]['key'];

export const PERMISSIONS: readonly PermissionDefinition[] = DEFS;
export const PERMISSION_KEYS: readonly Permission[] = DEFS.map((d) => d.key);

const BY_KEY = new Map<string, PermissionDefinition>(DEFS.map((d) => [d.key, d]));

export function isPermission(value: string): value is Permission {
  return BY_KEY.has(value);
}

/** Owner-tier keys: held by OWNER only and never assignable to a custom role. */
export const OWNER_ONLY_PERMISSIONS: ReadonlySet<string> = new Set(DEFS.filter((d) => d.tier === 'O').map((d) => d.key));

const TIERS_FOR_ROLE = {
  OWNER: ['V', 'A', 'M', 'O'],
  ADMIN: ['V', 'A', 'M'],
  ACCOUNTANT: ['V', 'A'],
  VIEWER: ['V'],
} as const satisfies Record<string, readonly PermissionTier[]>;

export type BuiltinRole = keyof typeof TIERS_FOR_ROLE;

/** The four built-in roles' permission sets, derived from the tiers. */
export const BUILTIN_ROLE_PERMISSIONS: Readonly<Record<BuiltinRole, ReadonlySet<Permission>>> = {
  OWNER: new Set(DEFS.filter((d) => (TIERS_FOR_ROLE.OWNER as readonly string[]).includes(d.tier)).map((d) => d.key)),
  ADMIN: new Set(DEFS.filter((d) => (TIERS_FOR_ROLE.ADMIN as readonly string[]).includes(d.tier)).map((d) => d.key)),
  ACCOUNTANT: new Set(DEFS.filter((d) => (TIERS_FOR_ROLE.ACCOUNTANT as readonly string[]).includes(d.tier)).map((d) => d.key)),
  VIEWER: new Set(DEFS.filter((d) => (TIERS_FOR_ROLE.VIEWER as readonly string[]).includes(d.tier)).map((d) => d.key)),
};

/**
 * Closes a set of keys over `requires` (transitively), dropping unknown
 * keys. Saving a custom role stores the closed set, so what the editor
 * shows is exactly what the role holds — no hidden runtime expansion.
 */
export function withRequiredPermissions(keys: Iterable<string>): Set<Permission> {
  const out = new Set<Permission>();
  const stack = [...keys];
  while (stack.length > 0) {
    const key = stack.pop();
    if (key === undefined || !isPermission(key) || out.has(key)) continue;
    out.add(key);
    for (const req of BY_KEY.get(key)?.requires ?? []) stack.push(req);
  }
  return out;
}
