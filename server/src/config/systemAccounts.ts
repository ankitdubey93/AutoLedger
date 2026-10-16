/**
 * Phase 46a — the accounts the system itself posts to or reasons about.
 * A role is DERIVED, never stored: the effective account is the settings
 * column when set, else the account with `defaultCode`. This mirrors what
 * the posting resolvers do (systemAccountService parity test), so the lock
 * protects exactly the account postings would use.
 */
export type SystemAccountSettingColumn =
  | 'ledger_settings.payable_account_id'
  | 'ledger_settings.tax_input_account_id'
  | 'ledger_settings.stock_opening_account_id'
  | 'ledger_settings.realized_fx_gain_account_id'
  | 'ledger_settings.realized_fx_loss_account_id'
  | 'ledger_settings.unrealized_fx_account_id'
  | 'ledger_settings.inventory_account_id'
  | 'ledger_settings.cogs_account_id'
  | 'ledger_settings.inventory_adjustment_account_id'
  | 'ledger_invoice_settings.receivable_account_id'
  | 'ledger_invoice_settings.tax_payable_account_id'
  | 'ledger_invoice_settings.customer_deposit_account_id'
  | 'ledger_invoice_settings.supplier_prepayment_account_id';

export interface SystemAccountRoleDef {
  role: string;
  label: string;
  defaultCode: string;
  setting: SystemAccountSettingColumn | null;
  /** True when a settings page can point the role at another account. */
  remappable: boolean;
}

export const SYSTEM_ACCOUNT_ROLES = [
  { role: 'RECEIVABLE', label: 'Accounts Receivable', defaultCode: '1120', setting: 'ledger_invoice_settings.receivable_account_id', remappable: true },
  { role: 'PAYABLE', label: 'Accounts Payable', defaultCode: '2100', setting: 'ledger_settings.payable_account_id', remappable: false },
  { role: 'TAX_INPUT', label: 'Tax on purchases', defaultCode: '1180', setting: 'ledger_settings.tax_input_account_id', remappable: false },
  { role: 'TAX_OUTPUT', label: 'Tax on sales', defaultCode: '2140', setting: 'ledger_invoice_settings.tax_payable_account_id', remappable: true },
  { role: 'RETAINED_EARNINGS', label: 'Retained Earnings', defaultCode: '3200', setting: null, remappable: false },
  { role: 'OPENING_BALANCE', label: 'Historical adjustment', defaultCode: '3400', setting: null, remappable: false },
  { role: 'STOCK_OPENING', label: 'Opening stock', defaultCode: '3400', setting: 'ledger_settings.stock_opening_account_id', remappable: true },
  { role: 'REALIZED_FX_GAIN', label: 'Realized currency gains', defaultCode: '4910', setting: 'ledger_settings.realized_fx_gain_account_id', remappable: true },
  { role: 'REALIZED_FX_LOSS', label: 'Realized currency losses', defaultCode: '6810', setting: 'ledger_settings.realized_fx_loss_account_id', remappable: true },
  { role: 'UNREALIZED_FX', label: 'Unrealized currency gains', defaultCode: '6820', setting: 'ledger_settings.unrealized_fx_account_id', remappable: true },
  { role: 'INVENTORY', label: 'Inventory', defaultCode: '1140', setting: 'ledger_settings.inventory_account_id', remappable: true },
  { role: 'COGS', label: 'Cost of sales — inventory', defaultCode: '5050', setting: 'ledger_settings.cogs_account_id', remappable: true },
  { role: 'INVENTORY_ADJUSTMENT', label: 'Inventory adjustments', defaultCode: '5400', setting: 'ledger_settings.inventory_adjustment_account_id', remappable: true },
  { role: 'CUSTOMER_DEPOSITS', label: 'Customer deposits', defaultCode: '2130', setting: 'ledger_invoice_settings.customer_deposit_account_id', remappable: true },
  { role: 'SUPPLIER_PREPAYMENTS', label: 'Supplier prepayments', defaultCode: '1150', setting: 'ledger_invoice_settings.supplier_prepayment_account_id', remappable: true },
  { role: 'ROUNDING', label: 'Rounding', defaultCode: '6830', setting: null, remappable: false },
] as const satisfies readonly SystemAccountRoleDef[];

export type SystemAccountRole = (typeof SYSTEM_ACCOUNT_ROLES)[number]['role'];
