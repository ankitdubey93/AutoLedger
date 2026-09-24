import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import {
  ApiRequestError,
  getInvoice,
  getInvoiceSettings,
  getOrganizationProfile,
  issueInvoice,
  listCreditNotes,
  listPayments,
  voidInvoice,
  type CreditNote,
  type Invoice,
  type InvoiceSettings,
  type OrganizationProfile,
  type Payment,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { useDocumentObjectUrl } from '../../utils/useDocumentObjectUrl';
import { useAppBasePath } from '../../apps/useAppBasePath';
import { useOrg } from '../../context/OrgContext';
import { useLedgerSettings } from './LedgerSettingsContext';
import BackLink from '../../components/BackLink';
import ConfirmDialog from '../../components/ConfirmDialog';
import PaymentDialog from './PaymentDialog';
import InvoiceDocument from './InvoiceDocument';
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
  const [profile, setProfile] = useState<OrganizationProfile | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [creditNotes, setCreditNotes] = useState<CreditNote[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'issue' | 'void' | null>(null);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const logoSrc = useDocumentObjectUrl(profile?.logoDocumentId ?? null);

  useEffect(() => {
    if (invoiceId === undefined) return;
    let ignore = false;
    setInvoice(null);
    setNotFound(false);
    setError(null);

    // Phase 26 — the credit notes raised against this invoice.
    listCreditNotes({ originalId: invoiceId, limit: 100 })
      .then((res) => {
        if (!ignore) setCreditNotes(res.creditNotes);
      })
      .catch(() => {
        if (!ignore) setCreditNotes([]);
      });

    // The profile is optional decoration (logo, address block): a failed fetch
    // becomes `null`, never a page error — an invoice must open and print without it.
    Promise.all([getInvoice(invoiceId), getInvoiceSettings(), getOrganizationProfile().catch(() => null)])
      .then(([invoiceRes, settingsRes, profileRes]) => {
        if (ignore) return;
        setInvoice(invoiceRes.invoice);
        setInvoiceSettings(settingsRes);
        setProfile(profileRes);
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
  // Until LedgerCore settings resolve there is no base currency to compare against, so
  // the "≈ base" row stays hidden — as it always has. Using the invoice's own currency
  // makes InvoiceDocument's `currencyCode !== baseCurrency` test false.
  const baseCurrency =
    ledgerSettings.status === 'ready' ? ledgerSettings.settings.baseCurrency : invoice.currencyCode;

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
              className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40"
            >
              Issue
            </button>
          )}
          {invoice.status === 'ISSUED' && invoice.amountDueCents > 0 && (
            <button
              type="button"
              onClick={() => setShowPaymentDialog(true)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40"
            >
              Record payment
            </button>
          )}
          {invoice.status === 'ISSUED' && (
            <Link
              to={`${base}/credit-notes/new?invoiceId=${invoice.id}`}
              className="px-3 py-1.5 rounded-md text-sm no-underline text-[var(--muted)] hover:text-[var(--text)] border border-[var(--border)]"
            >
              Create credit note
            </Link>
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

      <InvoiceDocument
        invoice={invoice}
        settings={settings}
        profile={profile}
        organizationName={organization?.name ?? ''}
        taxNumber={organization?.taxNumber ?? null}
        businessNumber={organization?.businessNumber ?? null}
        legalName={legalName}
        baseCurrency={baseCurrency}
        logoSrc={logoSrc}
        accountHref={(id) => `${base}/accounts/${id}`}
      />

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

      {creditNotes.length > 0 && (
        <div className="no-print flex flex-col gap-2">
          <h3 className="text-sm font-semibold m-0">Credit notes</h3>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[30rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-2 font-medium">Number</th>
                  <th className="p-2 font-medium">Date</th>
                  <th className="p-2 font-medium">Status</th>
                  <th className="p-2 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {creditNotes.map((note) => (
                  <tr key={note.id} className="border-t border-[var(--border)]">
                    <td className="p-2 font-mono text-xs">
                      <Link to={`${base}/credit-notes/${note.id}`}>{note.creditNoteNumber ?? 'Draft'}</Link>
                    </td>
                    <td className="p-2 tabular-nums">{note.issueDate}</td>
                    <td className="p-2">{note.status === 'DRAFT' ? 'Draft' : note.status === 'ISSUED' ? 'Issued' : 'Void'}</td>
                    <td className="p-2 text-right tabular-nums">{formatCents(note.totalCents)}</td>
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
