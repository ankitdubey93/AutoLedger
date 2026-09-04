import { useEffect, useState } from 'react';
import {
  createPayment,
  listAccounts,
  type Account,
  type PaymentDirection,
} from '../../services/fetchServices';
import { formatCents, parseCentsInput } from './money';
import { useLedgerSettings } from './LedgerSettingsContext';

/**
 * Records one payment against one document — opened from an invoice's or a
 * bill's detail page, never as a standalone "new payment" flow (a payment is
 * always in service of settling something).
 *
 * The amount defaults to the document's own `amountDueCents` and is capped at
 * it client-side; the server's `422` on overallocation is the backstop, not
 * the primary UX.
 */

export interface PaymentDialogProps {
  direction: PaymentDirection;
  counterpartyId: string;
  counterpartyName: string;
  documentId: string;
  amountDueCents: number;
  onClose: () => void;
  onRecorded: () => void;
}

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

export default function PaymentDialog({
  direction,
  counterpartyId,
  counterpartyName,
  documentId,
  amountDueCents,
  onClose,
  onRecorded,
}: PaymentDialogProps) {
  const ledgerSettings = useLedgerSettings();
  const [cashAccounts, setCashAccounts] = useState<Account[]>([]);
  const [cashAccountId, setCashAccountId] = useState('');
  const [paymentDate, setPaymentDate] = useState(today);
  const [amount, setAmount] = useState(formatCents(amountDueCents));
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    listAccounts()
      .then((res) => {
        if (ignore) return;
        const assets = res.accounts.filter((a) => a.isPostable && a.type === 'Asset');
        setCashAccounts(assets);
        const defaultId =
          ledgerSettings.status === 'ready' ? ledgerSettings.settings.cashAccountId : null;
        if (defaultId !== null && assets.some((a) => a.id === defaultId)) {
          setCashAccountId(defaultId);
        } else if (assets.length === 1) {
          const only = assets[0];
          if (only !== undefined) setCashAccountId(only.id);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load cash accounts');
      });
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const amountCents = parseCentsInput(amount);
  const overLimit = amountCents !== null && amountCents > amountDueCents;
  const canSave =
    !busy &&
    cashAccountId !== '' &&
    paymentDate !== '' &&
    amountCents !== null &&
    amountCents > 0 &&
    !overLimit;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (amountCents === null) return;
    setBusy(true);
    setError(null);
    try {
      await createPayment({
        direction,
        paymentDate,
        amountCents,
        cashAccountId,
        customerId: direction === 'RECEIVE' ? counterpartyId : null,
        vendorId: direction === 'PAY' ? counterpartyId : null,
        method: method.trim() === '' ? null : method.trim(),
        reference: reference.trim() === '' ? null : reference.trim(),
        notes: null,
        allocations: [
          {
            invoiceId: direction === 'RECEIVE' ? documentId : null,
            billId: direction === 'PAY' ? documentId : null,
            amountCents,
          },
        ],
        entryDate: null,
      });
      onRecorded();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not record the payment');
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-dialog-title"
        className="w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 flex flex-col gap-3 shadow-lg"
      >
        <h3 id="payment-dialog-title" className="text-base font-semibold m-0">
          {direction === 'RECEIVE' ? 'Record a receipt' : 'Record a payment'}
        </h3>
        <p className="text-sm text-[var(--muted)] m-0">
          {direction === 'RECEIVE' ? 'From' : 'To'} {counterpartyName}. Amount still due:{' '}
          {formatCents(amountDueCents)}.
        </p>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Cash / bank account</span>
          <select
            value={cashAccountId}
            onChange={(e) => setCashAccountId(e.target.value)}
            className={inputClass}
          >
            <option value="">Select an account…</option>
            {cashAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} · {account.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Date</span>
          <input
            type="date"
            value={paymentDate}
            onChange={(e) => setPaymentDate(e.target.value)}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Amount</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`${inputClass} tabular-nums`}
          />
          {overLimit && (
            <span className="text-xs text-[var(--bad)]">
              Cannot exceed the amount still due ({formatCents(amountDueCents)}).
            </span>
          )}
        </label>

        <div className="flex gap-3">
          <label className="flex flex-col gap-1 text-sm flex-1">
            <span className="text-[var(--muted)]">Method</span>
            <input
              type="text"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              maxLength={40}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm flex-1">
            <span className="text-[var(--muted)]">Reference</span>
            <input
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={100}
              className={inputClass}
            />
          </label>
        </div>

        {error !== null && <p className="status status--bad">{error}</p>}

        <div className="flex items-center justify-end gap-2 mt-1">
          <button type="button" onClick={onClose} disabled={busy} className="btn btn--ghost">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Recording…' : 'Record'}
          </button>
        </div>
      </form>
    </div>
  );
}
