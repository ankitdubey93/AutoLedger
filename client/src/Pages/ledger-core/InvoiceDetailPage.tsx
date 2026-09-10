import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import {
  ApiRequestError,
  getInvoice,
  getInvoiceSettings,
  issueInvoice,
  listPayments,
  voidInvoice,
  type Invoice,
  type InvoiceSettings,
  type Payment,
} from '../../services/fetchServices';
import { formatCents, formatQuantity, formatRate } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import { useOrg } from '../../context/OrgContext';
import { useLedgerSettings } from './LedgerSettingsContext';
import BackLink from '../../components/BackLink';
import ConfirmDialog from '../../components/ConfirmDialog';
import PaymentDialog from './PaymentDialog';
import AttachmentsPanel from '../../components/AttachmentsPanel';

/**
 * One invoice, in full — its own printable document, honouring the
 * organization's invoice-settings disclosure and branding choices.
 *
 * There is no edit control here on anything but a DRAFT: an issued invoice is
 * immutable (guardrails rule 6), enforced again by the database trigger. Issue
 * and Void both go through a confirmation dialog first, since both are
 * one-way — issuing allocates a number and posts to the GL; voiding posts a
 * reversal that cannot itself be undone.
 */

function statusLabel(status: Invoice['status']): string {
  if (status === 'DRAFT') return 'Draft';
  if (status === 'ISSUED') return 'Issued';
  return 'Void';
}

