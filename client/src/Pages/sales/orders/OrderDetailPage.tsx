import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiRequestError,
  cancelOrder,
  closeOrder,
  confirmOrder,
  convertOrder,
  createOrderDeposit,
  deleteOrder,
  getOrder,
  reopenOrder,
  type DepositInput,
  type Order,
  type OrderConvertBody,
} from '../../../services/fetchServices';
import { formatCents, formatQuantity, parseCentsInput, parseQuantityInput, parseRateInput } from '../../../utils/money';
import { formatDate } from '../../../utils/date';
import { useCan } from '../../../context/AuthContext';
import { useOrg } from '../../../context/OrgContext';
import BackLink from '../../../components/BackLink';
import ConfirmDialog from '../../../components/ConfirmDialog';
import LoadingState from '../../../components/ui/LoadingState';
import { OrderStatusPill, orderBillingLabel, orderLabel } from './OrderListPage';
import type { OrderKindConfig } from './orderKinds';

/**
 * One order (Phase 42). Which actions show is decided by the order's status
 * and the member's permissions; the server re-checks both. Nothing on this
 * page posts to the ledger — invoicing or billing creates a *draft* invoice
 * or expense, which posts only when it is issued or approved from its own
 * page.
 */

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';
const primaryClass =
  'px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40';
const secondaryClass =
  'px-3 py-1.5 rounded-md text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] cursor-pointer disabled:opacity-40 no-underline';

function today(): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError || err instanceof Error ? err.message : fallback;
}

function Modal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="animate-pop-in w-full max-w-lg rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 flex flex-col gap-3 shadow-[var(--shadow-lg)]">
        <h3 className="text-base font-semibold m-0">{title}</h3>
        {children}
      </div>
    </div>
  );
}

type DialogKind = 'cancel' | 'convert' | 'deposit' | 'confirm' | 'delete' | null;

