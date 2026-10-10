import QuoteListPage from './quotes/QuoteListPage';
import { SALES_QUOTE_KIND } from './quotes/quoteKinds';

/** The sales quote register (Phase 41) — see sales/quotes/QuoteListPage.tsx. */
export default function QuotesPage() {
  return <QuoteListPage config={SALES_QUOTE_KIND} />;
}
