import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import {
  createOrder,
  getInvoiceSettings,
  getOrder,
  listAccounts,
  listItems,
  listPaymentTerms,
  updateOrder,
  type Account,
  type Item,
  type Order,
  type OrderInput,
  type PaymentTerm,
} from '../../../services/fetchServices';
import {
  formatCents,
  formatQuantity,
  formatRate,
  parseCentsInput,
  parseQuantityInput,
  parseRateInput,
} from '../../../utils/money';
import { useLedgerSettings } from '../../../context/LedgerSettingsContext';
import BackLink from '../../../components/BackLink';
import LoadingState from '../../../components/ui/LoadingState';
import { ProductPicker } from '../../products/ProductPicker';
import { useStockLineData } from '../../products/useStockLineData';
import type { QuoteParty } from '../quotes/quoteKinds';
import type { OrderKindConfig } from './orderKinds';

/**
 * Draft an order, or edit a draft one (Phase 42) — the same page, told apart
 * by the `:orderId` route param. A confirmed order is frozen by migration
 * 092's trigger, so editing one refuses here.
 *
 * Totals are a preview (per-line, half-up — the server's formula); the
 * server's numbers are what is saved.
 */

const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'SGD', 'AED', 'CHF', 'NZD', 'ZAR'] as const;

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

interface DraftLine {
  itemId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
  taxRate: string;
}

function today(): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function previewNet(unitPriceCents: number, quantityMilli: number): number {
  return Math.round((unitPriceCents * quantityMilli) / 1000);
}

function previewTax(netCents: number, taxRateBp: number): number {
  return Math.round((netCents * taxRateBp) / 10000);
}

function blankLine(accountId: string, taxRate: string): DraftLine {
  return { itemId: '', description: '', quantity: '1', unitPrice: '', accountId, taxRate };
}

