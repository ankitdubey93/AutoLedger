import { Plus, Trash2 } from 'lucide-react';
import type { Account } from '../services/fetchServices';
import { formatCents, parseCentsInput } from '../utils/money';

/**
 * Line grid for a manual journal (Phase 44). Pure presentation over string
 * state: amounts stay strings while typed and become integer cents only through
 * parseCentsInput, so nothing here ever touches a float. The balance figures are
 * for the buttons; the server and the database re-check at post time.
 */

export interface EditorLine {
  description: string;
  accountId: string;
  debit: string;
  credit: string;
}

export function emptyLine(): EditorLine {
  return { description: '', accountId: '', debit: '', credit: '' };
}

export interface EditorTotals {
  debits: number;
  credits: number;
  malformed: boolean;
  balanced: boolean;
}

export function editorTotals(lines: EditorLine[]): EditorTotals {
  let debits = 0;
  let credits = 0;
  let malformed = false;

  for (const line of lines) {
    const debit = parseCentsInput(line.debit);
    const credit = parseCentsInput(line.credit);
    if (debit === null || credit === null) {
      malformed = true;
      continue;
    }
    debits += debit;
    credits += credit;
  }

  return { debits, credits, malformed, balanced: !malformed && debits === credits };
}

function isFullyEmpty(line: EditorLine): boolean {
  const debit = parseCentsInput(line.debit) ?? 0;
  const credit = parseCentsInput(line.credit) ?? 0;
  return line.accountId === '' && line.description.trim() === '' && debit === 0 && credit === 0;
}

/** API lines: blanks become null, cents via parseCentsInput; fully empty rows are dropped. */
export function toInputLines(lines: EditorLine[]): Array<{
  accountId: string | null;
  description: string | null;
  debitCents: number;
  creditCents: number;
}> {
  return lines
    .filter((line) => !isFullyEmpty(line))
    .map((line) => ({
      accountId: line.accountId === '' ? null : line.accountId,
      description: line.description.trim() === '' ? null : line.description,
      debitCents: parseCentsInput(line.debit) ?? 0,
      creditCents: parseCentsInput(line.credit) ?? 0,
    }));
}

interface Props {
  lines: EditorLine[];
  onChange: (lines: EditorLine[]) => void;
  accounts: Account[];
}

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

export default function ManualJournalLinesEditor({ lines, onChange, accounts }: Props) {
  const totals = editorTotals(lines);
  const options = accounts.filter((a) => a.isPostable && a.isActive && a.bankAccountKind === null);

  function updateLine(index: number, patch: Partial<EditorLine>) {
    onChange(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm min-w-[44rem]">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className="p-3 font-medium">Description</th>
              <th className="p-3 font-medium">Account</th>
              <th className="p-3 font-medium w-32 text-right">Debit</th>
              <th className="p-3 font-medium w-32 text-right">Credit</th>
              <th className="p-3 w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index} className="border-t border-[var(--border)]">
                <td className="p-2">
                  <input
                    type="text"
                    value={line.description}
                    onChange={(e) => updateLine(index, { description: e.target.value })}
                    maxLength={500}
                    aria-label={`Description for line ${String(index + 1)}`}
                    className={inputClass}
                  />
                </td>
                <td className="p-2">
                  <select
                    value={line.accountId}
                    onChange={(e) => updateLine(index, { accountId: e.target.value })}
                    className={inputClass}
                    aria-label={`Account for line ${String(index + 1)}`}
                  >
                    <option value="">Select an account…</option>
                    {options.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} · {account.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="p-2">
                  <input
                    inputMode="decimal"
                    value={line.debit}
                    // One side per line, enforced by clearing the other.
                    onChange={(e) => updateLine(index, { debit: e.target.value, credit: '' })}
                    placeholder="0.00"
                    aria-label={`Debit for line ${String(index + 1)}`}
                    className={`${inputClass} text-right tabular-nums`}
                  />
                </td>
                <td className="p-2">
                  <input
                    inputMode="decimal"
                    value={line.credit}
                    onChange={(e) => updateLine(index, { credit: e.target.value, debit: '' })}
                    placeholder="0.00"
                    aria-label={`Credit for line ${String(index + 1)}`}
                    className={`${inputClass} text-right tabular-nums`}
                  />
                </td>
                <td className="p-2 text-center">
                  <button
                    type="button"
                    disabled={lines.length <= 1}
                    onClick={() => onChange(lines.filter((_, i) => i !== index))}
                    aria-label={`Remove line ${String(index + 1)}`}
                    className="text-[var(--muted)] hover:text-[var(--bad)] disabled:opacity-30 disabled:cursor-not-allowed bg-transparent border-0 cursor-pointer p-1"
                  >
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[var(--border)] font-medium">
              <td className="p-3" colSpan={2}>
                <div className="flex items-center gap-4 flex-wrap">
                  <button
                    type="button"
                    onClick={() => onChange([...lines, emptyLine()])}
                    className="flex items-center gap-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border-0 cursor-pointer p-0"
                  >
                    <Plus size={15} /> Add line
                  </button>
                  {totals.malformed && (
                    <span className="text-sm text-[var(--bad)]">
                      Amounts take at most two decimal places.
                    </span>
                  )}
                  {!totals.malformed && !totals.balanced && (
                    <span className="text-sm text-[var(--bad)] tabular-nums">
                      Out of balance by {formatCents(Math.abs(totals.debits - totals.credits))}
                    </span>
                  )}
                  {totals.balanced && totals.debits > 0 && (
                    <span className="text-sm text-[var(--good)]">Balanced</span>
                  )}
                </div>
              </td>
              <td className="p-3 text-right tabular-nums">{formatCents(totals.debits)}</td>
              <td className="p-3 text-right tabular-nums">{formatCents(totals.credits)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-xs text-[var(--muted)] m-0">
        Bank, credit card, receivable, payable and inventory accounts can't take manual journals — use
        Banking, invoices, bills or Inventory.
      </p>
    </div>
  );
}
