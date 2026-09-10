import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiRequestError,
  approveBill,
  getBill,
  listPayments,
  submitBill,
  voidBill,
  type Bill,
  type Payment,
} from '../../services/fetchServices';
import { formatCents, formatQuantity, formatRate } from './money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import { useAuth } from '../../context/AuthContext';
import { useLedgerSettings } from './LedgerSettingsContext';
import BackLink from './BackLink';
import ConfirmDialog from './ConfirmDialog';
import PaymentDialog from './PaymentDialog';

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
  const base = useAppBasePath();
  const auth = useAuth();
  const role = auth.status === 'authenticated' ? auth.role : null;
  const ledgerSettings = useLedgerSettings();

  const [bill, setBill] = useState<Bill | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'approve' | 'void' | null>(null);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (billId === undefined) return;
    let ignore = false;
    setError(null);

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
          setError(err instanceof Error ? err.message : 'Could not load the bill');
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
      setError(err instanceof Error ? err.message : 'Could not submit the bill');
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
      setError(err instanceof Error ? err.message : 'Could not approve the bill');
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
      setError(err instanceof Error ? err.message : 'Could not void the bill');
    } finally {
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to={`${base}/bills`} label="Back to bills" />
        <p className="status status--bad">Bill not found.</p>
      </section>
    );
  }

  if (bill === null) {
    return (
      <div className="shell" aria-busy="true">
        <div className="skeleton skeleton--title" />
        <span className="visually-hidden">Loading bill…</span>
      </div>
    );
  }

  const canApprove = role === 'OWNER' || role === 'ADMIN';

  return (
    <section className="flex flex-col gap-6">
      <BackLink to={`${base}/bills`} label="Back to bills" />

      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">{bill.vendorReference}</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">{statusLabel(bill.status)}</p>
        </div>
        <div className="flex items-center gap-2">
          {(bill.status === 'DRAFT' || bill.status === 'AWAITING_APPROVAL') && (
            <Link
              to={`${base}/bills/${bill.id}/edit`}
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
          {bill.status === 'AWAITING_APPROVAL' && canApprove && (
            <button
              type="button"
              onClick={() => setConfirmAction('approve')}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40"
            >
              Approve
            </button>
          )}
          {bill.status === 'POSTED' && bill.amountDueCents > 0 && (
            <button
              type="button"
              onClick={() => setShowPaymentDialog(true)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40"
            >
              Record payment
            </button>
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
            <p className="text-sm text-[var(--muted)] m-0">Bill date {bill.billDate}</p>
            <p className="text-sm text-[var(--muted)] m-0">Due {bill.dueDate}</p>
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
                      to={`${base}/accounts/${line.expenseAccountId}`}
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

        <div className="flex flex-col items-end gap-1 max-w-xs self-end text-sm">
          <div className="flex justify-between w-full">
            <span className="text-[var(--muted)]">Subtotal</span>
            <span className="tabular-nums">{formatCents(bill.subtotalCents)}</span>
          </div>
          <div className="flex justify-between w-full">
            <span className="text-[var(--muted)]">Tax</span>
            <span className="tabular-nums">{formatCents(bill.taxCents)}</span>
          </div>
          <div className="flex justify-between w-full font-semibold border-t border-[var(--border)] pt-1">
            <span>Total</span>
            <span className="tabular-nums">{formatCents(bill.totalCents)} {bill.currencyCode}</span>
          </div>
          {ledgerSettings.status === 'ready' && bill.currencyCode !== ledgerSettings.settings.baseCurrency && (
            <div className="flex justify-between w-full text-[var(--muted)]">
              <span>≈ {ledgerSettings.settings.baseCurrency} (at {bill.fxRate})</span>
              <span className="tabular-nums">{formatCents(bill.baseTotalCents)}</span>
            </div>
          )}
          {bill.status === 'POSTED' && (
            <>
              <div className="flex justify-between w-full">
                <span className="text-[var(--muted)]">Paid</span>
                <span className="tabular-nums">{formatCents(bill.allocatedCents)}</span>
              </div>
              <div className="flex justify-between w-full font-semibold">
                <span>Amount due</span>
                <span className="tabular-nums">{formatCents(bill.amountDueCents)}</span>
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
              <Link to={`${base}/journals/${bill.journalEntryId}`}>{bill.journalEntryId.slice(0, 8)}</Link>
            </dd>
          </div>
        )}
        {bill.voidJournalEntryId !== null && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Void entry</dt>
            <dd className="m-0">
              <Link to={`${base}/journals/${bill.voidJournalEntryId}`}>
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
                    <td className="p-2 tabular-nums">{payment.paymentDate}</td>
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

      {confirmAction === 'approve' && (
        <ConfirmDialog
          title="Approve this bill?"
          body="This posts a balanced journal entry against your payable account. A posted bill can never be edited — only voided."
          confirmLabel="Approve bill"
          tone="default"
          busy={busy}
          onConfirm={() => {
            setConfirmAction(null);
            void handleApprove();
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === 'void' && (
        <ConfirmDialog
          title="Void this bill?"
          body="This posts a reversing journal entry and marks the bill void. It cannot be undone."
          confirmLabel="Void bill"
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
    </section>
  );
}