export default function OrderDetailPage({ config }: { config: OrderKindConfig }) {
  const { orderId = '' } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const can = useCan();
  const { organization } = useOrg();

  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // Dialog fields.
  const [reason, setReason] = useState('');
  const [documentDate, setDocumentDate] = useState(today);
  const [dueDate, setDueDate] = useState('');
  const [vendorReference, setVendorReference] = useState('');
  /** Phase 42 — the deposit dialog: a percentage or an amount of the order total. */
  const [depositBasis, setDepositBasis] = useState<'PERCENT' | 'AMOUNT'>('PERCENT');
  const [depositValue, setDepositValue] = useState('');
  /** Quantity to bill per order line id, as typed; the default is what remains. */
  const [billQuantities, setBillQuantities] = useState<Record<string, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setNotFound(false);
    getOrder(config.direction, orderId, controller.signal)
      .then((res) => setOrder(res.order))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiRequestError && err.status === 404) setNotFound(true);
        else setError(messageOf(err, 'Could not load the order'));
      });
    return () => controller.abort();
  }, [config, orderId]);

  function open(kind: Exclude<DialogKind, null>) {
    if (order === null) return;
    setDialogError(null);
    setReason('');
    if (kind === 'deposit') {
      setDocumentDate(today());
      setDueDate('');
      setVendorReference('');
      setDepositBasis('PERCENT');
      setDepositValue('');
    }
    if (kind === 'convert') {
      setDocumentDate(today());
      setDueDate('');
      setVendorReference('');
      setBillQuantities(
        Object.fromEntries(order.lines.map((l) => [l.id, formatQuantity(l.remainingQuantityMilli)])),
      );
    }
    setDialog(kind);
  }

  async function run(action: () => Promise<Order | null>, fallback: string) {
    setBusy(true);
    setDialogError(null);
    try {
      const next = await action();
      if (next !== null) setOrder(next);
      setDialog(null);
    } catch (err: unknown) {
      setDialogError(messageOf(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to={`/${config.path}`} label={`Back to ${config.plural.toLowerCase()}`} />
        <p className="status status--bad">Order not found.</p>
      </section>
    );
  }
  if (order === null) {
    return error !== null ? (
      <section className="flex flex-col gap-3">
        <BackLink to={`/${config.path}`} label={`Back to ${config.plural.toLowerCase()}`} />
        <p className="status status--bad">{error}</p>
      </section>
    ) : (
      <LoadingState />
    );
  }

  const canEdit = can(config.permissions.edit);
  const canConvert = can(config.permissions.convert);
  const purchase = config.direction === 'PURCHASE';
  const baseCurrency = organization?.baseCurrency ?? '';

  /** The quantities the convert dialog will send: lines typed above zero only. */
  const billLines = order.lines.flatMap((l) => {
    const typed = billQuantities[l.id] ?? '';
    const quantityMilli = typed.trim() === '' ? 0 : parseQuantityInput(typed);
    if (quantityMilli === null || quantityMilli <= 0) return [];
    return [{ orderLineId: l.id, quantityMilli }];
  });
  const billTooMuch = order.lines.some((l) => {
    const quantityMilli = parseQuantityInput(billQuantities[l.id] ?? '');
    return quantityMilli !== null && quantityMilli > l.remainingQuantityMilli;
  });
  /** Phase 42 — the deposit the dialog will send: basis points or cents, whichever the basis chose. */
  const depositPercentBp = depositBasis === 'PERCENT' ? parseRateInput(depositValue) : null;
  const depositAmountCents = depositBasis === 'AMOUNT' ? parseCentsInput(depositValue) : null;
  const depositReady =
    depositBasis === 'PERCENT'
      ? depositPercentBp !== null && depositPercentBp > 0
      : depositAmountCents !== null && depositAmountCents > 0;

  return (
    <section className="flex flex-col gap-6">
      <BackLink to={`/${config.path}`} label={`Back to ${config.plural.toLowerCase()}`} />

      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0 flex items-center gap-2">
            {orderLabel(order)} <OrderStatusPill status={order.status} />
          </h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            {order.partyName} · {formatCents(order.totalCents)} {order.currencyCode} · ordered {formatDate(order.orderDate)}
            {order.expectedDate !== null ? ` · expected ${formatDate(order.expectedDate)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {order.status === 'DRAFT' && canEdit && (
            <Link to={`/${config.path}/${order.id}/edit`} className={secondaryClass}>
              Edit
            </Link>
          )}
          {order.status === 'DRAFT' && canEdit && (
            <button type="button" className={primaryClass} onClick={() => open('confirm')}>
              Confirm
            </button>
          )}
          {order.status === 'CONFIRMED' && canConvert && order.currencyCode === baseCurrency && (
            <button type="button" className={secondaryClass} onClick={() => open('deposit')}>
              {purchase ? 'Record prepayment' : 'Request deposit'}
            </button>
          )}
          {order.status === 'CONFIRMED' && canConvert && (
            <button type="button" className={primaryClass} onClick={() => open('convert')}>
              Create {config.billNoun}
            </button>
          )}
          {order.status === 'CONFIRMED' && canEdit && (
            <button
              type="button"
              className={secondaryClass}
              disabled={busy}
              onClick={() =>
                void run(async () => (await closeOrder(config.direction, order.id)).order, 'Could not close the order')
              }
            >
              Close
            </button>
          )}
          {order.status === 'CLOSED' && canEdit && (
            <button
              type="button"
              className={secondaryClass}
              disabled={busy}
              onClick={() =>
                void run(async () => (await reopenOrder(config.direction, order.id)).order, 'Could not reopen the order')
              }
            >
              Reopen
            </button>
          )}
          {order.status === 'CONFIRMED' && canEdit && (
            <button type="button" className={secondaryClass} onClick={() => open('cancel')}>
              Cancel order
            </button>
          )}
          {order.status === 'DRAFT' && canEdit && (
            <button type="button" className={secondaryClass} onClick={() => open('delete')}>
              Delete
            </button>
          )}
        </div>
      </header>

      {order.status === 'CANCELLED' && (
        <p className="status status--bad m-0">Cancelled — {order.cancelReason}</p>
      )}
      {order.sourceQuote !== null && (
        <p className="text-sm text-[var(--muted)] m-0">
          From quote{' '}
          <Link to={`/${purchase ? 'purchase-quotes' : 'quotes'}/${order.sourceQuote.id}`}>
            {order.sourceQuote.quoteNumber}
          </Link>
          {order.sourceQuote.revision > 1 ? ` rev ${String(order.sourceQuote.revision)}` : ''}.
        </p>
      )}
      {order.status === 'CONFIRMED' && (
        <p className="text-sm text-[var(--muted)] m-0">Billing: {orderBillingLabel(order.billingStatus)}.</p>
      )}

      {dialogError !== null && dialog === null && <p className="status status--bad">{dialogError}</p>}

      <section className="flex flex-col gap-2" aria-label="Lines">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[48rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Description</th>
                <th className="p-3 font-medium text-right">Ordered</th>
                <th className="p-3 font-medium text-right">Billed</th>
                <th className="p-3 font-medium text-right">Remaining</th>
                <th className="p-3 font-medium text-right">Unit price</th>
                <th className="p-3 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.id} className="border-t border-[var(--border)]">
                  <td className="p-3">{line.description}</td>
                  <td className="p-3 text-right tabular-nums">{formatQuantity(line.quantityMilli)}</td>
                  <td className="p-3 text-right tabular-nums">{formatQuantity(line.billedQuantityMilli)}</td>
                  <td className="p-3 text-right tabular-nums">{formatQuantity(line.remainingQuantityMilli)}</td>
                  <td className="p-3 text-right tabular-nums">{formatCents(line.unitPriceCents)}</td>
                  <td className="p-3 text-right tabular-nums">{formatCents(line.netCents + line.taxCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-[var(--muted)] m-0">
          Subtotal {formatCents(order.subtotalCents)} · Tax {formatCents(order.taxCents)} · Total{' '}
          {formatCents(order.totalCents)} {order.currencyCode}
        </p>
      </section>

      {order.documents.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="Documents">
          <h3 className="text-base font-semibold m-0">Documents</h3>
          <ul className="m-0 pl-5 text-sm flex flex-col gap-1">
            {order.documents.map((doc) => (
              <li key={doc.id}>
                <Link to={`/${doc.kind === 'INVOICE' ? 'invoices' : 'expenses'}/${doc.id}`}>
                  {doc.kind === 'INVOICE' ? 'Invoice' : 'Expense'} {doc.number ?? 'draft'}
                </Link>{' '}
                — {doc.status.toLowerCase()} · {formatCents(doc.totalCents)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {dialog === 'confirm' && (
        <ConfirmDialog
          title={`Confirm ${config.title.toLowerCase()}?`}
          body="Confirming allocates the order number and freezes the lines. Invoices and expenses can then be raised against it."
          confirmLabel="Confirm order"
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() =>
            void run(async () => (await confirmOrder(config.direction, order.id)).order, 'Could not confirm the order')
          }
        />
      )}

      {dialog === 'delete' && (
        <ConfirmDialog
          title="Delete draft order?"
          body="The draft is removed. No number has been allocated, so nothing is skipped in the sequence."
          confirmLabel="Delete draft"
          tone="danger"
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() =>
            void run(async () => {
              await deleteOrder(config.direction, order.id);
              void navigate(`/${config.path}`);
              return null;
            }, 'Could not delete the order')
          }
        />
      )}

      {dialog === 'cancel' && (
        <Modal title="Cancel order">
          <p className="text-sm text-[var(--muted)] m-0">
            Withdraws the order. It is refused while a live {config.billNoun} is raised against it — void that first. A
            cancelled order does not revert its quote.
          </p>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Reason</span>
            <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className={inputClass} />
          </label>
          {dialogError !== null && <p className="status status--bad m-0">{dialogError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn--ghost" onClick={() => setDialog(null)}>
              Keep order
            </button>
            <button
              type="button"
              className={primaryClass}
              disabled={busy || reason.trim() === ''}
              onClick={() =>
                void run(
                  async () => (await cancelOrder(config.direction, order.id, reason.trim())).order,
                  'Could not cancel the order',
                )
              }
            >
              Cancel order
            </button>
          </div>
        </Modal>
      )}

      {dialog === 'convert' && (
        <Modal title={`Create ${config.billNoun}`}>
          <p className="text-sm text-[var(--muted)] m-0">
            Creates a draft {config.billNoun} with the quantities below. Set a line to 0 to leave it out. Nothing is posted
            until you {purchase ? 'approve the expense' : 'issue the invoice'}.
          </p>
          <div className="flex flex-col gap-2">
            {order.lines.map((line, index) => (
              <label key={line.id} className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-3 text-sm">
                <span>
                  {line.description}{' '}
                  <span className="text-[var(--muted)] text-xs">({formatQuantity(line.remainingQuantityMilli)} left)</span>
                </span>
                <input
                  inputMode="decimal"
                  aria-label={`Quantity to bill for line ${String(index + 1)}`}
                  value={billQuantities[line.id] ?? ''}
                  onChange={(e) => setBillQuantities((current) => ({ ...current, [line.id]: e.target.value }))}
                  className={`${inputClass} text-right tabular-nums`}
                />
              </label>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">{purchase ? 'Expense date' : 'Invoice date'}</span>
            <input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Due date (blank uses the payment terms)</span>
            <input type="date" value={dueDate} min={documentDate} onChange={(e) => setDueDate(e.target.value)} className={inputClass} />
          </label>
          {purchase && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Vendor’s invoice no. (blank uses the order number)</span>
              <input
                value={vendorReference}
                maxLength={100}
                onChange={(e) => setVendorReference(e.target.value)}
                className={inputClass}
              />
            </label>
          )}
          {billTooMuch && <p className="status status--bad m-0">A quantity is more than what remains on its line.</p>}
          {dialogError !== null && <p className="status status--bad m-0">{dialogError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn--ghost" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryClass}
              disabled={busy || documentDate === '' || billLines.length === 0 || billTooMuch}
              onClick={() =>
                void run(async () => {
                  const body: OrderConvertBody = {
                    documentDate,
                    dueDate: dueDate === '' ? null : dueDate,
                    vendorReference: purchase && vendorReference.trim() !== '' ? vendorReference.trim() : null,
                    lines: billLines,
                  };
                  const { document } = await convertOrder(config.direction, order.id, body);
                  void navigate(`/${config.billPath}/${document.id}`);
                  return null;
                }, `Could not create the ${config.billNoun}`)
              }
            >
              Create draft {config.billNoun}
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'deposit' && (
        <Modal title={purchase ? 'Record prepayment' : 'Request deposit'}>
          <p className="text-sm text-[var(--muted)] m-0">
            {purchase
              ? 'Creates a draft prepayment bill for this order. Nothing is posted until you approve it, and it is applied to the final bill later.'
              : 'Creates a draft deposit invoice for this order. Nothing is posted until you issue it, and it is applied to the final invoice later.'}
          </p>
          <fieldset className="flex items-center gap-4 text-sm border-0 p-0 m-0">
            <legend className="sr-only">Deposit basis</legend>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="deposit-basis"
                checked={depositBasis === 'PERCENT'}
                onChange={() => setDepositBasis('PERCENT')}
              />
              Percentage
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="deposit-basis"
                checked={depositBasis === 'AMOUNT'}
                onChange={() => setDepositBasis('AMOUNT')}
              />
              Amount
            </label>
          </fieldset>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">
              {depositBasis === 'PERCENT' ? 'Percentage of the order total' : `Amount in ${baseCurrency}`}
            </span>
            <input
              inputMode="decimal"
              value={depositValue}
              onChange={(e) => setDepositValue(e.target.value)}
              className={`${inputClass} text-right tabular-nums`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">{purchase ? 'Prepayment date' : 'Invoice date'}</span>
            <input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Due date (blank uses the payment terms)</span>
            <input type="date" value={dueDate} min={documentDate} onChange={(e) => setDueDate(e.target.value)} className={inputClass} />
          </label>
          {purchase && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Vendor’s invoice no. (blank uses the deposit number)</span>
              <input
                value={vendorReference}
                maxLength={100}
                onChange={(e) => setVendorReference(e.target.value)}
                className={inputClass}
              />
            </label>
          )}
          {dialogError !== null && <p className="status status--bad m-0">{dialogError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn--ghost" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryClass}
              disabled={busy || !depositReady || documentDate === ''}
              onClick={() =>
                void run(async () => {
                  const body: DepositInput = {
                    percentBp: depositBasis === 'PERCENT' ? depositPercentBp : null,
                    amountCents: depositBasis === 'AMOUNT' ? depositAmountCents : null,
                    documentDate,
                    dueDate: dueDate === '' ? null : dueDate,
                    vendorReference: purchase && vendorReference.trim() !== '' ? vendorReference.trim() : null,
                  };
                  const { document } = await createOrderDeposit(config.direction, order.id, body);
                  void navigate(`/${config.billPath}/${document.id}`);
                  return null;
                }, purchase ? 'Could not record the prepayment' : 'Could not request the deposit')
              }
            >
              {purchase ? 'Create draft prepayment bill' : 'Create draft deposit invoice'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
