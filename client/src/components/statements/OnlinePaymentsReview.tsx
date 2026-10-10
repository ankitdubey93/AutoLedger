import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listOnlinePayments, type OnlinePayment } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { formatDate } from '../../utils/date';

/**
 * Card payments taken from statement links that could not be applied as the
 * customer chose (Phase 39c) — the money arrived at Stripe, so a person must
 * record it by hand. Renders nothing when there are none.
 */
export default function OnlinePaymentsReview() {
  const [rows, setRows] = useState<OnlinePayment[]>([]);

  useEffect(() => {
    let ignore = false;
    listOnlinePayments('NEEDS_REVIEW')
      .then((list) => {
        if (!ignore) setRows(list);
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, []);

  if (rows.length === 0) return null;

  return (
    <div className="rounded-lg border border-[var(--bad)] bg-[var(--bad-soft)] p-3 flex flex-col gap-2 text-sm" role="region" aria-label="Online payments to review">
      <p className="m-0 font-semibold">
        {rows.length} online payment{rows.length === 1 ? '' : 's'} received but not applied
      </p>
      <p className="m-0 text-[var(--muted)]">
        The customer was charged, but the payment could not be recorded against the invoices they chose. Record it
        manually against the right invoice (reference shown), or refund it in Stripe.
      </p>
      <ul className="m-0 pl-5">
        {rows.map((p) => (
          <li key={p.id}>
            {formatDate(p.createdAt.slice(0, 10))} · <Link to={`/customers/${p.customerId}`}>{p.customerName}</Link> ·{' '}
            {formatCents(p.amountCents)} {p.currencyCode} · {p.invoices.map((i) => i.invoiceNumber ?? '—').join(', ')} ·
            ref <code>{p.providerIntentId ?? '—'}</code>
            {p.failureReason !== null && <span className="text-[var(--muted)]"> — {p.failureReason}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
