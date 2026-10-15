import { useEffect, useMemo, useRef, useState } from 'react';
import type { AvailableCredit } from '../services/fetchServices';
import { formatCents, parseCentsInput } from '../utils/money';
import { formatDate } from '../utils/date';

/**
 * Phase 43c — offered when a bill is approved or an invoice is issued and the
 * party has open credit (unapplied debit/credit notes, prepayments/deposits).
 * The chosen credits are sent with the approval and applied in the same server
 * transaction; the server re-checks every amount, so this dialog only pre-fills
 * and blocks the obviously wrong (an amount above what a credit has available,
 * or a total above what is due).
 */

export interface ApplyCredit {
  kind: 'NOTE' | 'DEPOSIT';
  id: string;
  amountCents: number;
}

export interface ApplyCreditsDialogProps {
  direction: 'PURCHASE' | 'SALES';
  title: string;
  documentTotalCents: number;
  amountDueCents: number;
  credits: AvailableCredit[];
  busy: boolean;
  /** A server message from the last attempt, shown inside the dialog. */
  error?: string | null;
  onConfirm: (applyCredits: ApplyCredit[]) => void;
  onSkip: () => void;
  onCancel: () => void;
}

interface RowState {
  checked: boolean;
  text: string;
}

function creditLabel(direction: 'PURCHASE' | 'SALES', credit: AvailableCredit): string {
  const noun =
    credit.kind === 'NOTE'
      ? direction === 'PURCHASE'
        ? 'Debit note'
        : 'Credit note'
      : direction === 'PURCHASE'
        ? 'Prepayment'
        : 'Deposit';
  return credit.number !== null ? `${noun} ${credit.number}` : noun;
}

/** Oldest first; the sort is stable so equal dates keep the server's order. */
function sortOldestFirst(credits: AvailableCredit[]): AvailableCredit[] {
  return [...credits].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function prefill(credits: AvailableCredit[], amountDueCents: number): Record<string, RowState> {
  const state: Record<string, RowState> = {};
  let remaining = amountDueCents;
  for (const credit of credits) {
    const take = Math.min(credit.availableCents, Math.max(remaining, 0));
    if (take > 0) {
      state[credit.id] = { checked: true, text: formatCents(take) };
      remaining -= take;
    } else {
      state[credit.id] = { checked: false, text: formatCents(credit.availableCents) };
    }
  }
  return state;
}

export default function ApplyCreditsDialog({
  direction,
  title,
  documentTotalCents,
  amountDueCents,
  credits,
  busy,
  error = null,
  onConfirm,
  onSkip,
  onCancel,
}: ApplyCreditsDialogProps) {
  const ordered = useMemo(() => sortOldestFirst(credits), [credits]);
  const [rows, setRows] = useState<Record<string, RowState>>(() => prefill(ordered, amountDueCents));
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checked = ordered.filter((c) => rows[c.id]?.checked === true);
  const parsed = checked.map((c) => ({ credit: c, cents: parseCentsInput(rows[c.id]?.text ?? '') }));
  const anyInvalid = parsed.some(
    ({ credit, cents }) => cents === null || cents <= 0 || cents > credit.availableCents,
  );
  const totalApplied = parsed.reduce((sum, { cents }) => sum + (cents ?? 0), 0);
  const overDue = totalApplied > amountDueCents;
  const remainingDue = amountDueCents - totalApplied;
  const canConfirm = !busy && checked.length > 0 && !anyInvalid && !overDue;

  const isBill = direction === 'PURCHASE';
  const primaryLabel = isBill ? 'Approve and apply' : 'Issue and apply';
  const skipLabel = isBill ? 'Approve only' : 'Issue only';

  function update(id: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { checked: prev[id]?.checked ?? false, text: prev[id]?.text ?? '', ...patch } }));
  }

  function confirm() {
    if (!canConfirm) return;
    onConfirm(
      parsed.map(({ credit, cents }) => ({ kind: credit.kind, id: credit.id, amountCents: cents ?? 0 })),
    );
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="apply-credits-title"
        className="animate-pop-in w-full max-w-2xl rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 flex flex-col gap-3 shadow-[var(--shadow-lg)]"
      >
        <h3 id="apply-credits-title" className="text-base font-semibold m-0">
          Apply available credit?
        </h3>
        <p className="text-sm text-[var(--muted)] m-0">
          {title} Document total {formatCents(documentTotalCents)}; amount due {formatCents(amountDueCents)}.
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[var(--muted)]">
              <th className="p-2 w-8" />
              <th className="p-2">Credit</th>
              <th className="p-2">Date</th>
              <th className="p-2 text-right">Available</th>
              <th className="p-2 text-right">Apply</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((credit) => {
              const label = creditLabel(direction, credit);
              const row = rows[credit.id] ?? { checked: false, text: '' };
              const cents = parseCentsInput(row.text);
              const rowBad = row.checked && (cents === null || cents <= 0 || cents > credit.availableCents);
              return (
                <tr key={credit.id} className="border-t border-[var(--border)]">
                  <td className="p-2">
                    <input
                      type="checkbox"
                      aria-label={`Apply ${label}`}
                      checked={row.checked}
                      onChange={(e) => update(credit.id, { checked: e.target.checked })}
                    />
                  </td>
                  <td className="p-2">{label}</td>
                  <td className="p-2 tabular-nums">{formatDate(credit.date)}</td>
                  <td className="p-2 text-right tabular-nums">
                    {formatCents(credit.availableCents)} {credit.currencyCode}
                  </td>
                  <td className="p-2 text-right">
                    <input
                      inputMode="decimal"
                      aria-label={`Amount for ${label}`}
                      aria-invalid={rowBad}
                      value={row.text}
                      disabled={!row.checked}
                      onChange={(e) => update(credit.id, { text: e.target.value })}
                      className="w-28 text-right tabular-nums rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className={`text-sm m-0 text-right tabular-nums ${overDue ? 'text-[var(--bad)]' : ''}`}>
          Remaining due: {formatCents(remainingDue)}
        </p>
        {error !== null && <p className="status status--bad m-0">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--ghost" onClick={onSkip} disabled={busy}>
            {skipLabel}
          </button>
          <button
            ref={primaryRef}
            type="button"
            onClick={confirm}
            disabled={!canConfirm}
            className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? '…' : primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
