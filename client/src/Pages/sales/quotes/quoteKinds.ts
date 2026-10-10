import {
  listCustomers,
  listVendors,
  type AccountType,
  type Item,
  type QuoteDirection,
} from '../../../services/fetchServices';

/**
 * Phase 41 — sales quotes and purchase quotes share one set of pages. Every
 * difference between the two lives here, as a `QuoteKindConfig`; the API is
 * the same resource in both directions (`/quotes` and `/purchase-quotes`),
 * so the pages pass `direction` straight through and never branch on it
 * for anything but wording.
 */

export interface QuoteParty {
  id: string;
  name: string;
  email: string | null;
}

export interface QuoteKindConfig {
  direction: QuoteDirection;
  title: string;
  plural: string;
  /** Route segment at the app root. */
  path: 'quotes' | 'purchase-quotes';
  partyNoun: 'Customer' | 'Vendor';
  newPartyPath: string;
  /** Account types a line may use — mirrors the server's assert*Accounts. */
  lineAccountTypes: readonly AccountType[];
  lineAccountLabel: string;
  /** What an accepted quote converts into. */
  convertNoun: 'invoice' | 'expense';
  convertPath: 'invoices' | 'expenses';
  /** The other side's reference: the customer's RFQ/PO no., or the vendor's own quote no. */
  partyReferenceLabel: string;
  sendNoun: string;
  listHint: string;
  formHint: string;
  permissions: { edit: string; send: string; convert: string };
  listParties: () => Promise<QuoteParty[]>;
  /** The defaults picking a catalogue item copies into a line, once. */
  itemDefaults: (item: Item) => { unitPriceCents: number; accountId: string; taxRateBp: number };
}

export const SALES_QUOTE_KIND: QuoteKindConfig = {
  direction: 'SALES',
  title: 'Quote',
  plural: 'Quotes',
  path: 'quotes',
  partyNoun: 'Customer',
  newPartyPath: '/customers?new=1',
  lineAccountTypes: ['Revenue'],
  lineAccountLabel: 'Revenue account',
  convertNoun: 'invoice',
  convertPath: 'invoices',
  partyReferenceLabel: 'Customer reference (RFQ / PO no.)',
  sendNoun: 'quote',
  listHint:
    'Offers to customers. A quote posts nothing to the ledger — once accepted, convert it to a draft invoice, which posts when issued.',
  formHint:
    'Saved as a draft. Sending it allocates a number and freezes it; changes after that are made as a revision.',
  permissions: { edit: 'quotes.edit', send: 'quotes.send', convert: 'quotes.convert' },
  async listParties() {
    const res = await listCustomers({ includeInactive: false });
    return res.customers.map((c) => ({ id: c.id, name: c.name, email: c.email }));
  },
  itemDefaults(item) {
    return {
      unitPriceCents: item.salePriceCents ?? 0,
      accountId: item.revenueAccountId ?? '',
      taxRateBp: item.saleTaxRateBp,
    };
  },
};

export const PURCHASE_QUOTE_KIND: QuoteKindConfig = {
  direction: 'PURCHASE',
  title: 'Purchase quote',
  plural: 'Purchase quotes',
  path: 'purchase-quotes',
  partyNoun: 'Vendor',
  newPartyPath: '/vendors?new=1',
  lineAccountTypes: ['Expense', 'Asset'],
  lineAccountLabel: 'Expense account',
  convertNoun: 'expense',
  convertPath: 'expenses',
  partyReferenceLabel: 'Vendor’s quote no.',
  sendNoun: 'price confirmation request',
  listHint:
    'Prices agreed with vendors. Record a vendor’s quote or send them a price confirmation request; once accepted, convert it to a draft expense.',
  formHint:
    'Saved as a draft. Sending (or recording the vendor’s acceptance) allocates a number and freezes it; changes after that are made as a revision.',
  permissions: { edit: 'purchase_quotes.edit', send: 'purchase_quotes.send', convert: 'purchase_quotes.convert' },
  async listParties() {
    const res = await listVendors({ includeInactive: false });
    return res.vendors.map((v) => ({ id: v.id, name: v.name, email: v.email }));
  },
  itemDefaults(item) {
    return {
      unitPriceCents: item.purchasePriceCents ?? 0,
      // An INVENTORY item is bought into its inventory (asset) account, as on an expense.
      accountId: (item.itemType === 'INVENTORY' ? item.assetAccountId : item.expenseAccountId) ?? '',
      taxRateBp: item.purchaseTaxRateBp,
    };
  },
};
