import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Download, Printer } from 'lucide-react';
import {
  ApiRequestError,
  confirmInvoicePayment,
  getPublicInvoice,
  getPublicInvoiceLogo,
  getPublicInvoicePdf,
  startInvoicePayment,
  type PublicInvoiceView,
} from '../../services/fetchServices';
import { formatCents, formatQuantity, formatRate } from '../../utils/money';
import { formatDate } from '../../utils/date';
import { saveBlob } from '../../utils/saveBlob';
import { secondaryButtonClass } from '../../components/ui/formClasses';
import StripePayPanel from './StripePayPanel';

/**
 * The page an emailed invoice links to (Phase 48). Public: no session, no app
 * shell — the token in the URL is the only credential, and the server
 * resolves the organization from it.
 *
 * Shows the invoice as the server describes it (the amounts come from the
 * server only) and, while something is owed and card payment is on, a card
 * panel that pays the whole amount due. A voided invoice and a fully paid one
 * still open, with their status, and offer no payment.
 */

const INVALID_LINK = 'This invoice link is not valid or has expired. Please contact the sender for a new one.';

const SINGLE_INVOICE = [{ documentId: 'invoice' }];

export default function PublicInvoicePage() {
  const { token = '' } = useParams<{ token: string }>();
  const [view, setView] = useState<PublicInvoiceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logoSrc, setLogoSrc] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getPublicInvoice(token, controller.signal)
      .then(setView)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          err instanceof ApiRequestError && err.status === 404
            ? INVALID_LINK
            : err instanceof Error
              ? err.message
              : 'Could not load the invoice',
        );
      });
    return () => controller.abort();
  }, [token, reload]);

  useEffect(() => {
    if (view?.merchant.hasLogo !== true) return;
    const controller = new AbortController();
    let url: string | null = null;
    getPublicInvoiceLogo(token, controller.signal)
      .then((blob) => {
        if (blob === null || controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setLogoSrc(url);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [token, view?.merchant.hasLogo]);

  const onPaid = useCallback(() => {
    setReload((n) => n + 1);
  }, []);
  const start = useCallback(() => startInvoicePayment(token), [token]);
  const confirm = useCallback((intentId: string) => confirmInvoicePayment(token, intentId), [token]);

  async function downloadPdf() {
    if (view === null) return;
    setPdfError(null);
    try {
      saveBlob(await getPublicInvoicePdf(token), `${view.invoice.number ?? 'invoice'}.pdf`);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Could not download the PDF');
    }
  }

  if (error !== null) {
    return (
      <main className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center p-6">
        <p className="status status--bad max-w-md">{error}</p>
      </main>
    );
  }

  if (view === null) {
    return (
      <main className="min-h-screen bg-[var(--bg)] p-6" aria-busy="true">
        <div className="skeleton skeleton--card max-w-4xl mx-auto" />
      </main>
    );
  }

  const { invoice, merchant } = view;
  const gstLabel = view.gst === undefined || view.gst === null ? 'Tax' : 'GST';
  const isVoid = invoice.status === 'VOID';
  const owing = !isVoid && invoice.amountDueCents > 0;
  const canPay = owing && view.payment.enabled;

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="no-print border-b border-[var(--border)] bg-[var(--panel)]">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center gap-3">
          {logoSrc !== null && <img src={logoSrc} alt="" className="max-h-10 max-w-[8rem] object-contain" />}
          <div>
            <p className="m-0 font-semibold">{merchant.name}</p>
            {view.gst?.abn !== null && view.gst?.abn !== undefined && <p className="m-0 text-sm text-[var(--muted)]">ABN {view.gst.abn}</p>}
            {merchant.addressLines.map((line) => (
              <p key={line} className="m-0 text-xs text-[var(--muted)]">
                {line}
              </p>
            ))}
          </div>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="flex flex-col gap-4 min-w-0" aria-label="Invoice">
          <div>
            <h1 className="page-title m-0">{view.gst?.registered === true ? 'Tax invoice' : 'Invoice'} {invoice.number ?? ''}</h1>
            <p className="text-sm text-[var(--muted)] m-0 mt-1">For {invoice.customerName}</p>
          </div>

          {isVoid && <p className="status status--bad m-0">This invoice has been voided.</p>}
          {!isVoid && invoice.amountDueCents === 0 && <p className="status status--good m-0">Paid in full. Thank you.</p>}

          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 m-0 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Issued</dt>
              <dd className="m-0">{formatDate(invoice.issueDate)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Due</dt>
              <dd className="m-0">{formatDate(invoice.dueDate)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Status</dt>
              <dd className="m-0">{isVoid ? 'Void' : invoice.amountDueCents === 0 ? 'Paid' : 'Awaiting payment'}</dd>
            </div>
          </dl>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[32rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium">Description</th>
                  <th className="p-3 font-medium text-right">Qty</th>
                  <th className="p-3 font-medium text-right">Unit price</th>
                  <th className="p-3 font-medium text-right">{gstLabel}</th>
                  <th className="p-3 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map((line, index) => (
                  <tr key={index} className="border-t border-[var(--border)]">
                    <td className="p-3">{line.description}</td>
                    <td className="p-3 text-right tabular-nums">{formatQuantity(line.quantityMilli)}</td>
                    <td className="p-3 text-right tabular-nums">{formatCents(line.unitPriceCents)}</td>
                    <td className="p-3 text-right tabular-nums">{formatRate(line.taxRateBp)}%</td>
                    <td className="p-3 text-right tabular-nums">{formatCents(line.netCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="m-0 ml-auto w-full max-w-xs text-sm flex flex-col gap-1">
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">Subtotal</dt>
              <dd className="m-0 tabular-nums">{formatCents(invoice.subtotalCents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">{gstLabel}</dt>
              <dd className="m-0 tabular-nums">{formatCents(invoice.taxCents)}</dd>
            </div>
            <div className="flex justify-between font-semibold">
              <dt>Total ({invoice.currencyCode})</dt>
              <dd className="m-0 tabular-nums">{formatCents(invoice.totalCents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">Paid</dt>
              <dd className="m-0 tabular-nums">{formatCents(invoice.paidCents)}</dd>
            </div>
            <div className="flex justify-between font-semibold">
              <dt>Amount due</dt>
              <dd className="m-0 tabular-nums" data-testid="amount-due">
                {formatCents(invoice.amountDueCents)} {invoice.currencyCode}
              </dd>
            </div>
          </dl>

          {invoice.paymentTerms !== null && (
            <p className="m-0 text-sm text-[var(--muted)]">Payment terms: {invoice.paymentTerms}</p>
          )}
          {invoice.notes !== null && <p className="m-0 text-sm whitespace-pre-line">{invoice.notes}</p>}
        </section>

        <aside className="no-print lg:sticky lg:top-6 lg:self-start flex flex-col gap-3">
          {canPay ? (
            <StripePayPanel
              selected={SINGLE_INVOICE}
              totalCents={invoice.amountDueCents}
              currency={invoice.currencyCode}
              start={start}
              confirm={confirm}
              onPaid={onPaid}
              cancelLabel="Cancel"
            />
          ) : (
            owing && (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-2 text-sm">
                <p className="m-0 font-semibold">How to pay</p>
                <p className="m-0 text-[var(--muted)]">Online payment isn't available for this invoice.</p>
                {view.bankDetails !== null && <p className="m-0 whitespace-pre-line">{view.bankDetails}</p>}
              </div>
            )
          )}
          {canPay && view.bankDetails !== null && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 text-sm">
              <p className="m-0 font-semibold">Or pay by bank transfer</p>
              <p className="m-0 mt-1 whitespace-pre-line">{view.bankDetails}</p>
            </div>
          )}
          <button type="button" className={secondaryButtonClass} onClick={() => void downloadPdf()}>
            <span className="inline-flex items-center gap-1.5">
              <Download size={15} aria-hidden="true" /> Download PDF
            </span>
          </button>
          <button type="button" className={secondaryButtonClass} onClick={() => window.print()}>
            <span className="inline-flex items-center gap-1.5">
              <Printer size={15} aria-hidden="true" /> Print
            </span>
          </button>
          {pdfError !== null && <p className="status status--bad m-0">{pdfError}</p>}
        </aside>
      </div>
    </main>
  );
}
