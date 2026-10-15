import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiRequestError,
  applyPrepayment,
  approveBill,
  getAvailableCredits,
  getBill,
  listBills,
  listDebitNotes,
  listPayments,
  submitBill,
  voidBill,
  voidDepositApplication,
  type AvailableCredit,
  type Bill,
  type DebitNote,
  type Payment,
} from '../../services/fetchServices';
import { formatCents, formatQuantity, formatRate, parseCentsInput } from '../../utils/money';
import { useLedgerSettings } from '../../context/LedgerSettingsContext';
import BackLink from '../../components/BackLink';
import ConfirmDialog from '../../components/ConfirmDialog';
import ApplyCreditsDialog from '../../components/ApplyCreditsDialog';
import type { ApplyCredit } from '../../components/ApplyCreditsDialog';
import PaymentDialog from '../sales/PaymentDialog';
import AttachmentsPanel from '../../components/AttachmentsPanel';
import MakeRecurringDialog from '../../components/MakeRecurringDialog';
import { formatDate } from '../../utils/date';
import { useCan } from '../../context/AuthContext';

/**
 * One bill, in full. Approve and Void are both gated by a confirmation
 * dialog — approving posts a balanced journal entry and submitting for
 * review, editing, and deleting all stop being possible once posted;
 * voiding posts a reversal that cannot itself be undone (guardrails rule 6).
 *
 * Approval is restricted to OWNER/ADMIN server-side; the button is hidden
 * for anyone else so the 403 is never actually reached in the common case.
 */

function statusLabel(status: Bill['status']): string {
  if (status === 'DRAFT') return 'Draft';
  if (status === 'AWAITING_APPROVAL') return 'Awaiting approval';
  if (status === 'POSTED') return 'Posted';
  return 'Void';
}

