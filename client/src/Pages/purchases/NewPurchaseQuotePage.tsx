import QuoteFormPage from '../sales/quotes/QuoteFormPage';
import { PURCHASE_QUOTE_KIND } from '../sales/quotes/quoteKinds';

/** Draft or edit a purchase quote (Phase 41) — see sales/quotes/QuoteFormPage.tsx. */
export default function NewPurchaseQuotePage() {
  return <QuoteFormPage config={PURCHASE_QUOTE_KIND} />;
}
