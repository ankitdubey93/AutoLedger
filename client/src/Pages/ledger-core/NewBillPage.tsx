import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import {
  ApiRequestError,
  createBill,
  getBill,
  getLatestFxRate,
  listAccounts,
  listVendors,
  updateBill,
  type Account,
  type ResolvedRate,
  type Vendor,
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
 * Enter a bill, edit one, or duplicate one — the same page, told apart by
 * `:billId` (edit) vs `?copyFrom=` (duplicate) vs neither (new). Mirrors
 * NewInvoicePage's structure; the AP mirror is the expense-account picker
 * (Expense or Asset only, never Revenue) and the required vendor reference.
 *
 * A POSTED bill can never be edited (guardrails rule 6), so editing one here
 * refuses with a message instead of silently loading stale data into a form
 * that would post a lie.
 */

interface DraftLine {
  description: string;
  quantity: string;
  unitPrice: string;
  expenseAccountId: string;
  taxRate: string;
}

function emptyLine(): DraftLine {
  return { description: '', quantity: '', unitPrice: '', expenseAccountId: '', taxRate: '' };
}

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
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

export default function NewBillPage() {
  const base = useAppBasePath();
  const navigate = useNavigate();
  const { billId } = useParams<{ billId?: string }>();
  const [params] = useSearchParams();
  const copyFrom = params.get('copyFrom');

  const ledgerSettings = useLedgerSettings();
  const baseCurrency = ledgerSettings.status === 'ready' ? ledgerSettings.settings.baseCurrency : 'USD';

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<Account[]>([]);

  const [vendorId, setVendorId] = useState('');
  const [vendorReference, setVendorReference] = useState('');
  const [billDate, setBillDate] = useState(today);
  const [dueDate, setDueDate] = useState('');
  const [currencyCode, setCurrencyCode] = useState(baseCurrency);
  const [paymentTerms, setPaymentTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);

  const [seeded, setSeeded] = useState(false);
  const [notEditable, setNotEditable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [resolvedRate, setResolvedRate] = useState<ResolvedRate | null>(null);
  const [rateError, setRateError] = useState<string | null>(null);
  const [rateLoading, setRateLoading] = useState(false);

  useEffect(() => {
    let ignore = false;

    Promise.all([listVendors({ includeInactive: false }), listAccounts()])
      .then(([vendorsRes, accountsRes]) => {
        if (ignore) return;
        setVendors(vendorsRes.vendors);
        setExpenseAccounts(
          accountsRes.accounts.filter(
            (a) => a.isPostable && (a.type === 'Expense' || a.type === 'Asset'),
          ),
        );
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load bill data');
      });

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    const sourceId = billId ?? copyFrom;
    if (sourceId === null || sourceId === undefined || seeded) return;
    let ignore = false;

    getBill(sourceId)
      .then((res) => {
        if (ignore) return;
        const bill = res.bill;
        if (billId !== undefined && bill.status !== 'DRAFT' && bill.status !== 'AWAITING_APPROVAL') {
          setNotEditable(true);
          setSeeded(true);
          return;
        }
        setVendorId(bill.vendorId);
        // A duplicate needs its own reference — never carry the original forward.
        setVendorReference(billId !== undefined ? bill.vendorReference : '');
        setBillDate(billId !== undefined ? bill.billDate : today());
        setDueDate(bill.dueDate);
        setCurrencyCode(bill.currencyCode);
        setPaymentTerms(bill.paymentTerms ?? '');
        setNotes(bill.notes ?? '');
        setLines(
          bill.lines.map((line) => ({
            description: line.description,
            quantity: formatQuantity(line.quantityMilli),
            unitPrice: formatCents(line.unitPriceCents),
            expenseAccountId: line.expenseAccountId,
            taxRate: line.taxRateBp === 0 ? '' : formatRate(line.taxRateBp),
          })),
        );
        setSeeded(true);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setError(err instanceof Error ? err.message : 'Could not load the bill');
        setSeeded(true);
      });

    return () => {
      ignore = true;
    };
  }, [billId, copyFrom, seeded]);

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
  // save/approve independently.
  useEffect(() => {
    if (currencyCode === baseCurrency || billDate === '') {
      setResolvedRate(null);
      setRateError(null);
      return;
    }
    let ignore = false;
    setRateLoading(true);
    setRateError(null);
    getLatestFxRate(currencyCode, billDate)
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
  }, [currencyCode, baseCurrency, billDate]);

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  const complete =
    vendorId !== '' &&
    vendorReference.trim() !== '' &&
    billDate !== '' &&
    dueDate !== '' &&
    lines.length > 0 &&
    lines.every(
      (line) =>
        line.description.trim() !== '' &&
        line.expenseAccountId !== '' &&
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
        vendorId,
        vendorReference: vendorReference.trim(),
        billDate,
        dueDate,
        currencyCode,
        notes: notes.trim() === '' ? null : notes.trim(),
        paymentTerms: paymentTerms.trim() === '' ? null : paymentTerms.trim(),
        lines: lines.map((line) => ({
          description: line.description.trim(),
          quantityMilli: parseQuantityInput(line.quantity) ?? 0,
          unitPriceCents: parseCentsInput(line.unitPrice) ?? 0,
          expenseAccountId: line.expenseAccountId,
          taxRateBp: line.taxRate.trim() === '' ? 0 : (parseRateInput(line.taxRate) ?? 0),
        })),
      };

      const { bill } = billId === undefined ? await createBill(body) : await updateBill(billId, body);

      navigate(`${base}/bills/${bill.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the bill');
      setBusy(false);
    }
  }

  if (notEditable) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to={`${base}/bills`} label="Back to bills" />
        <p className="status status--bad">Only a draft or in-review bill can be edited.</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <BackLink to={`${base}/bills`} label="Back to bills" />

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
        <header>
          <h2 className="text-lg font-semibold m-0">
            {billId === undefined ? 'New bill' : 'Edit bill'}
          </h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Saved as a draft. Submitting it for review, then approving it — from the bill page —
            posts a balanced journal entry.
          </p>
        </header>

        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm flex-1 min-w-56">
            <span className="text-[var(--muted)]">Vendor</span>
            <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className={inputClass}>
              <option value="">Select a vendor…</option>
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.name}
                </option>
              ))}
            </select>
            <Link to={`${base}/vendors?new=1`} className="text-xs">
              + New vendor
            </Link>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Vendor reference</span>
            <input
              type="text"
              value={vendorReference}
              onChange={(e) => setVendorReference(e.target.value)}
              maxLength={100}
              placeholder="The vendor's own invoice number"
              className={inputClass}
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Bill date</span>
            <input
              type="date"
              value={billDate}
              onChange={(e) => setBillDate(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Due date</span>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
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
                {rateError} — <Link to={`${base}/fx-rates`}>add one under Currency → Rates</Link>.
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
          <span className="text-[var(--muted)]">Payment terms</span>
          <input
            type="text"
            value={paymentTerms}
            onChange={(e) => setPaymentTerms(e.target.value)}
            maxLength={500}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputClass} />
        </label>

        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[48rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
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
                        value={line.expenseAccountId}
                        onChange={(e) => updateLine(index, { expenseAccountId: e.target.value })}
                        aria-label={`Account for line ${String(index + 1)}`}
                        className={inputClass}
                      >
                        <option value="">Select…</option>
                        {expenseAccounts.map((account) => (
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
                <td className="p-3" colSpan={7}>
                  <button
                    type="button"
                    onClick={() => setLines((c) => [...c, emptyLine()])}
                    className="flex items-center gap-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border-0 cursor-pointer p-0"
                  >
                    <Plus size={15} /> Add line
                  </button>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="flex flex-col items-end gap-1 max-w-xs self-end text-sm">
          <div className="flex justify-between w-full">
            <span className="text-[var(--muted)]">Subtotal</span>
            <span className="tabular-nums">{formatCents(totals.subtotal)}</span>
          </div>
          <div className="flex justify-between w-full">
            <span className="text-[var(--muted)]">Tax</span>
            <span className="tabular-nums">{formatCents(totals.tax)}</span>
          </div>
          <div className="flex justify-between w-full font-semibold border-t border-[var(--border)] pt-1">
            <span>Total</span>
            <span className="tabular-nums">{formatCents(totals.total)}</span>
          </div>
          {currencyCode !== baseCurrency && resolvedRate !== null && (
            <div className="flex justify-between w-full text-[var(--muted)]">
              <span>≈ {baseCurrency}</span>
              <span className="tabular-nums">{formatCents(Math.round(totals.total * Number(resolvedRate.rate)))}</span>
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
