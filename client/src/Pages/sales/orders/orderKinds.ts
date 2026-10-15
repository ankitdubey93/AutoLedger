import type { QuoteDirection } from '../../../services/fetchServices';
import { PURCHASE_QUOTE_KIND, SALES_QUOTE_KIND, type QuoteKindConfig, type QuoteParty } from '../quotes/quoteKinds';

/**
 * Phase 42 — sales orders and purchase orders share one set of pages. Every
 * difference between the two lives here, as an `OrderKindConfig`; the API is
 * the same resource in both directions (`/orders` and `/purchase-orders`),
 * so the pages pass `direction` straight through and never branch on it for
 * anything but wording. Party lookups, line accounts and catalogue defaults
 * are the quote kinds' own, so an order prices exactly like its quote.
 */

export interface OrderKindConfig {
  direction: QuoteDirection;
  title: string;
  plural: string;
  /** Route segment at the app root (client routes use `sales-orders`, not `orders`). */
  path: 'sales-orders' | 'purchase-orders';
  partyNoun: 'Customer' | 'Vendor';
  newPartyPath: string;
  lineAccountTypes: QuoteKindConfig['lineAccountTypes'];
  lineAccountLabel: string;
  /** What a billing action creates: a draft invoice (sales) or a draft expense (purchase). */
  billNoun: 'invoice' | 'expense';
  billPath: 'invoices' | 'expenses';
  partyReferenceLabel: string;
  listHint: string;
  formHint: string;
  permissions: { view: string; edit: string; convert: string };
  listParties: () => Promise<QuoteParty[]>;
  itemDefaults: QuoteKindConfig['itemDefaults'];
}

export const SALES_ORDER_KIND: OrderKindConfig = {
  direction: 'SALES',
  title: 'Sales order',
  plural: 'Sales orders',
  path: 'sales-orders',
  partyNoun: 'Customer',
  newPartyPath: '/customers?new=1',
  lineAccountTypes: SALES_QUOTE_KIND.lineAccountTypes,
  lineAccountLabel: 'Revenue account',
  billNoun: 'invoice',
  billPath: 'invoices',
  partyReferenceLabel: 'Customer reference (PO no.)',
  listHint:
    'Confirmed commitments to customers. An order posts nothing to the ledger — invoice it in part or in full; the invoice posts when issued.',
  formHint: 'Saved as a draft. Confirming it allocates a number and freezes the lines; invoices are raised against the confirmed order.',
  permissions: { view: 'sales_orders.view', edit: 'sales_orders.edit', convert: 'sales_orders.convert' },
  listParties: SALES_QUOTE_KIND.listParties,
  itemDefaults: SALES_QUOTE_KIND.itemDefaults,
};

export const PURCHASE_ORDER_KIND: OrderKindConfig = {
  direction: 'PURCHASE',
  title: 'Purchase order',
  plural: 'Purchase orders',
  path: 'purchase-orders',
  partyNoun: 'Vendor',
  newPartyPath: '/vendors?new=1',
  lineAccountTypes: PURCHASE_QUOTE_KIND.lineAccountTypes,
  lineAccountLabel: 'Expense account',
  billNoun: 'expense',
  billPath: 'expenses',
  partyReferenceLabel: 'Vendor’s order no.',
  listHint:
    'Commitments made to vendors. An order posts nothing to the ledger — record the vendor’s bills against it in part or in full; each bill posts when approved.',
  formHint: 'Saved as a draft. Confirming it allocates a number and freezes the lines; expenses are raised against the confirmed order.',
  permissions: { view: 'purchase_orders.view', edit: 'purchase_orders.edit', convert: 'purchase_orders.convert' },
  listParties: PURCHASE_QUOTE_KIND.listParties,
  itemDefaults: PURCHASE_QUOTE_KIND.itemDefaults,
};
