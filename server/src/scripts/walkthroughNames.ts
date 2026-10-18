import { WALKTHROUGH_DATASET, allCustomers, allVendors } from './walkthroughDataset.js';

/**
 * Display names shared by the walkthrough renderer and the guide renderer.
 * One place, so a name can never differ between `walkthrough/` and
 * `walkthrough/guide/`.
 */

export const DEMO_DEFAULT_EMAIL = 'demo@autoledger.dev';
export const DEMO_DEFAULT_PASSWORD = 'autoledger-demo';

/** Accounts of the default chart this scenario touches: code → "code name". */
export const DEFAULT_ACCOUNT_NAMES: Record<string, string> = {
  '1110': '1110 Operating Cash',
  '1115': '1115 EUR Receipts Account',
  '1120': '1120 Accounts Receivable',
  '1130': '1130 Prepaid Expenses',
  '1140': '1140 Inventory',
  '1180': '1180 GST/VAT Input Credit',
  '1500': '1500 Fixed Assets / Equipment',
  '2100': '2100 Accounts Payable',
  '2120': '2120 Accrued Liabilities',
  '2130': '2130 Customer Deposits',
  '2140': '2140 GST/VAT Output Payable',
  '2160': '2160 Payroll Liabilities',
  '3100': "3100 Common Stock / Owner's Capital",
  '4100': '4100 Product Revenue',
  '4200': '4200 Service Revenue',
  '4800': '4800 Sales Returns & Allowances',
  '4910': '4910 Realized FX Gain',
  '5050': '5050 Cost of Sales — Inventory',
  '5100': '5100 Direct Materials',
  '5200': '5200 Direct Labor',
  '5300': '5300 Freight & Duty',
  '6100': '6100 Salaries & Wages',
  '6110': '6110 Rent & Utilities',
  '6120': '6120 Software & IT Infrastructure',
  '6150': '6150 Insurance',
  '6200': '6200 Professional Fees',
  '6400': '6400 Marketing & Advertising',
  '6600': '6600 Bank Fees',
  '6810': '6810 Realized FX Loss',
  '6820': '6820 Unrealized FX Gain/Loss',
};

/** "code name" for an account — a dataset-added account first, then the default chart. */
export function accountName(code: string): string {
  const extra = WALKTHROUGH_DATASET.extraAccounts.find((a) => a.code === code);
  if (extra !== undefined) return `${extra.code} ${extra.name}`;
  const name = DEFAULT_ACCOUNT_NAMES[code];
  if (name === undefined) throw new Error(`no display name for account ${code}`);
  return name;
}

export function customerName(key: string): string {
  const c = allCustomers().find((x) => x.key === key);
  if (c === undefined) throw new Error(`no customer ${key}`);
  return c.name;
}

export function vendorName(key: string): string {
  const v = allVendors().find((x) => x.key === key);
  if (v === undefined) throw new Error(`no vendor ${key}`);
  return v.name;
}
