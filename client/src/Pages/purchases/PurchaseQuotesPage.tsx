import QuoteListPage from '../sales/quotes/QuoteListPage';
import { PURCHASE_QUOTE_KIND } from '../sales/quotes/quoteKinds';

/** The purchase quote register (Phase 41) — see sales/quotes/QuoteListPage.tsx. */
export default function PurchaseQuotesPage() {
  return <QuoteListPage config={PURCHASE_QUOTE_KIND} />;
}
