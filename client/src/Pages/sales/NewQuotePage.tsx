import QuoteFormPage from './quotes/QuoteFormPage';
import { SALES_QUOTE_KIND } from './quotes/quoteKinds';

/** Draft or edit a sales quote (Phase 41) — see sales/quotes/QuoteFormPage.tsx. */
export default function NewQuotePage() {
  return <QuoteFormPage config={SALES_QUOTE_KIND} />;
}
