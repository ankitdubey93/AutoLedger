import type { QuoteDirection, QuoteStatus } from '../../../services/fetchServices';
import { formatCents, formatQuantity, formatRate } from '../../../utils/money';
import { formatDate } from '../../../utils/date';

/**
 * Phase 41 — a quote as the recipient sees it. Presentational only, no hooks
 * (like InvoiceDocument), so the in-app detail page and the public
 * `/quote/:token` page render the very same markup — what staff preview is
 * what the customer or vendor is shown and accepts.
 */

export interface QuoteDocumentData {
  direction: QuoteDirection;
  quoteNumber: string | null;
  revision: number;
  partyName: string;
  partyAddress: string | null;
  partyTaxNumber: string | null;
  partyReference: string | null;
  quoteDate: string;
  validUntil: string;
  currencyCode: string;
  title: string | null;
  notes: string | null;
  terms: string | null;
  paymentTerms: string | null;
  lines: {
    lineNumber: number;
    description: string;
    quantityMilli: number;
    unitPriceCents: number;
    taxRateBp: number;
    netCents: number;
    taxCents: number;
  }[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Phase 42 — the deposit requested on acceptance (basis points); absent or null = none. */
  depositPercentBp?: number | null;
}

/**
 * Phase 42 — the deposit amount for a quote total, rounded half-up exactly as
 * the server's scaleCents does, so the sentence matches the deposit invoice.
 */
export function depositAmountCents(totalCents: number, depositPercentBp: number): number {
  return Number((BigInt(totalCents) * BigInt(depositPercentBp) + BigInt(5000)) / BigInt(10000));
}

export interface QuoteDocumentProps {
  quote: QuoteDocumentData;
  merchantName: string;
  merchantAddressLines?: string[];
  logoSrc?: string | null;
}

const STATUS_STYLES: Record<QuoteStatus, { label: string; className: string }> = {
  DRAFT: { label: 'Draft', className: 'text-[var(--muted)]' },
  SENT: { label: 'Sent', className: 'bg-sky-500/10 text-sky-400 ring-sky-500/20' },
  ACCEPTED: { label: 'Accepted', className: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20' },
  CONVERTED: { label: 'Converted', className: 'bg-indigo-500/10 text-indigo-400 ring-indigo-500/20' },
  DECLINED: { label: 'Declined', className: 'bg-rose-500/10 text-rose-400 ring-rose-500/20' },
  EXPIRED: { label: 'Expired', className: 'bg-amber-500/10 text-amber-400 ring-amber-500/20' },
  VOID: { label: 'Void', className: 'bg-amber-500/10 text-amber-400 ring-amber-500/20' },
  SUPERSEDED: { label: 'Superseded', className: 'text-[var(--muted)]' },
};

export function quoteStatusLabel(status: QuoteStatus): string {
  return STATUS_STYLES[status].label;
}

export function QuoteStatusPill({ status }: { status: QuoteStatus }) {
  const style = STATUS_STYLES[status];
  const pill = status !== 'DRAFT' && status !== 'SUPERSEDED';
  return (
    <span
      className={[
        'text-[11px] uppercase tracking-wide',
        pill ? 'px-2 py-0.5 rounded-full ring-1 ring-inset' : '',
        style.className,
      ].join(' ')}
    >
      {style.label}
    </span>
  );
}

export function quoteLabel(quote: { quoteNumber: string | null; revision: number }): string {
  if (quote.quoteNumber === null) return quote.revision > 1 ? `Draft revision ${String(quote.revision)}` : 'Draft';
  return quote.revision > 1 ? `${quote.quoteNumber} rev ${String(quote.revision)}` : quote.quoteNumber;
}

export default function QuoteDocument({ quote, merchantName, merchantAddressLines = [], logoSrc = null }: QuoteDocumentProps) {
  const purchase = quote.direction === 'PURCHASE';
  const heading = purchase ? 'PURCHASE QUOTE' : 'QUOTE';

  return (
    <article
      className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-6 flex flex-col gap-6 text-sm"
      aria-label={`${heading} ${quote.quoteNumber ?? ''}`.trim()}
    >
      <header className="flex justify-between gap-6 flex-wrap">
        <div className="flex flex-col gap-1">
          {logoSrc !== null && <img src={logoSrc} alt="" className="max-h-12 max-w-[10rem] object-contain mb-2" />}
          <p className="m-0 font-semibold text-base">{merchantName}</p>
          {merchantAddressLines.map((line) => (
            <p key={line} className="m-0 text-[var(--muted)]">
              {line}
            </p>
          ))}
        </div>
        <div className="text-right flex flex-col gap-1">
          <p className="m-0 text-xl font-semibold tracking-wide">{heading}</p>
          <p className="m-0 font-mono" data-testid="quote-number">
            {quoteLabel(quote)}
          </p>
          <p className="m-0 text-[var(--muted)]">Date {formatDate(quote.quoteDate)}</p>
          <p className="m-0 text-[var(--muted)]">Valid until {formatDate(quote.validUntil)}</p>
        </div>
      </header>

      <section className="flex justify-between gap-6 flex-wrap">
        <div>
          <p className="m-0 text-xs uppercase tracking-wide text-[var(--muted)]">{purchase ? 'Vendor' : 'Prepared for'}</p>
          <p className="m-0 font-medium">{quote.partyName}</p>
          {quote.partyAddress !== null && <p className="m-0 whitespace-pre-line text-[var(--muted)]">{quote.partyAddress}</p>}
          {quote.partyTaxNumber !== null && <p className="m-0 text-[var(--muted)]">Tax no. {quote.partyTaxNumber}</p>}
        </div>
        <div className="text-right">
          {quote.partyReference !== null && (
            <p className="m-0">
              <span className="text-[var(--muted)]">{purchase ? 'Your quote no.' : 'Your reference'}</span> {quote.partyReference}
            </p>
          )}
          {quote.paymentTerms !== null && (
            <p className="m-0">
              <span className="text-[var(--muted)]">Payment terms</span> {quote.paymentTerms}
            </p>
          )}
          <p className="m-0">
            <span className="text-[var(--muted)]">Currency</span> {quote.currencyCode}
          </p>
        </div>
      </section>

      {quote.title !== null && <h3 className="m-0 text-base font-semibold">{quote.title}</h3>}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse min-w-[36rem]">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide border-b border-[var(--border)]">
              <th className="py-2 pr-2 font-medium">Description</th>
              <th className="py-2 px-2 font-medium text-right">Qty</th>
              <th className="py-2 px-2 font-medium text-right">Unit price</th>
              <th className="py-2 px-2 font-medium text-right">Tax</th>
              <th className="py-2 pl-2 font-medium text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {quote.lines.map((line) => (
              <tr key={line.lineNumber} className="border-b border-[var(--border)]">
                <td className="py-2 pr-2">{line.description}</td>
                <td className="py-2 px-2 text-right tabular-nums">{formatQuantity(line.quantityMilli)}</td>
                <td className="py-2 px-2 text-right tabular-nums">{formatCents(line.unitPriceCents)}</td>
                <td className="py-2 px-2 text-right tabular-nums">{line.taxRateBp === 0 ? '—' : `${formatRate(line.taxRateBp)}%`}</td>
                <td className="py-2 pl-2 text-right tabular-nums">{formatCents(line.netCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col items-end gap-1 self-end w-full max-w-xs">
        <div className="flex justify-between w-full">
          <span className="text-[var(--muted)]">Subtotal</span>
          <span className="tabular-nums">{formatCents(quote.subtotalCents)}</span>
        </div>
        <div className="flex justify-between w-full">
          <span className="text-[var(--muted)]">Tax</span>
          <span className="tabular-nums">{formatCents(quote.taxCents)}</span>
        </div>
        <div className="flex justify-between w-full font-semibold border-t border-[var(--border)] pt-1">
          <span>Total</span>
          <span className="tabular-nums" data-testid="quote-total">
            {formatCents(quote.totalCents)} {quote.currencyCode}
          </span>
        </div>
      </div>

      {quote.depositPercentBp !== undefined && quote.depositPercentBp !== null && (
        <p className="m-0 text-sm self-end">
          {`A deposit of ${formatRate(quote.depositPercentBp)}% (${quote.currencyCode} ${formatCents(depositAmountCents(quote.totalCents, quote.depositPercentBp))}) is due on acceptance.`}
        </p>
      )}

      {quote.notes !== null && (
        <section>
          <p className="m-0 text-xs uppercase tracking-wide text-[var(--muted)]">Notes</p>
          <p className="m-0 whitespace-pre-line">{quote.notes}</p>
        </section>
      )}
      {quote.terms !== null && (
        <section>
          <p className="m-0 text-xs uppercase tracking-wide text-[var(--muted)]">Terms and conditions</p>
          <p className="m-0 whitespace-pre-line" data-testid="quote-terms">
            {quote.terms}
          </p>
        </section>
      )}
    </article>
  );
}
