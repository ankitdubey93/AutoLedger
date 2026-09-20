import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import {
  ApiRequestError,
  createInvoice,
  getInvoice,
  getInvoiceSettings,
  getLatestFxRate,
  listAccounts,
  listCustomers,
  listItems,
  listPaymentTerms,
  updateInvoice,
  type Account,
  type Customer,
  type Item,
  type InvoiceSettings,
  type PaymentTerm,
  type ResolvedRate,
} from '../../services/fetchServices';
import {
  formatCents,
  formatQuantity,
  formatRate,
  parseCentsInput,
  parseQuantityInput,
  parseRateInput,
} from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import { useLedgerSettings } from './LedgerSettingsContext';
import BackLink from '../../components/BackLink';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'SGD', 'AED', 'CHF', 'NZD', 'ZAR'] as const;

/**
 * Draft an invoice, or edit one — the same page, told apart by whether the
 * `:invoiceId` route param is present. An issued invoice can never be edited
 * (guardrails rule 6), so editing it here refuses with a BackLink instead of
 * silently loading stale data into a form that would post a lie.
 *
 * The totals shown here are a preview only, computed with the same formulas
 * `invoiceService.computeLineTotals` uses server-side; the server's numbers
 * are the ones that are actually saved.
 *
 * Phase 24 — the due date is derived from a chosen payment term rather than
 * typed by hand, but stays overridable: `dueDateTouched` is set the moment
 * the user edits the due date directly, and from then on the term-derived
 * effect leaves it alone. Picking a catalogue item on a line copies its
 * defaults into that line's fields once; the line never reads through to
 * the item afterward, and every copied field stays editable.
 */

interface DraftLine {
  description: string;
  quantity: string;
  unitPrice: string;
  revenueAccountId: string;
  taxRate: string;
  itemId: string;
}

function emptyLine(defaults: { revenueAccountId: string; taxRate: string }): DraftLine {
  return {
    description: '',
    quantity: '',
    unitPrice: '',
    revenueAccountId: defaults.revenueAccountId,
    taxRate: defaults.taxRate,
    itemId: '',
  };
}

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 2026, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** unitPriceCents * quantityMilli / 1000, rounded half up — a preview, never what is saved. */
function previewNetCents(unitPriceCents: number, quantityMilli: number): number {
  return Math.round((unitPriceCents * quantityMilli) / 1000);
}

/** netCents * taxRateBp / 10000, rounded half up. */
function previewTaxCents(netCents: number, taxRateBp: number): number {
  return Math.round((netCents * taxRateBp) / 10000);
}

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