function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export default function OrderFormPage({ config }: { config: OrderKindConfig }) {
  const navigate = useNavigate();
  const { orderId } = useParams<{ orderId?: string }>();
  const ledgerSettings = useLedgerSettings();
  const baseCurrency = ledgerSettings.status === 'ready' ? ledgerSettings.settings.baseCurrency : 'USD';

  const [parties, setParties] = useState<QuoteParty[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const stockData = useStockLineData();
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerm[]>([]);
  const [existing, setExisting] = useState<Order | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [partyId, setPartyId] = useState('');
  const [orderDate, setOrderDate] = useState(today);
  const [expectedDate, setExpectedDate] = useState('');
  const [currencyCode, setCurrencyCode] = useState('');
  const [partyReference, setPartyReference] = useState('');
  const [paymentTermsCode, setPaymentTermsCode] = useState('');
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [defaultLine, setDefaultLine] = useState({ accountId: '', taxRate: '' });

  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function load() {
      const [partyList, accountsRes, itemsRes, termsRes, settings] = await Promise.all([
        config.listParties(),
        listAccounts(),
        listItems({ includeInactive: false }),
        listPaymentTerms(),
        getInvoiceSettings(),
      ]);
      const order = orderId === undefined ? null : (await getOrder(config.direction, orderId)).order;
      if (ignore) return;

      const lineAccounts = accountsRes.accounts.filter(
        (a) => a.isPostable && a.isActive && config.lineAccountTypes.includes(a.type),
      );
      setParties(partyList);
      setAccounts(lineAccounts);
      setItems(itemsRes.items);
      setPaymentTerms(termsRes.paymentTerms);

      const fallbackAccount =
        config.direction === 'SALES' ? (settings.defaultRevenueAccountId ?? '') : (lineAccounts[0]?.id ?? '');
      const fallbackTax =
        config.direction === 'SALES' && settings.defaultTaxRateBp !== 0 ? formatRate(settings.defaultTaxRateBp) : '';
      setDefaultLine({ accountId: fallbackAccount, taxRate: fallbackTax });

      if (order === null) {
        setLines([blankLine(fallbackAccount, fallbackTax)]);
      } else {
        setExisting(order);
        setPartyId(order.partyId);
        setOrderDate(order.orderDate);
        setExpectedDate(order.expectedDate ?? '');
        setCurrencyCode(order.currencyCode);
        setPartyReference(order.partyReference ?? '');
        setPaymentTermsCode(order.paymentTermsCode ?? '');
        setNotes(order.notes ?? '');
        setTerms(order.terms ?? '');
        setLines(
          order.lines.map((l) => ({
            itemId: l.itemId ?? '',
            description: l.description,
            quantity: formatQuantity(l.quantityMilli),
            unitPrice: formatCents(l.unitPriceCents),
            accountId: l.accountId,
            taxRate: l.taxRateBp === 0 ? '' : formatRate(l.taxRateBp),
          })),
        );
      }
      setLoaded(true);
    }
    load().catch((err: unknown) => {
      if (!ignore) setLoadError(err instanceof Error ? err.message : 'Could not load the form');
    });
    return () => {
      ignore = true;
    };
  }, [config, orderId]);

  const currency = currencyCode === '' ? baseCurrency : currencyCode;

  const parsed = useMemo(
    () =>
      lines.map((line) => {
        const quantityMilli = parseQuantityInput(line.quantity);
        const unitPriceCents = parseCentsInput(line.unitPrice);
        const taxRateBp = line.taxRate.trim() === '' ? 0 : parseRateInput(line.taxRate);
        const valid = quantityMilli !== null && quantityMilli > 0 && unitPriceCents !== null && taxRateBp !== null;
        const netCents = valid ? previewNet(unitPriceCents, quantityMilli) : 0;
        const taxCents = valid ? previewTax(netCents, taxRateBp) : 0;
        return { line, quantityMilli, unitPriceCents, taxRateBp, valid, netCents, taxCents };
      }),
    [lines],
  );
  const subtotal = parsed.reduce((sum, p) => sum + p.netCents, 0);
  const tax = parsed.reduce((sum, p) => sum + p.taxCents, 0);

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  /** Picking a catalogue item copies its defaults into the line once; every field stays editable. */
  function applyItem(index: number, itemId: string) {
    const item = items.find((i) => i.id === itemId);
    if (item === undefined) {
      updateLine(index, { itemId });
      return;
    }
    const defaults = config.itemDefaults(item);
    updateLine(index, {
      itemId: item.id,
      description: item.name,
      unitPrice: formatCents(defaults.unitPriceCents),
      accountId: defaults.accountId,
      taxRate: defaults.taxRateBp === 0 ? '' : formatRate(defaults.taxRateBp),
    });
  }

  async function handleSave() {
    setError(null);
    if (partyId === '') {
      setError(`Choose a ${config.partyNoun.toLowerCase()}`);
      return;
    }
    if (lines.length === 0) {
      setError('An order needs at least one line');
      return;
    }
    const invalid = parsed.findIndex((p) => !p.valid || p.line.description.trim() === '' || p.line.accountId === '');
    if (invalid !== -1) {
      setError(`Line ${String(invalid + 1)} needs a description, a quantity above zero, a price and an account`);
      return;
    }
    if (expectedDate !== '' && expectedDate < orderDate) {
      setError('Expected date cannot be before the order date');
      return;
    }

    const body: OrderInput = {
      partyId,
      orderDate,
      expectedDate: expectedDate === '' ? null : expectedDate,
      currencyCode: currency,
      partyReference: textOrNull(partyReference),
      notes: textOrNull(notes),
      terms: textOrNull(terms),
      paymentTerms: null,
      paymentTermsCode: paymentTermsCode === '' ? null : paymentTermsCode,
      lines: parsed.map((p) => ({
        description: p.line.description.trim(),
        quantityMilli: p.quantityMilli ?? 0,
        unitPriceCents: p.unitPriceCents ?? 0,
        accountId: p.line.accountId,
        taxRateBp: p.taxRateBp ?? 0,
        itemId: p.line.itemId === '' ? null : p.line.itemId,
      })),
    };

    setBusy(true);
    try {
      const { order } =
        existing === null ? await createOrder(config.direction, body) : await updateOrder(config.direction, existing.id, body);
      void navigate(`/${config.path}/${order.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the order');
      setBusy(false);
    }
  }

  const listLink = { to: `/${config.path}`, label: `Back to ${config.plural.toLowerCase()}` };

  if (loadError !== null) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink {...listLink} />
        <p className="status status--bad">{loadError}</p>
      </section>
    );
  }
  if (!loaded) return <LoadingState />;
  if (existing !== null && existing.status !== 'DRAFT') {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to={`/${config.path}/${existing.id}`} label="Back to the order" />
        <p className="status status--bad">A confirmed order cannot be edited.</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <BackLink {...(existing === null ? listLink : { to: `/${config.path}/${existing.id}`, label: 'Back to the order' })} />
      <header>
        <h2 className="text-lg font-semibold m-0">
          {existing === null ? `New ${config.title.toLowerCase()}` : `Edit draft ${config.title.toLowerCase()}`}
        </h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">{config.formHint}</p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-[var(--muted)]">{config.partyNoun}</span>
          <select value={partyId} onChange={(e) => setPartyId(e.target.value)} className={inputClass}>
            <option value="">Select a {config.partyNoun.toLowerCase()}…</option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Link to={config.newPartyPath} className="text-xs">
            + New {config.partyNoun.toLowerCase()}
          </Link>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Order date</span>
          <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Expected date (optional)</span>
          <input
            type="date"
            value={expectedDate}
            min={orderDate}
            onChange={(e) => setExpectedDate(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-[var(--muted)]">{config.partyReferenceLabel}</span>
          <input
            type="text"
            value={partyReference}
            maxLength={100}
            onChange={(e) => setPartyReference(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Currency</span>
          <select value={currency} onChange={(e) => setCurrencyCode(e.target.value)} className={inputClass}>
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
                {code === baseCurrency ? ' (base)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Payment terms (optional)</span>
          <select value={paymentTermsCode} onChange={(e) => setPaymentTermsCode(e.target.value)} className={inputClass}>
            <option value="">None</option>
            {paymentTerms.map((term) => (
              <option key={term.id} value={term.code}>
                {term.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {currency !== baseCurrency && (
        <p className="text-sm text-[var(--muted)] m-0">
          Priced in {currency}. The {config.billNoun}s raised against this order use the exchange rate on their own dates.
        </p>
      )}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm min-w-[56rem]">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className="p-2 font-medium w-40">Item</th>
              <th className="p-2 font-medium">Description</th>
              <th className="p-2 font-medium w-24 text-right">Qty</th>
              <th className="p-2 font-medium w-28 text-right">Unit price</th>
              <th className="p-2 font-medium">{config.lineAccountLabel}</th>
              <th className="p-2 font-medium w-20 text-right">Tax %</th>
              <th className="p-2 font-medium w-28 text-right">Amount</th>
              <th className="p-2 w-10" />
            </tr>
          </thead>
          <tbody>
            {parsed.map((p, index) => (
              <tr key={index} className="border-t border-[var(--border)]">
                <td className="p-2">
                  <ProductPicker
                    value={p.line.itemId}
                    items={items}
                    balances={stockData.balances}
                    onChange={(itemId) => applyItem(index, itemId)}
                    ariaLabel={`Item for line ${String(index + 1)}`}
                    className={inputClass}
                  />
                </td>
                <td className="p-2">
                  <input
                    aria-label={`Description for line ${String(index + 1)}`}
                    value={p.line.description}
                    maxLength={500}
                    onChange={(e) => updateLine(index, { description: e.target.value })}
                    className={inputClass}
                  />
                </td>
                <td className="p-2">
                  <input
                    inputMode="decimal"
                    aria-label={`Quantity for line ${String(index + 1)}`}
                    value={p.line.quantity}
                    onChange={(e) => updateLine(index, { quantity: e.target.value })}
                    className={`${inputClass} text-right tabular-nums`}
                  />
                </td>
                <td className="p-2">
                  <input
                    inputMode="decimal"
                    aria-label={`Unit price for line ${String(index + 1)}`}
                    value={p.line.unitPrice}
                    placeholder="0.00"
                    onChange={(e) => updateLine(index, { unitPrice: e.target.value })}
                    className={`${inputClass} text-right tabular-nums`}
                  />
                </td>
                <td className="p-2">
                  <select
                    aria-label={`Account for line ${String(index + 1)}`}
                    value={p.line.accountId}
                    onChange={(e) => updateLine(index, { accountId: e.target.value })}
                    className={inputClass}
                  >
                    <option value="">Select…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="p-2">
                  <input
                    inputMode="decimal"
                    aria-label={`Tax rate for line ${String(index + 1)}`}
                    value={p.line.taxRate}
                    placeholder="0"
                    onChange={(e) => updateLine(index, { taxRate: e.target.value })}
                    className={`${inputClass} text-right tabular-nums`}
                  />
                </td>
                <td className="p-2 text-right tabular-nums">{formatCents(p.netCents + p.taxCents)}</td>
                <td className="p-2 text-center">
                  <button
                    type="button"
                    disabled={lines.length <= 1}
                    aria-label={`Remove line ${String(index + 1)}`}
                    onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                    className="text-[var(--muted)] hover:text-[var(--bad)] disabled:opacity-30 disabled:cursor-not-allowed bg-transparent border-0 cursor-pointer p-1"
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-between items-start gap-4 flex-wrap">
        <button
          type="button"
          onClick={() => setLines((current) => [...current, blankLine(defaultLine.accountId, defaultLine.taxRate)])}
          className="flex items-center gap-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border-0 cursor-pointer p-0"
        >
          <Plus size={15} aria-hidden="true" /> Add line
        </button>
        <div className="flex flex-col gap-1 text-sm min-w-56">
          <div className="flex justify-between gap-6">
            <span className="text-[var(--muted)]">Subtotal</span>
            <span className="tabular-nums">{formatCents(subtotal)}</span>
          </div>
          <div className="flex justify-between gap-6">
            <span className="text-[var(--muted)]">Tax</span>
            <span className="tabular-nums">{formatCents(tax)}</span>
          </div>
          <div className="flex justify-between gap-6 font-semibold border-t border-[var(--border)] pt-1">
            <span>Total</span>
            <span className="tabular-nums" data-testid="order-form-total">
              {formatCents(subtotal + tax)} {currency}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Notes (optional)</span>
          <textarea value={notes} maxLength={1000} rows={4} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Terms and conditions (optional)</span>
          <textarea value={terms} maxLength={5000} rows={4} onChange={(e) => setTerms(e.target.value)} className={inputClass} />
        </label>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}

      <div>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy}
          className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40"
        >
          {busy ? 'Saving…' : existing === null ? 'Save draft' : 'Save changes'}
        </button>
      </div>
    </section>
  );
}
