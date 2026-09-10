import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listPayments, voidPayment, type Payment, type PaymentDirection } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import ConfirmDialog from '../../components/ConfirmDialog';

/**
 * The payment register — every receipt and every vendor payment, across both
 * directions. Void is gated by a confirmation dialog, matching every other
 * one-way action in LedgerCore (issue, void, approve).
 */

const PAGE_LIMIT = 50;

function directionLabel(direction: PaymentDirection): string {
  return direction === 'RECEIVE' ? 'Receipt' : 'Payment';
}

export default function PaymentsPage() {
  const [params, setParams] = useSearchParams();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmVoidId, setConfirmVoidId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const direction = (params.get('direction') ?? '') as PaymentDirection | '';
  const status = params.get('status') ?? '';
  const page = Number(params.get('page') ?? '1');

  useEffect(() => {
    let ignore = false;
    setError(null);

    const filters: Parameters<typeof listPayments>[0] = { page, limit: PAGE_LIMIT };
    if (direction !== '') filters.direction = direction;
    if (status === 'POSTED' || status === 'VOID') filters.status = status;

    listPayments(filters)
      .then((res) => {
        if (ignore) return;
        setPayments(res.payments);
        setTotalCount(res.totalCount);
        setTotalPages(res.totalPages);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load payments');
      });

    return () => {
      ignore = true;
    };
  }, [direction, status, page, reloadToken]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    next.delete('page');
    setParams(next);
  }

  function goToPage(next: number) {
    const nextParams = new URLSearchParams(params);
    if (next <= 1) nextParams.delete('page');
    else nextParams.set('page', String(next));
    setParams(nextParams);
  }

  async function handleVoid(id: string) {
    setBusy(true);
    setError(null);
    try {
      await voidPayment(id);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not void the payment');
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold m-0">Payments</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Every receipt and payment recorded against an invoice or a bill.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Direction</span>
          <select
            value={direction}
            onChange={(e) => setFilter('direction', e.target.value)}
            className={inputClass}
          >
            <option value="">Both</option>
            <option value="RECEIVE">Receipts</option>
            <option value="PAY">Payments</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Status</span>
          <select value={status} onChange={(e) => setFilter('status', e.target.value)} className={inputClass}>
            <option value="">All</option>
            <option value="POSTED">Posted</option>
            <option value="VOID">Void</option>
          </select>
        </label>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
      {!loaded && error === null && <p className="muted">Loading…</p>}

      {loaded && (
        <>
          {totalCount === 0 ? (
            <p className="muted">No payments recorded yet.</p>
          ) : (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[42rem]">
                <thead>
                  <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                    <th className="p-3 font-medium">Date</th>
                    <th className="p-3 font-medium">Type</th>
                    <th className="p-3 font-medium">Counterparty</th>
                    <th className="p-3 font-medium">Status</th>
                    <th className="p-3 font-medium text-right">Amount</th>
                    <th className="p-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((payment) => (
                    <tr key={payment.id} className="border-t border-[var(--border)]">
                      <td className="p-3 tabular-nums whitespace-nowrap">{payment.paymentDate}</td>
                      <td className="p-3">{directionLabel(payment.direction)}</td>
                      <td className="p-3">{payment.counterpartyName}</td>
                      <td className="p-3">
                        {payment.status === 'VOID' ? (
                          <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20">
                            Void
                          </span>
                        ) : (
                          <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                            Posted
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-right tabular-nums">{formatCents(payment.amountCents)}</td>
                      <td className="p-3 text-right">
                        {payment.status === 'POSTED' && (
                          <button
                            type="button"
                            onClick={() => setConfirmVoidId(payment.id)}
                            disabled={busy}
                            className="btn btn--ghost"
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
          )}

          {totalCount > 0 && (
            <div className="flex items-center justify-between gap-4 text-sm text-[var(--muted)]">
              <span>
                Showing {payments.length} of {totalCount}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={page >= totalPages}
                  onClick={() => goToPage(page + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {confirmVoidId !== null && (
        <ConfirmDialog
          title="Void this payment?"
          body="This posts a reversing journal entry and un-settles the document it paid. It cannot be undone."
          confirmLabel="Void payment"
          tone="danger"
          busy={busy}
          onConfirm={() => {
            const id = confirmVoidId;
            setConfirmVoidId(null);
            void handleVoid(id);
          }}
          onCancel={() => setConfirmVoidId(null)}
        />
      )}
    </section>
  );
}