export default function NewInvoicePage() {
  const base = useAppBasePath();
  const navigate = useNavigate();
  const { invoiceId } = useParams<{ invoiceId?: string }>();
  const ledgerSettings = useLedgerSettings();
  const baseCurrency = ledgerSettings.status === 'ready' ? ledgerSettings.settings.baseCurrency : 'USD';

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [revenueAccounts, setRevenueAccounts] = useState<Account[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerm[]>([]);
  const [settings, setSettings] = useState<InvoiceSettings | null>(null);

  const [customerId, setCustomerId] = useState('');
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState('');
  const [dueDateTouched, setDueDateTouched] = useState(false);
  const [paymentTermsCode, setPaymentTermsCode] = useState('');
  const [currencyCode, setCurrencyCode] = useState(baseCurrency);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);

  const [resolvedRate, setResolvedRate] = useState<ResolvedRate | null>(null);
  const [rateError, setRateError] = useState<string | null>(null);
  const [rateLoading, setRateLoading] = useState(false);

  const [seeded, setSeeded] = useState(false);
  const [notEditable, setNotEditable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false;

    Promise.all([
      listCustomers({ includeInactive: false }),
      listAccounts(),
      listItems({ includeInactive: false }),
      listPaymentTerms(),
      getInvoiceSettings(),
    ])
      .then(([customersRes, accountsRes, itemsRes, paymentTermsRes, settingsRes]) => {
        if (ignore) return;
        setCustomers(customersRes.customers);
        setRevenueAccounts(
          accountsRes.accounts.filter((a) => a.isPostable && a.type === 'Revenue'),
        );
        setItems(itemsRes.items);
        setPaymentTerms(paymentTermsRes.paymentTerms);
        setSettings(settingsRes);

        if (invoiceId === undefined) {
          setDueDate(addDays(today(), settingsRes.defaultDueDays));
          const matchingTerm = paymentTermsRes.paymentTerms.find(
            (t) => t.netDays === settingsRes.defaultDueDays,
          );
          setPaymentTermsCode(matchingTerm?.code ?? '');
          setLines([
            emptyLine({
              revenueAccountId: settingsRes.defaultRevenueAccountId ?? '',
              taxRate: settingsRes.defaultTaxRateBp === 0 ? '' : formatRate(settingsRes.defaultTaxRateBp),
            }),
          ]);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load invoice data');
      });

    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (invoiceId === undefined || seeded) return;
    let ignore = false;

    getInvoice(invoiceId)
      .then((res) => {
        if (ignore) return;
        const invoice = res.invoice;
        if (invoice.status !== 'DRAFT') {
          setNotEditable(true);
          setSeeded(true);
          return;
        }
        setCustomerId(invoice.customerId);
        setIssueDate(invoice.issueDate);
        setDueDate(invoice.dueDate);
        setDueDateTouched(true);
        setPaymentTermsCode(invoice.paymentTermsCode ?? '');
        setCurrencyCode(invoice.currencyCode);
        setNotes(invoice.notes ?? '');
        setLines(
          invoice.lines.map((line) => ({
            description: line.description,
            quantity: formatQuantity(line.quantityMilli),
            unitPrice: formatCents(line.unitPriceCents),
            revenueAccountId: line.revenueAccountId,
            taxRate: line.taxRateBp === 0 ? '' : formatRate(line.taxRateBp),
            itemId: line.itemId ?? '',
          })),
        );
        setSeeded(true);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setError(err instanceof Error ? err.message : 'Could not load the invoice');
        setSeeded(true);
      });

    return () => {
      ignore = true;
    };
  }, [invoiceId, seeded]);

  // Recomputes the due date whenever the term or the issue date changes,
  // unless the user has edited the due date directly — an explicit edit
  // always wins, matching the server's own resolution order.
  useEffect(() => {
    if (paymentTermsCode === '' || dueDateTouched || issueDate === '') return;
    const term = paymentTerms.find((t) => t.code === paymentTermsCode);
    if (term === undefined) return;
    setDueDate(addDays(issueDate, term.netDays));
  }, [paymentTermsCode, issueDate, dueDateTouched, paymentTerms]);

  const totals = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    let malformed = false;

    for (const line of lines) {
      const quantityMilli = parseQuantityInput(line.quantity);
      const unitPriceCents = parseCentsInput(line.unitPrice);
      const taxRateBp = line.taxRate.trim() === '' ? 0 : parseRateInput(line.taxRate);

      if (quantityMilli === null || unitPriceCents === null || taxRateBp === null) {
        malformed = true;
        continue;
      }
      const netCents = previewNetCents(unitPriceCents, quantityMilli);
      const taxCents = previewTaxCents(netCents, taxRateBp);
      subtotal += netCents;
      tax += taxCents;
    }

    return { subtotal, tax, total: subtotal + tax, malformed };
  }, [lines]);

  // Resolves the display-only rate/base-total preview whenever a foreign
  // currency is selected — the server resolves and freezes its own rate on
  // save/issue independently, so a stale preview here can never corrupt what
  // is actually posted.
  useEffect(() => {
    if (currencyCode === baseCurrency || issueDate === '') {
      setResolvedRate(null);
      setRateError(null);
      return;
    }
    let ignore = false;
    setRateLoading(true);
    setRateError(null);
    getLatestFxRate(currencyCode, issueDate)
      .then((res) => {
        if (!ignore) setResolvedRate(res.rate);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setResolvedRate(null);
        setRateError(
          err instanceof ApiRequestError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Could not resolve an exchange rate',
        );
      })
      .finally(() => {
        if (!ignore) setRateLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [currencyCode, baseCurrency, issueDate]);

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  /**
   * Picking an item COPIES its defaults into the line once — description,
   * unit price, revenue account, tax rate — and every field stays editable
   * afterward. The line never reads through to the item again.
   */
  function applyItem(index: number, itemId: string) {
    if (itemId === '') {
      updateLine(index, { itemId: '' });
      return;
    }
    const item = items.find((i) => i.id === itemId);
    if (item === undefined) {
      updateLine(index, { itemId });
      return;
    }
    updateLine(index, {
      itemId,
      description: item.name,
      unitPrice: formatCents(item.salePriceCents ?? 0),
      revenueAccountId: item.revenueAccountId ?? '',
      taxRate: item.saleTaxRateBp === 0 ? '' : formatRate(item.saleTaxRateBp),
    });
  }

  const complete =
    customerId !== '' &&
    issueDate !== '' &&
    dueDate !== '' &&
    lines.length > 0 &&
    lines.every(
      (line) =>
        line.description.trim() !== '' &&
        line.revenueAccountId !== '' &&
        parseQuantityInput(line.quantity) !== null &&
        parseQuantityInput(line.quantity) !== 0 &&
        line.unitPrice.trim() !== '',
    );

  const canSave =
    complete && !totals.malformed && !busy && (currencyCode === baseCurrency || (resolvedRate !== null && !rateLoading));

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const body = {
        customerId,
        issueDate,
        dueDate,
        currencyCode,
        notes: notes.trim() === '' ? null : notes.trim(),
        paymentTerms: null,
        paymentTermsCode: paymentTermsCode === '' ? null : paymentTermsCode,
        lines: lines.map((line) => ({
          description: line.description.trim(),
          quantityMilli: parseQuantityInput(line.quantity) ?? 0,
          unitPriceCents: parseCentsInput(line.unitPrice) ?? 0,
          revenueAccountId: line.revenueAccountId,
          taxRateBp: line.taxRate.trim() === '' ? 0 : (parseRateInput(line.taxRate) ?? 0),
          itemId: line.itemId === '' ? null : line.itemId,
        })),
      };

      const { invoice } =
        invoiceId === undefined ? await createInvoice(body) : await updateInvoice(invoiceId, body);

      navigate(`${base}/invoices/${invoice.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the draft');
      setBusy(false);
    }
  }

  if (notEditable) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to={`${base}/invoices`} label="Back to invoices" />
        <p className="status status--bad">Only a draft invoice can be edited.</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <BackLink to={`${base}/invoices`} label="Back to invoices" />

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
        <header>
          <h2 className="text-lg font-semibold m-0">
            {invoiceId === undefined ? 'New invoice' : 'Edit draft invoice'}
          </h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Saved as a draft. Issuing it — from the invoice page — allocates a number and posts a
            balanced journal entry.
          </p>
        </header>

        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm flex-1 min-w-56">
            <span className="text-[var(--muted)]">Customer</span>
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className={inputClass}
            >
              <option value="">Select a customer…</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
            <Link to={`${base}/customers?new=1`} className="text-xs">
              + New customer
            </Link>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Issue date</span>
            <input
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Payment terms</span>
            <select
              value={paymentTermsCode}
              onChange={(e) => {
                setPaymentTermsCode(e.target.value);
                setDueDateTouched(false);
              }}
              className={inputClass}
            >
              <option value="">Custom due date</option>
              {paymentTerms.map((term) => (
                <option key={term.id} value={term.code}>
                  {term.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Due date</span>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => {
                setDueDate(e.target.value);
                setDueDateTouched(true);
              }}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Currency</span>
            <select value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} className={inputClass}>
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                  {code === baseCurrency ? ' (base)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>

        {currencyCode !== baseCurrency && (
          <div className="text-sm">
            {rateLoading && <p className="text-[var(--muted)] m-0">Resolving the {currencyCode} rate…</p>}
            {rateError !== null && (
              <p className="status status--bad m-0">
                {rateError} —{' '}
                <Link to={`${base}/fx-rates`}>add one under Currency → Rates</Link>.
              </p>
            )}
            {resolvedRate !== null && !rateLoading && (
              <p className="text-[var(--muted)] m-0">
                1 {currencyCode} = {resolvedRate.rate} {baseCurrency} (rate dated {resolvedRate.rateDate})
              </p>
            )}
          </div>
        )}

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputClass} />
        </label>

        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[56rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium w-40">Item</th>
                <th className="p-3 font-medium">Description</th>
                <th className="p-3 font-medium w-24 text-right">Qty</th>
                <th className="p-3 font-medium w-28 text-right">Unit price</th>
                <th className="p-3 font-medium">Account</th>
                <th className="p-3 font-medium w-20 text-right">Tax %</th>
                <th className="p-3 font-medium w-28 text-right">Amount</th>
                <th className="p-3 w-10" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const quantityMilli = parseQuantityInput(line.quantity) ?? 0;
                const unitPriceCents = parseCentsInput(line.unitPrice) ?? 0;
                const taxRateBp = line.taxRate.trim() === '' ? 0 : (parseRateInput(line.taxRate) ?? 0);
                const netCents = previewNetCents(unitPriceCents, quantityMilli);
                const taxCents = previewTaxCents(netCents, taxRateBp);

                return (
                  <tr key={index} className="border-t border-[var(--border)]">
                    <td className="p-2">
                      <select
                        value={line.itemId}
                        onChange={(e) => applyItem(index, e.target.value)}
                        aria-label={`Item for line ${String(index + 1)}`}
                        className={inputClass}
                      >
                        <option value="">Free text</option>
                        {items.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.code} · {item.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-2">
                      <input
                        type="text"
                        value={line.description}
                        onChange={(e) => updateLine(index, { description: e.target.value })}
                        aria-label={`Description for line ${String(index + 1)}`}
                        className={inputClass}
                      />
                    </td>
                    <td className="p-2">
                      <input
                        inputMode="decimal"
                        value={line.quantity}
                        onChange={(e) => updateLine(index, { quantity: e.target.value })}
                        aria-label={`Quantity for line ${String(index + 1)}`}
                        className={`${inputClass} text-right tabular-nums`}
                      />
                    </td>
                    <td className="p-2">
                      <input
                        inputMode="decimal"
                        value={line.unitPrice}
                        onChange={(e) => updateLine(index, { unitPrice: e.target.value })}
                        placeholder="0.00"
                        aria-label={`Unit price for line ${String(index + 1)}`}
                        className={`${inputClass} text-right tabular-nums`}
                      />
                    </td>
                    <td className="p-2">
                      <select
                        value={line.revenueAccountId}
                        onChange={(e) => updateLine(index, { revenueAccountId: e.target.value })}
                        aria-label={`Account for line ${String(index + 1)}`}
                        className={inputClass}
                      >
                        <option value="">Select…</option>
                        {revenueAccounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.code} · {account.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-2">
                      <input
                        inputMode="decimal"
                        value={line.taxRate}
                        onChange={(e) => updateLine(index, { taxRate: e.target.value })}
                        placeholder="0"
                        aria-label={`Tax rate for line ${String(index + 1)}`}
                        className={`${inputClass} text-right tabular-nums`}
                      />
                    </td>
                    <td className="p-2 text-right tabular-nums">{formatCents(netCents + taxCents)}</td>
                    <td className="p-2 text-center">
                      <button
                        type="button"
                        disabled={lines.length <= 1}
                        onClick={() => setLines((c) => c.filter((_, i) => i !== index))}
                        aria-label={`Remove line ${String(index + 1)}`}
                        className="text-[var(--muted)] hover:text-[var(--bad)] disabled:opacity-30 disabled:cursor-not-allowed bg-transparent border-0 cursor-pointer p-1"
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[var(--border)]">
                <td className="p-3" colSpan={8}>
                  <button
                    type="button"
                    onClick={() =>
                      setLines((c) => [
                        ...c,
                        emptyLine({
                          revenueAccountId: settings?.defaultRevenueAccountId ?? '',
                          taxRate:
                            settings === null || settings.defaultTaxRateBp === 0
                              ? ''
                              : formatRate(settings.defaultTaxRateBp),
                        }),
                      ])
                    }
                    className="flex items-center gap-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border-0 cursor-pointer p-0"
                  >
                    <Plus size={15} /> Add line
                  </button>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="flex flex-col items-end gap-1.5 w-full max-w-sm self-end text-sm">
          <div className="flex justify-between gap-6 w-full">
            <span className="text-[var(--muted)] min-w-0">Subtotal</span>
            <span className="tabular-nums whitespace-nowrap">{formatCents(totals.subtotal)}</span>
          </div>
          <div className="flex justify-between gap-6 w-full">
            <span className="text-[var(--muted)] min-w-0">{settings?.taxLabel ?? 'Tax'}</span>
            <span className="tabular-nums whitespace-nowrap">{formatCents(totals.tax)}</span>
          </div>
          <div className="flex justify-between gap-6 w-full font-semibold border-t border-[var(--border)] pt-2">
            <span className="min-w-0">Total</span>
            <span className="tabular-nums whitespace-nowrap">{formatCents(totals.total)}</span>
          </div>
          {currencyCode !== baseCurrency && resolvedRate !== null && (
            <div className="flex justify-between gap-6 w-full text-[var(--muted)]">
              <span className="min-w-0">≈ {baseCurrency}</span>
              {/* Preview only, rounded client-side — the server resolves and
                  freezes the authoritative base total on save/issue. */}
              <span className="tabular-nums whitespace-nowrap">
                {formatCents(Math.round(totals.total * Number(resolvedRate.rate)))}
              </span>
            </div>
          )}
        </div>

        {totals.malformed && (
          <p className="text-sm text-[var(--bad)]">One or more lines have an invalid amount.</p>
        )}
        {error !== null && <p className="status status--bad">{error}</p>}

        <div>
          <button
            type="submit"
            disabled={!canSave}
            className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Saving…' : 'Save draft'}
          </button>
        </div>
      </form>
    </section>
  );
}