export default function InvoiceDetailPage() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const base = useAppBasePath();
  const { organization } = useOrg();
  const ledgerSettings = useLedgerSettings();

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [invoiceSettings, setInvoiceSettings] = useState<InvoiceSettings | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'issue' | 'void' | null>(null);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (invoiceId === undefined) return;
    let ignore = false;
    setInvoice(null);
    setNotFound(false);
    setError(null);

    Promise.all([getInvoice(invoiceId), getInvoiceSettings()])
      .then(([invoiceRes, settingsRes]) => {
        if (ignore) return;
        setInvoice(invoiceRes.invoice);
        setInvoiceSettings(settingsRes);
        return listPayments({ customerId: invoiceRes.invoice.customerId, direction: 'RECEIVE' });
      })
      .then((paymentsRes) => {
        if (ignore || paymentsRes === undefined) return;
        setPayments(
          paymentsRes.payments.filter((p) => p.allocations.some((a) => a.invoiceId === invoiceId)),
        );
      })
      .catch((err: unknown) => {
        if (ignore) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setNotFound(true);
        } else {
          setError(err instanceof Error ? err.message : 'Could not load the invoice');
        }
      });

    return () => {
      ignore = true;
    };
  }, [invoiceId, reloadToken]);

  async function handleIssue() {
    if (invoice === null) return;
    setBusy(true);
    setError(null);
    try {
      const { invoice: updated } = await issueInvoice(invoice.id);
      setInvoice(updated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not issue the invoice');
    } finally {
      setBusy(false);
    }
  }

  async function handleVoid() {
    if (invoice === null) return;
    setBusy(true);
    setError(null);
    try {
      const { invoice: updated } = await voidInvoice(invoice.id);
      setInvoice(updated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not void the invoice');
    } finally {
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to={`${base}/invoices`} label="Back to invoices" />
        <p className="status status--bad">Invoice not found.</p>
      </section>
    );
  }

  if (invoice === null) {
    return (
      <div className="shell" aria-busy="true">
        <div className="skeleton skeleton--title" />
        <span className="visually-hidden">Loading invoice…</span>
      </div>
    );
  }

  const settings = invoiceSettings;
  const legalName =
    ledgerSettings.status === 'ready' ? ledgerSettings.settings.legalName : null;

  return (
    <section className="flex flex-col gap-6">
      <BackLink to={`${base}/invoices`} label="Back to invoices" />

      <header className="no-print flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">{invoice.invoiceNumber ?? 'Draft invoice'}</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">{statusLabel(invoice.status)}</p>
        </div>
        <div className="flex items-center gap-2">
          {invoice.status === 'DRAFT' && (
            <Link
              to={`${base}/invoices/${invoice.id}/edit`}
              className="px-3 py-1.5 rounded-md text-sm no-underline text-[var(--muted)] hover:text-[var(--text)] border border-[var(--border)]"
            >
              Edit
            </Link>
          )}
          {invoice.status === 'DRAFT' && (
            <button
              type="button"
              onClick={() => setConfirmAction('issue')}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40"
            >
              Issue
            </button>
          )}
          {invoice.status === 'ISSUED' && invoice.amountDueCents > 0 && (
            <button
              type="button"
              onClick={() => setShowPaymentDialog(true)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40"
            >
              Record payment
            </button>
          )}
          {(invoice.status === 'DRAFT' || invoice.status === 'ISSUED') && (
            <button
              type="button"
              onClick={() => setConfirmAction('void')}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] cursor-pointer disabled:opacity-40"
            >
              Void
            </button>
          )}
          <button
            type="button"
            onClick={() => window.print()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] cursor-pointer"
          >
            <Printer size={14} aria-hidden="true" /> Print
          </button>
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      <div
        className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-6 flex flex-col gap-6"
        style={settings !== null ? { borderTopColor: settings.accentColor, borderTopWidth: '4px' } : undefined}
      >
        <div className="flex justify-between gap-6 flex-wrap">
          <div>
            {settings?.showLegalName === true && legalName !== null && (
              <p className="font-semibold m-0">{legalName}</p>
            )}
            {organization !== null && (
              <p className="text-sm text-[var(--muted)] m-0">{organization.name}</p>
            )}
            {settings?.showTaxNumber === true && organization?.taxNumber != null && (
              <p className="text-xs text-[var(--muted)] m-0">Tax no. {organization.taxNumber}</p>
            )}
            {settings?.showBusinessNumber === true && organization?.businessNumber != null && (
              <p className="text-xs text-[var(--muted)] m-0">Business no. {organization.businessNumber}</p>
            )}
            {settings?.billingAddress != null && (
              <p className="text-xs text-[var(--muted)] m-0 whitespace-pre-line">{settings.billingAddress}</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold m-0">{invoice.invoiceNumber ?? 'DRAFT'}</p>
            <p className="text-sm text-[var(--muted)] m-0">Issued {invoice.issueDate}</p>
            <p className="text-sm text-[var(--muted)] m-0">Due {invoice.dueDate}</p>
          </div>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Bill to</p>
          <p className="font-medium m-0 mt-1">{invoice.customerNameSnapshot}</p>
          {invoice.customerAddressSnapshot !== null && (
            <p className="text-sm text-[var(--muted)] m-0 whitespace-pre-line">
              {invoice.customerAddressSnapshot}
            </p>
          )}
          {invoice.customerTaxNumberSnapshot !== null && (
            <p className="text-xs text-[var(--muted)] m-0">Tax no. {invoice.customerTaxNumberSnapshot}</p>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[36rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-2 font-medium">Description</th>
                <th className="p-2 font-medium text-right">Qty</th>
                <th className="p-2 font-medium text-right">Unit price</th>
                <th className="p-2 font-medium">Account</th>
                <th className="p-2 font-medium text-right">Tax</th>
                <th className="p-2 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line) => (
                <tr key={line.id} className="border-t border-[var(--border)]">
                  <td className="p-2">{line.description}</td>
                  <td className="p-2 text-right tabular-nums">{formatQuantity(line.quantityMilli)}</td>
                  <td className="p-2 text-right tabular-nums">{formatCents(line.unitPriceCents)}</td>
                  <td className="p-2">
                    <Link
                      to={`${base}/accounts/${line.revenueAccountId}`}
                      className="text-[var(--text)] no-underline hover:underline"
                    >
                      {line.revenueAccountCode}
                    </Link>
                  </td>
                  <td className="p-2 text-right tabular-nums">
                    {line.taxRateBp > 0 ? `${formatRate(line.taxRateBp)}%` : '—'}
                  </td>
                  <td className="p-2 text-right tabular-nums">{formatCents(line.netCents + line.taxCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col items-end gap-1 max-w-xs self-end text-sm">
          <div className="flex justify-between w-full">
            <span className="text-[var(--muted)]">Subtotal</span>
            <span className="tabular-nums">{formatCents(invoice.subtotalCents)}</span>
          </div>
          <div className="flex justify-between w-full">
            <span className="text-[var(--muted)]">{settings?.taxLabel ?? 'Tax'}</span>
            <span className="tabular-nums">{formatCents(invoice.taxCents)}</span>
          </div>
          <div className="flex justify-between w-full font-semibold border-t border-[var(--border)] pt-1">
            <span>Total</span>
            <span className="tabular-nums">{formatCents(invoice.totalCents)} {invoice.currencyCode}</span>
          </div>
          {ledgerSettings.status === 'ready' && invoice.currencyCode !== ledgerSettings.settings.baseCurrency && (
            <div className="flex justify-between w-full text-[var(--muted)]">
              <span>≈ {ledgerSettings.settings.baseCurrency} (at {invoice.fxRate})</span>
              <span className="tabular-nums">{formatCents(invoice.baseTotalCents)}</span>
            </div>
          )}
          {invoice.status === 'ISSUED' && (
            <>
              <div className="flex justify-between w-full">
                <span className="text-[var(--muted)]">Paid</span>
                <span className="tabular-nums">{formatCents(invoice.allocatedCents)}</span>
              </div>
              <div className="flex justify-between w-full font-semibold">
                <span>Amount due</span>
                <span className="tabular-nums">{formatCents(invoice.amountDueCents)}</span>
              </div>
            </>
          )}
        </div>

        {invoice.paymentTerms !== null && (
          <p className="text-sm text-[var(--muted)] m-0">Payment terms: {invoice.paymentTerms}</p>
        )}
        {invoice.notes !== null && <p className="text-sm text-[var(--muted)] m-0">{invoice.notes}</p>}
        {settings?.footerNotes != null && (
          <p className="text-xs text-[var(--muted)] m-0 border-t border-[var(--border)] pt-3">
            {settings.footerNotes}
          </p>
        )}
      </div>

      <dl className="no-print grid grid-cols-2 sm:grid-cols-3 gap-4 m-0">
        {invoice.journalEntryId !== null && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Journal entry</dt>
            <dd className="m-0">
              <Link to={`${base}/journals/${invoice.journalEntryId}`}>
                {invoice.journalEntryId.slice(0, 8)}
              </Link>
            </dd>
          </div>
        )}
        {invoice.voidJournalEntryId !== null && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Void entry</dt>
            <dd className="m-0">
              <Link to={`${base}/journals/${invoice.voidJournalEntryId}`}>
                {invoice.voidJournalEntryId.slice(0, 8)}
              </Link>
            </dd>
          </div>
        )}
      </dl>

      {payments.length > 0 && (
        <div className="no-print flex flex-col gap-2">
          <h3 className="text-sm font-semibold m-0">Payments</h3>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[30rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-2 font-medium">Date</th>
                  <th className="p-2 font-medium">Status</th>
                  <th className="p-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id} className="border-t border-[var(--border)]">
                    <td className="p-2 tabular-nums">{payment.paymentDate}</td>
                    <td className="p-2">{payment.status === 'VOID' ? 'Void' : 'Posted'}</td>
                    <td className="p-2 text-right tabular-nums">
                      {formatCents(
                        payment.allocations.find((a) => a.invoiceId === invoice.id)?.amountCents ?? 0,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="no-print">
        <AttachmentsPanel appSlug="ledger-core" entityType="invoice" entityId={invoice.id} />
      </div>

      {confirmAction === 'issue' && (
        <ConfirmDialog
          title="Issue this invoice?"
          body="This allocates an invoice number and posts a balanced journal entry. An issued invoice can never be edited — only voided."
          confirmLabel="Issue invoice"
          tone="default"
          busy={busy}
          onConfirm={() => {
            setConfirmAction(null);
            void handleIssue();
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === 'void' && (
        <ConfirmDialog
          title="Void this invoice?"
          body="This posts a reversing journal entry and marks the invoice void. It cannot be undone."
          confirmLabel="Void invoice"
          tone="danger"
          busy={busy}
          onConfirm={() => {
            setConfirmAction(null);
            void handleVoid();
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {showPaymentDialog && (
        <PaymentDialog
          direction="RECEIVE"
          counterpartyId={invoice.customerId}
          counterpartyName={invoice.customerNameSnapshot}
          documentId={invoice.id}
          amountDueCents={invoice.amountDueCents}
          documentCurrencyCode={invoice.currencyCode}
          documentFxRate={invoice.fxRate}
          onClose={() => setShowPaymentDialog(false)}
          onRecorded={() => {
            setShowPaymentDialog(false);
            setReloadToken((t) => t + 1);
          }}
        />
      )}
    </section>
  );
}
