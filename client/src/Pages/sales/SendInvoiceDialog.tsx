import { useEffect, useState, type FormEvent } from 'react';
import { listCustomers, sendInvoice, type Invoice } from '../../services/fetchServices';
import { inputClass, primaryButtonClass } from '../../components/ui/formClasses';

/**
 * Emails an issued invoice with its PDF and a link (Phase 48). The address is
 * prefilled from the customer's email on file; leaving it blank makes the
 * server use that address itself, and a customer with none is a server
 * error shown inline.
 */

export interface SendInvoiceDialogProps {
  invoice: Invoice;
  onClose: () => void;
  onSent: () => void;
}

export default function SendInvoiceDialog({ invoice, onClose, onSent }: SendInvoiceDialogProps) {
  const [toEmail, setToEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    listCustomers({ q: invoice.customerNameSnapshot, includeInactive: true })
      .then((res) => {
        if (ignore) return;
        const email = res.customers.find((c) => c.id === invoice.customerId)?.email ?? null;
        if (email !== null) setToEmail((current) => (current === '' ? email : current));
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, [invoice.customerId, invoice.customerNameSnapshot]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendInvoice(invoice.id, {
        toEmail: toEmail.trim() === '' ? null : toEmail.trim(),
        message: message.trim() === '' ? null : message.trim(),
      });
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the invoice');
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Email invoice"
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="animate-pop-in w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 flex flex-col gap-3 shadow-[var(--shadow-lg)]"
      >
        <h3 className="text-base font-semibold m-0">Email invoice {invoice.invoiceNumber ?? ''}</h3>
        <p className="text-sm text-[var(--muted)] m-0">
          The customer gets the invoice as a PDF and a link to view it, and to pay online if card payments are enabled.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">To</span>
          <input type="email" value={toEmail} onChange={(e) => setToEmail(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Message (optional)</span>
          <textarea
            value={message}
            maxLength={2000}
            rows={4}
            onChange={(e) => setMessage(e.target.value)}
            className={inputClass}
          />
        </label>
        {error !== null && <p className="status status--bad m-0">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={primaryButtonClass} disabled={busy}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