export default function BillDetailPage() {
  const { billId } = useParams<{ billId: string }>();
  const navigate = useNavigate();
  const can = useCan();
  const ledgerSettings = useLedgerSettings();

  const [bill, setBill] = useState<Bill | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [debitNotes, setDebitNotes] = useState<DebitNote[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMakeRecurringDialog, setShowMakeRecurringDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'approve' | 'void' | null>(null);
  const [creditsOffer, setCreditsOffer] = useState<AvailableCredit[] | null>(null);
  const [creditsError, setCreditsError] = useState<string | null>(null);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [showApplyPrepayment, setShowApplyPrepayment] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (billId === undefined) return;
    let ignore = false;
    setError(null);

    // Phase 26 — the debit notes raised against this expense.
    listDebitNotes({ originalId: billId, limit: 100 })
      .then((res) => {
        if (!ignore) setDebitNotes(res.debitNotes);
      })
      .catch(() => {
        if (!ignore) setDebitNotes([]);
      });

    getBill(billId)
      .then((res) => {
        if (ignore) return;
        setBill(res.bill);
        return listPayments({ vendorId: res.bill.vendorId, direction: 'PAY' });
      })
      .then((paymentsRes) => {
        if (ignore || paymentsRes === undefined) return;
        setPayments(paymentsRes.payments.filter((p) => p.allocations.some((a) => a.billId === billId)));
      })
      .catch((err: unknown) => {
        if (ignore) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setNotFound(true);
        } else {
          setError(err instanceof Error ? err.message : 'Could not load the expense');
        }
      });

    return () => {
      ignore = true;
    };
  }, [billId, reloadToken]);

  async function handleSubmitForReview() {
    if (bill === null) return;
    setBusy(true);
    setError(null);
    try {
      const { bill: updated } = await submitBill(bill.id);
      setBill(updated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not submit the expense');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Phase 43c — approving first looks for open debit notes and prepayments. Any
   * to offer opens the apply-credit dialog; none (or a failed lookup — credit is
   * optional) goes straight to the ordinary confirmation.
   */
  async function startApprove() {
    if (bill === null) return;
    setBusy(true);
    setError(null);
    try {
      const { credits } = await getAvailableCredits('PURCHASE', bill.id);
      if (credits.length > 0) {
        setCreditsError(null);
        setCreditsOffer(credits);
      } else {
        setConfirmAction('approve');
      }
    } catch {
      setConfirmAction('approve');
    } finally {
      setBusy(false);
    }
  }

  async function handleApproveWithCredits(applyCredits: ApplyCredit[]) {
    if (bill === null) return;
    setBusy(true);
    setCreditsError(null);
    try {
      const { bill: updated } = await approveBill(bill.id, null, applyCredits);
      setBill(updated);
      setCreditsOffer(null);
      setReloadToken((n) => n + 1);
    } catch (err: unknown) {
      setCreditsError(err instanceof Error ? err.message : 'Could not approve the expense');
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove() {
    if (bill === null) return;
    setBusy(true);
    setError(null);
    try {
      const { bill: updated } = await approveBill(bill.id);
      setBill(updated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not approve the expense');
    } finally {
      setBusy(false);
    }
  }

  /** Phase 42 — voids one prepayment application; the document reloads with the reversed amounts. */
  async function handleVoidApplication(applicationId: string) {
    if (bill === null) return;
    setBusy(true);
    setError(null);
    try {
      await voidDepositApplication('PURCHASE', applicationId);
      setReloadToken((n) => n + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not void the prepayment application');
    } finally {
      setBusy(false);
    }
  }

  async function handleVoid() {
    if (bill === null) return;
    setBusy(true);
    setError(null);
    try {
      const { bill: updated } = await voidBill(bill.id);
      setBill(updated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not void the expense');
    } finally {
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to="/expenses" label="Back to expenses" />
        <p className="status status--bad">Expense not found.</p>
      </section>
    );
  }

  // A load that failed for any reason other than 404 would otherwise leave
  // the loading placeholder up forever — the page-level error below never renders.
  if (bill === null && error !== null) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to="/expenses" label="Back to expenses" />
        <p className="status status--bad">{error}</p>
      </section>
    );
  }

  if (bill === null) {
    return (
      <div className="shell" aria-busy="true">
        <div className="skeleton skeleton--title" />
        <span className="visually-hidden">Loading expense…</span>
      </div>
    );
  }

  // Phase 38c — the permission the server checks on these routes.
  const canApprove = can('bills.approve');

  /** Phase 42 — prepayments are base currency only; the ledger's base currency decides. */
  const baseCurrency = ledgerSettings.status === 'ready' ? ledgerSettings.settings.baseCurrency : bill.currencyCode;

  return (
    <section className="flex flex-col gap-6">
      <BackLink to="/expenses" label="Back to expenses" />

      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">{bill.vendorReference}</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">{statusLabel(bill.status)}</p>
          {bill.kind === 'DEPOSIT' && (
            <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded-full border border-[var(--border)] text-[var(--muted)]">
              Deposit
            </span>
          )}
          {bill.lines.some((line) => line.orderLineId !== null) && (
            <p className="text-sm text-[var(--muted)] m-0 mt-1">Raised against an order</p>
          )}
          {bill.sourceQuote !== null && (
            <p className="text-sm text-[var(--muted)] m-0 mt-1">
              From quote{' '}
              <Link to={`/purchase-quotes/${bill.sourceQuote.id}`}>
                {bill.sourceQuote.quoteNumber}
                {bill.sourceQuote.revision > 1 ? ` rev ${String(bill.sourceQuote.revision)}` : ''}
              </Link>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {(bill.status === 'DRAFT' || bill.status === 'AWAITING_APPROVAL') && (
            <Link
              to={`/expenses/${bill.id}/edit`}
              className="px-3 py-1.5 rounded-md text-sm no-underline text-[var(--muted)] hover:text-[var(--text)] border border-[var(--border)]"
            >
              Edit
            </Link>
          )}
          {bill.status === 'DRAFT' && (
            <button
              type="button"
              onClick={() => void handleSubmitForReview()}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] cursor-pointer disabled:opacity-40"
            >
              Submit for review
            </button>
          )}
          {bill.status === 'DRAFT' && (
            <button
              type="button"
              onClick={() => setShowMakeRecurringDialog(true)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] cursor-pointer disabled:opacity-40"
            >
              Make recurring
            </button>
          )}
          {bill.status === 'AWAITING_APPROVAL' && canApprove && (
            <button
              type="button"
              onClick={() => void startApprove()}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40"
            >
              Approve
            </button>
          )}
          {bill.status === 'POSTED' && bill.kind === 'STANDARD' && bill.amountDueCents > 0 && canApprove && bill.currencyCode === baseCurrency && (
            <button
              type="button"
              onClick={() => setShowApplyPrepayment(true)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] cursor-pointer disabled:opacity-40"
            >
              Apply prepayment
            </button>
          )}
          {bill.status === 'POSTED' && bill.amountDueCents > 0 && (
            <button
              type="button"
              onClick={() => setShowPaymentDialog(true)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40"
            >
              Record payment
            </button>
          )}
          {bill.status === 'POSTED' && (
            <Link
              to={`/debit-notes/new?billId=${bill.id}`}
              className="px-3 py-1.5 rounded-md text-sm no-underline text-[var(--muted)] hover:text-[var(--text)] border border-[var(--border)]"
            >
              Create debit note
            </Link>
          )}
          {(bill.status === 'DRAFT' || bill.status === 'AWAITING_APPROVAL' || bill.status === 'POSTED') && (
            <button
              type="button"
              onClick={() => setConfirmAction('void')}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] cursor-pointer disabled:opacity-40"
            >
              Void
            </button>
          )}
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-6 flex flex-col gap-6">
        <div className="flex justify-between gap-6 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Vendor</p>
            <p className="font-medium m-0 mt-1">{bill.vendorNameSnapshot}</p>
            {bill.vendorAddressSnapshot !== null && (
              <p className="text-sm text-[var(--muted)] m-0 whitespace-pre-line">
                {bill.vendorAddressSnapshot}
              </p>
            )}
            {bill.vendorTaxNumberSnapshot !== null && (
              <p className="text-xs text-[var(--muted)] m-0">Tax no. {bill.vendorTaxNumberSnapshot}</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold m-0">{bill.vendorReference}</p>
            <p className="text-sm text-[var(--muted)] m-0">Expense date {formatDate(bill.billDate)}</p>
            <p className="text-sm text-[var(--muted)] m-0">Due {formatDate(bill.dueDate)}</p>
            {bill.purchaseOrderId !== null && (
              <p className="text-sm text-[var(--muted)] m-0">
                Purchase order{' '}
                <Link to={`/purchase-orders/${bill.purchaseOrderId}`}>{bill.purchaseOrderNumber ?? 'Purchase order'}</Link>
              </p>
            )}
          </div>
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
              {bill.lines.map((line) => (
                <tr key={line.id} className="border-t border-[var(--border)]">
                  <td className="p-2">{line.description}</td>
                  <td className="p-2 text-right tabular-nums">{formatQuantity(line.quantityMilli)}</td>
                  <td className="p-2 text-right tabular-nums">{formatCents(line.unitPriceCents)}</td>
                  <td className="p-2">
                    <Link
                      to={`/accounts/${line.expenseAccountId}`}
                      className="text-[var(--text)] no-underline hover:underline"
                    >
                      {line.expenseAccountCode}
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

        <div className="flex flex-col items-end gap-1.5 w-full max-w-sm self-end text-sm">
          <div className="flex justify-between gap-6 w-full">
            <span className="text-[var(--muted)] min-w-0">Subtotal</span>
            <span className="tabular-nums whitespace-nowrap">{formatCents(bill.subtotalCents)}</span>
          </div>
          <div className="flex justify-between gap-6 w-full">
            <span className="text-[var(--muted)] min-w-0">Tax</span>
            <span className="tabular-nums whitespace-nowrap">{formatCents(bill.taxCents)}</span>
          </div>
          <div className="flex justify-between gap-6 w-full font-semibold border-t border-[var(--border)] pt-2">
            <span className="min-w-0">Total</span>
            <span className="tabular-nums whitespace-nowrap">{formatCents(bill.totalCents)} {bill.currencyCode}</span>
          </div>
          {ledgerSettings.status === 'ready' && bill.currencyCode !== ledgerSettings.settings.baseCurrency && (
            <div className="flex justify-between gap-6 w-full text-[var(--muted)]">
              <span className="min-w-0">≈ {ledgerSettings.settings.baseCurrency} (at {bill.fxRate})</span>
              <span className="tabular-nums whitespace-nowrap">{formatCents(bill.baseTotalCents)}</span>
            </div>
          )}
          {bill.status === 'POSTED' && (
            <>
              <div className="flex justify-between gap-6 w-full">
                <span className="text-[var(--muted)] min-w-0">Paid</span>
                <span className="tabular-nums whitespace-nowrap">{formatCents(bill.allocatedCents)}</span>
              </div>
              {bill.debitedCents > 0 && (
                <div className="flex justify-between gap-6 w-full">
                  <span className="text-[var(--muted)] min-w-0">Debits applied</span>
                  <span className="tabular-nums whitespace-nowrap">{formatCents(bill.debitedCents)}</span>
                </div>
              )}
              <div className="flex justify-between gap-6 w-full font-semibold">
                <span className="min-w-0">Amount due</span>
                <span className="tabular-nums whitespace-nowrap">{formatCents(bill.amountDueCents)}</span>
              </div>
            </>
          )}
        </div>

        {bill.paymentTerms !== null && (
          <p className="text-sm text-[var(--muted)] m-0">Payment terms: {bill.paymentTerms}</p>
        )}
        {bill.notes !== null && <p className="text-sm text-[var(--muted)] m-0">{bill.notes}</p>}
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 m-0">
        {bill.journalEntryId !== null && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Journal entry</dt>
            <dd className="m-0">
              <Link to={`/journals/${bill.journalEntryId}`}>{bill.journalEntryId.slice(0, 8)}</Link>
            </dd>
          </div>
        )}
        {bill.voidJournalEntryId !== null && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Void entry</dt>
            <dd className="m-0">
              <Link to={`/journals/${bill.voidJournalEntryId}`}>
                {bill.voidJournalEntryId.slice(0, 8)}
              </Link>
            </dd>
          </div>
        )}
      </dl>

      {payments.length > 0 && (
        <div className="flex flex-col gap-2">
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
                    <td className="p-2 tabular-nums">{formatDate(payment.paymentDate)}</td>
                    <td className="p-2">{payment.status === 'VOID' ? 'Void' : 'Posted'}</td>
                    <td className="p-2 text-right tabular-nums">
                      {formatCents(
                        payment.allocations.find((a) => a.billId === bill.id)?.amountCents ?? 0,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {bill.depositApplications.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold m-0">Deposits applied</h3>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[30rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-2 font-medium">Prepayment</th>
                  <th className="p-2 font-medium">Date</th>
                  <th className="p-2 font-medium">Status</th>
                  <th className="p-2 font-medium text-right">Amount</th>
                  <th className="p-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {bill.depositApplications.map((application) => (
                  <tr key={application.id} className="border-t border-[var(--border)]">
                    <td className="p-2 font-mono text-xs">{application.depositDocumentNumber ?? 'Draft'}</td>
                    <td className="p-2 tabular-nums">{formatDate(application.applicationDate)}</td>
                    <td className="p-2">{application.status === 'POSTED' ? 'Applied' : 'Void'}</td>
                    <td className="p-2 text-right tabular-nums">{formatCents(application.amountCents)}</td>
                    <td className="p-2 text-right">
                      {application.status === 'POSTED' && (
                        <button
                          type="button"
                          onClick={() => void handleVoidApplication(application.id)}
                          disabled={busy}
                          className="px-2 py-1 rounded-md text-xs text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] cursor-pointer disabled:opacity-40"
                        >
                          Void
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {debitNotes.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold m-0">Debit notes</h3>
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
                {debitNotes.map((note) => (
                  <tr key={note.id} className="border-t border-[var(--border)]">
                    <td className="p-2 font-mono text-xs">
                      <Link to={`/debit-notes/${note.id}`}>{note.debitNoteNumber ?? 'Draft'}</Link>
                    </td>
                    <td className="p-2 tabular-nums">{formatDate(note.issueDate)}</td>
                    <td className="p-2">{note.status === 'DRAFT' ? 'Draft' : note.status === 'ISSUED' ? 'Issued' : 'Void'}</td>
                    <td className="p-2 text-right tabular-nums">{formatCents(note.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <AttachmentsPanel module="ledger-core" entityType="bill" entityId={bill.id} />

      {confirmAction === 'approve' && (
        <ConfirmDialog
          title="Approve this expense?"
          body="This posts a balanced journal entry against your payable account. A posted expense can never be edited — only voided."
          confirmLabel="Approve expense"
          tone="default"
          busy={busy}
          onConfirm={() => {
            setConfirmAction(null);
            void handleApprove();
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {creditsOffer !== null && (
        <ApplyCreditsDialog
          direction="PURCHASE"
          title="Approving posts this expense."
          documentTotalCents={bill.totalCents}
          amountDueCents={bill.amountDueCents}
          credits={creditsOffer}
          busy={busy}
          error={creditsError}
          onConfirm={(applyCredits) => void handleApproveWithCredits(applyCredits)}
          onSkip={() => {
            setCreditsOffer(null);
            setConfirmAction('approve');
          }}
          onCancel={() => setCreditsOffer(null)}
        />
      )}
      {confirmAction === 'void' && (
        <ConfirmDialog
          title="Void this expense?"
          body="This posts a reversing journal entry and marks the expense void. It cannot be undone."
          confirmLabel="Void expense"
          tone="danger"
          busy={busy}
          onConfirm={() => {
            setConfirmAction(null);
            void handleVoid();
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {showApplyPrepayment && (
        <ApplyPrepaymentDialog
          target={bill}
          onClose={() => setShowApplyPrepayment(false)}
          onApplied={() => {
            setShowApplyPrepayment(false);
            setReloadToken((n) => n + 1);
          }}
        />
      )}
      {showPaymentDialog && (
        <PaymentDialog
          direction="PAY"
          counterpartyId={bill.vendorId}
          counterpartyName={bill.vendorNameSnapshot}
          documentId={bill.id}
          amountDueCents={bill.amountDueCents}
          documentCurrencyCode={bill.currencyCode}
          documentFxRate={bill.fxRate}
          onClose={() => setShowPaymentDialog(false)}
          onRecorded={() => {
            setShowPaymentDialog(false);
            setReloadToken((t) => t + 1);
          }}
        />
      )}
      {showMakeRecurringDialog && (
        <MakeRecurringDialog
          kind="BILL"
          sourceId={bill.id}
          defaultName={`Bill from ${bill.vendorNameSnapshot}`}
          onClose={() => setShowMakeRecurringDialog(false)}
          onCreated={(scheduleId) => {
            setShowMakeRecurringDialog(false);
            navigate(`/recurring/${scheduleId}`);
          }}
        />
      )}
    </section>
  );
}

const prepaymentFieldClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

function prepaymentToday(): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Phase 42 — applies an approved prepayment bill of the same vendor to this
 * bill. The server re-checks the amount against what the prepayment has been
 * paid; the list is filtered client-side to DEPOSIT bills.
 */
function ApplyPrepaymentDialog({
  target,
  onClose,
  onApplied,
}: {
  target: Bill;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [prepayments, setPrepayments] = useState<Bill[] | null>(null);
  const [prepaymentId, setPrepaymentId] = useState('');
  const [amount, setAmount] = useState('');
  const [applicationDate, setApplicationDate] = useState(prepaymentToday);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    listBills({ vendorId: target.vendorId })
      .then((res) => {
        if (ignore) return;
        const posted = res.bills.filter((b) => b.kind === 'DEPOSIT' && b.status === 'POSTED');
        setPrepayments(posted);
        setPrepaymentId(posted[0]?.id ?? '');
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setPrepayments([]);
        setError(err instanceof Error ? err.message : 'Could not load the prepayments');
      });
    return () => {
      ignore = true;
    };
  }, [target.vendorId]);

  const cents = parseCentsInput(amount);
  const ready = prepaymentId !== '' && cents !== null && cents > 0 && applicationDate !== '';

  async function submit() {
    if (cents === null || cents <= 0 || prepaymentId === '') return;
    setBusy(true);
    setError(null);
    try {
      await applyPrepayment(target.id, { depositDocumentId: prepaymentId, amountCents: cents, applicationDate });
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply the prepayment');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Apply prepayment"
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="animate-pop-in w-full max-w-lg rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 flex flex-col gap-3 shadow-[var(--shadow-lg)]">
        <h3 className="text-base font-semibold m-0">Apply prepayment</h3>
        {prepayments === null ? (
          <p className="text-sm text-[var(--muted)] m-0">Loading prepayments…</p>
        ) : prepayments.length === 0 ? (
          <p className="text-sm text-[var(--muted)] m-0">This vendor has no approved prepayment bills.</p>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Prepayment bill</span>
              <select
                value={prepaymentId}
                onChange={(e) => setPrepaymentId(e.target.value)}
                className={prepaymentFieldClass}
              >
                {prepayments.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.vendorReference} · {formatCents(p.totalCents)} {p.currencyCode}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Amount to apply</span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={`${prepaymentFieldClass} text-right tabular-nums`}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Application date</span>
              <input
                type="date"
                value={applicationDate}
                onChange={(e) => setApplicationDate(e.target.value)}
                className={prepaymentFieldClass}
              />
            </label>
          </>
        )}
        {error !== null && <p className="status status--bad m-0">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          {prepayments !== null && prepayments.length > 0 && (
            <button
              type="button"
              className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40"
              disabled={busy || !ready}
              onClick={() => void submit()}
            >
              Apply to bill
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
