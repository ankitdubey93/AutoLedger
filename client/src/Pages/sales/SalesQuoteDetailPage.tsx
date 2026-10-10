import QuoteDetailPage from './quotes/QuoteDetailPage';
import { SALES_QUOTE_KIND } from './quotes/quoteKinds';

/** One sales quote (Phase 41) — see sales/quotes/QuoteDetailPage.tsx. */
export default function SalesQuoteDetailPage() {
  return <QuoteDetailPage config={SALES_QUOTE_KIND} />;
}
