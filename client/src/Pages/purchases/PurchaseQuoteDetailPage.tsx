import QuoteDetailPage from '../sales/quotes/QuoteDetailPage';
import { PURCHASE_QUOTE_KIND } from '../sales/quotes/quoteKinds';

/** One purchase quote (Phase 41) — see sales/quotes/QuoteDetailPage.tsx. */
export default function PurchaseQuoteDetailPage() {
  return <QuoteDetailPage config={PURCHASE_QUOTE_KIND} />;
}
