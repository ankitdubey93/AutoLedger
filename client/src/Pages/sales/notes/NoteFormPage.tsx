import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { listAccounts, NOTE_REASON_CODES, type Account, type NoteReasonCode } from '../../../services/fetchServices';
import {
  formatCents,
  formatQuantity,
  formatRate,
  parseCentsInput,
  parseQuantityInput,
  parseRateInput,
} from '../../../utils/money';
import BackLink from '../../../components/BackLink';
import { REASON_LABELS, type NoteKindConfig, type NoteView, type OriginalView } from './noteKinds';

/**
 * Draft a credit or debit note, or edit a draft one (Phase 26). A new note is
 * reached from its original document (`?invoiceId=` / `?billId=`) and starts
 * with that document's lines copied in, ready to be trimmed to what is being
 * returned or allowed. The party, currency and exchange rate are never on
 * this form — the server copies them from the original.
 *
 * A credit note's lines default to 4800 Sales Returns & Allowances when the
 * chart has it: a return belongs in its own contra-revenue account, not
 * netted silently out of the original revenue line.
 *
 * Totals here are a preview (per-line, half-up — the same formula the server
 * uses); the server's numbers are what is saved.
 */

interface DraftLine {
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
  taxRate: string;
}

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

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

export default function NoteFormPage({ config }: { config: NoteKindConfig }) {
  const navigate = useNavigate();
  const { noteId } = useParams<{ noteId?: string }>();
  const [params] = useSearchParams();
  const originalIdParam = params.get(config.originalParam);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [original, setOriginal] = useState<OriginalView | null>(null);
  const [existing, setExisting] = useState<NoteView | null>(null);
  const [issueDate, setIssueDate] = useState(today);
  const [reasonCode, setReasonCode] = useState<NoteReasonCode>('RETURN');
  const [reason, setReason] = useState('');
  const [vendorCreditReference, setVendorCreditReference] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function load() {
      const accountsRes = await listAccounts();
      const lineAccounts = accountsRes.accounts.filter(
        (a) => a.isPostable && a.isActive && config.lineAccountTypes.includes(a.type),
      );
      const returnsAccount =
        config.kind === 'CREDIT_NOTE' ? lineAccounts.find((a) => a.code === '4800') : undefined;

      let note: NoteView | null = null;
      let originalId = originalIdParam;
      if (noteId !== undefined) {
        note = await config.get(noteId);
        originalId = note.originalId;
      }
      if (originalId === null) throw new Error(`Open the ${config.originalNoun} you want to correct, then choose Create ${config.title.toLowerCase()}.`);
      const originalView = await config.getOriginal(originalId);
      if (ignore) return;

      setAccounts(lineAccounts);
      setOriginal(originalView);
      if (note !== null) {
        setExisting(note);
        setIssueDate(note.issueDate);
        setReasonCode(note.reasonCode);
        setReason(note.reason ?? '');
        setVendorCreditReference(note.vendorCreditReference ?? '');
        setNotes(note.notes ?? '');
        setLines(
          note.lines.map((l) => ({
            description: l.description,
            quantity: formatQuantity(l.quantityMilli),
            unitPrice: formatCents(l.unitPriceCents),
            accountId: l.accountId,
            taxRate: formatRate(l.taxRateBp),
          })),
        );
      } else {
        setIssueDate(originalView.date > today() ? originalView.date : today());
        setLines(
          originalView.lines.map((l) => ({
            description: l.description,
            quantity: formatQuantity(l.quantityMilli),
            unitPrice: formatCents(l.unitPriceCents),
            accountId: returnsAccount?.id ?? l.accountId,
            taxRate: formatRate(l.taxRateBp),
          })),
        );
      }
    }
    load().catch((err: unknown) => {
      if (!ignore) setLoadError(err instanceof Error ? err.message : 'Could not load the form');
    });
    return () => {
      ignore = true;
    };
  }, [config, noteId, originalIdParam]);

  const parsed = useMemo(
    () =>
      lines.map((line) => {
        const quantityMilli = parseQuantityInput(line.quantity);
        const unitPriceCents = parseCentsInput(line.unitPrice);
        const taxRateBp = parseRateInput(line.taxRate === '' ? '0' : line.taxRate);
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

  async function handleSave() {
    if (original === null) return;
    setError(null);
    if (lines.length === 0) {
      setError(`A ${config.title.toLowerCase()} needs at least one line`);
      return;
    }
    const invalid = parsed.findIndex((p) => !p.valid || p.line.description.trim() === '' || p.line.accountId === '');
    if (invalid !== -1) {
      setError(`Line ${String(invalid + 1)} needs a description, a quantity above zero, a price and an account`);
      return;
    }
    const input = {
      originalId: original.id,
      issueDate,
      reasonCode,
      reason: reason.trim() === '' ? null : reason.trim(),
      vendorCreditReference:
        config.hasVendorCreditReference && vendorCreditReference.trim() !== '' ? vendorCreditReference.trim() : null,
      notes: notes.trim() === '' ? null : notes.trim(),
      lines: parsed.map((p) => ({
        description: p.line.description.trim(),
        quantityMilli: p.quantityMilli ?? 0,
        unitPriceCents: p.unitPriceCents ?? 0,
        accountId: p.line.accountId,
        taxRateBp: p.taxRateBp ?? 0,
      })),
    };
    setBusy(true);
    try {
      const saved = existing === null ? await config.create(input) : await config.update(existing.id, input);
      void navigate(`/${config.path}/${saved.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : `Could not save the ${config.title.toLowerCase()}`);
    } finally {
      setBusy(false);
    }
  }

  const backTo =
    existing !== null
      ? { to: `/${config.path}/${existing.id}`, label: `Back to ${config.title.toLowerCase()}` }
      : original !== null
        ? { to: `/${config.originalPath}/${original.id}`, label: `Back to ${config.originalNoun}` }
        : { to: `/${config.path}`, label: `Back to ${config.plural.toLowerCase()}` };

  if (loadError !== null) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to={`/${config.path}`} label={`Back to ${config.plural.toLowerCase()}`} />
        <p className="status status--bad">{loadError}</p>
      </section>
    );
  }
  if (original === null) {
    return <p className="muted">Loading…</p>;
  }
  if (existing !== null && existing.status !== 'DRAFT') {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to={backTo.to} label={backTo.label} />
        <p className="status status--bad">Only a draft {config.title.toLowerCase()} can be edited — void it instead.</p>
      </section>
    );
  }
  if (!original.isOpen) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to={backTo.to} label={backTo.label} />
        <p className="status status--bad">{config.notOpenMessage}</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <BackLink to={backTo.to} label={backTo.label} />
      <header>
        <h2 className="text-lg font-semibold m-0">
          {existing === null ? `New ${config.title.toLowerCase()}` : `Edit ${config.title.toLowerCase()}`}
        </h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">{config.postingHint}</p>
      </header>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Against</p>
          <p className="m-0 font-mono">{original.label}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">{config.partyNoun}</p>
          <p className="m-0">{original.partyName}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Total</p>
          <p className="m-0 tabular-nums">
            {formatCents(original.totalCents)} {original.currencyCode}
          </p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">{config.adjustedLabel}</p>
          <p className="m-0 tabular-nums">{formatCents(original.adjustedCents)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Amount due</p>
          <p className="m-0 tabular-nums">{formatCents(original.amountDueCents)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Date</span>
          <input type="date" value={issueDate} min={original.date} onChange={(e) => setIssueDate(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Reason</span>
          <select
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value as NoteReasonCode)}
            className={inputClass}
          >
            {NOTE_REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {REASON_LABELS[code]}
              </option>
            ))}
          </select>
        </label>
        {config.hasVendorCreditReference && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Vendor&apos;s credit note no.</span>
            <input
              type="text"
              value={vendorCreditReference}
              maxLength={100}
              onChange={(e) => setVendorCreditReference(e.target.value)}
              className={inputClass}
            />
          </label>
        )}
        <label className="flex flex-col gap-1 text-sm sm:col-span-3">
          <span className="text-[var(--muted)]">Reason details (optional)</span>
          <input type="text" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className={inputClass} />
        </label>
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm min-w-[48rem]">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className="p-2 font-medium">Description</th>
              <th className="p-2 font-medium w-24">Qty</th>
              <th className="p-2 font-medium w-32">Unit price</th>
              <th className="p-2 font-medium">{config.lineAccountLabel}</th>
              <th className="p-2 font-medium w-24">Tax %</th>
              <th className="p-2 font-medium text-right w-28">Amount</th>
              <th className="p-2 w-10" />
            </tr>
          </thead>
          <tbody>
            {parsed.map((p, index) => (
              <tr key={index} className="border-t border-[var(--border)]">
                <td className="p-2">
                  <input
                    aria-label={`Line ${String(index + 1)} description`}
                    value={p.line.description}
                    onChange={(e) => updateLine(index, { description: e.target.value })}
                    className={inputClass}
                  />
                </td>
                <td className="p-2">
                  <input
                    aria-label={`Line ${String(index + 1)} quantity`}
                    value={p.line.quantity}
                    onChange={(e) => updateLine(index, { quantity: e.target.value })}
                    className={inputClass}
                  />
                </td>
                <td className="p-2">
                  <input
                    aria-label={`Line ${String(index + 1)} unit price`}
                    value={p.line.unitPrice}
                    onChange={(e) => updateLine(index, { unitPrice: e.target.value })}
                    className={inputClass}
                  />
                </td>
                <td className="p-2">
                  <select
                    aria-label={`Line ${String(index + 1)} account`}
                    value={p.line.accountId}
                    onChange={(e) => updateLine(index, { accountId: e.target.value })}
                    className={inputClass}
                  >
                    <option value="">Choose…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="p-2">
                  <input
                    aria-label={`Line ${String(index + 1)} tax rate`}
                    value={p.line.taxRate}
                    onChange={(e) => updateLine(index, { taxRate: e.target.value })}
                    className={inputClass}
                  />
                </td>
                <td className="p-2 text-right tabular-nums">{formatCents(p.netCents + p.taxCents)}</td>
                <td className="p-2">
                  <button
                    type="button"
                    aria-label={`Remove line ${String(index + 1)}`}
                    onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                    className="bg-transparent border-0 cursor-pointer text-[var(--muted)] hover:text-[var(--text)]"
                  >
                    <Trash2 size={14} aria-hidden="true" />
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
          onClick={() =>
            setLines((current) => [
              ...current,
              { description: '', quantity: '1', unitPrice: '', accountId: accounts[0]?.id ?? '', taxRate: '0' },
            ])
          }
          className="btn btn--ghost flex items-center gap-1.5"
        >
          <Plus size={14} aria-hidden="true" /> Add line
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
            <span className="tabular-nums" data-testid="note-total">
              {formatCents(subtotal + tax)} {original.currencyCode}
            </span>
          </div>
        </div>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Notes (optional)</span>
        <textarea value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} className={inputClass} rows={2} />
      </label>

      {error !== null && <p className="status status--bad">{error}</p>}

      <div>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy}
          className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40"
        >
          {existing === null ? 'Save draft' : 'Save changes'}
        </button>
      </div>
    </section>
  );
}
