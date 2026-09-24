import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import {
  ApiRequestError,
  createMigrationImport,
  getInvoiceSettings,
  listAccounts,
  updateLedgerSettings,
  type Account,
  type InvoiceSettings,
} from '../../services/fetchServices';
import { formatCents, parseCentsInput } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import { useLedgerSettings } from './LedgerSettingsContext';
import { IMPORT_TEMPLATES, csvField } from './importTemplates';
import SettingsTabs from './SettingsTabs';

/**
 * Phase 30 — the Conversion balances tab: a Xero-style opening-balance grid.
 *
 * Zero new endpoints. This page is a client-side form over the staged
 * migration importer that already exists (Phase 9b): it builds an
 * `OPENING_BALANCES` CSV in memory, stages it with the existing
 * `createMigrationImport`, then hands off to the existing
 * validate/preview/commit flow on `MigrationImportDetailPage` — it does not
 * reimplement any of that.
 *
 * The money bridge (rule 3): the grid holds every amount as integer cents,
 * produced only by `parseCentsInput` on typed text. Each CSV cell is built
 * with `formatCents(cents)`, which yields a decimal string like "500.00" —
 * the shape the server's `parseMoneyText` expects for this column. The two
 * functions are exact inverses at the string boundary
 * (`formatCents(50000) === '500.00'`, and `parseMoneyText('500.00')` is
 * 50000 cents again) — never `String(cents)`, which would hand the server a
 * raw integer-cents string and desync the amount by two orders of magnitude.
 *
 * Retained Earnings (account code 3200) and the AR/AP control accounts (the
 * receivable account is `invoiceSettings.receivableAccountId` when the org
 * has configured one, falling back to code 1120; the payable account is
 * always code 2100 — `ledger_settings.payable_account_id` is never written by
 * any route or schema today, so the server's own fallback is the account in
 * every real case) are never offered as options in any account select here —
 * filtered out entirely rather than selected and then refused, which is what
 * `openingBalanceImportService.validateRows`'s `loadRefusedAccounts` would
 * reject anyway. The one refusal that stays inline is a row that carries
 * both a debit and a credit — a data-entry mistake, not an account-selection
 * problem.
 */

interface DraftRow {
  id: string;
  accountId: string;
  debit: string;
  credit: string;
}

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full disabled:opacity-50';
const primaryButtonClass =
  'px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed';
const ghostButtonClass =
  'flex items-center gap-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border-0 cursor-pointer p-0 disabled:opacity-40 disabled:cursor-not-allowed';

function parsedRow(row: DraftRow): { debit: number; credit: number; malformed: boolean } {
  const debit = parseCentsInput(row.debit);
  const credit = parseCentsInput(row.credit);
  if (debit === null || credit === null) return { debit: 0, credit: 0, malformed: true };
  return { debit, credit, malformed: false };
}

export default function ConversionBalancesPage() {
  const base = useAppBasePath();
  const navigate = useNavigate();
  const ledgerSettings = useLedgerSettings();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [invoiceSettings, setInvoiceSettings] = useState<InvoiceSettings | null>(null);

  const [conversionDate, setConversionDate] = useState('');
  const [dateSeeded, setDateSeeded] = useState(false);
  const [dateSaving, setDateSaving] = useState(false);
  const [dateSaved, setDateSaved] = useState(false);
  const [dateError, setDateError] = useState<string | null>(null);
  const [dateNeedsOnboarding, setDateNeedsOnboarding] = useState(false);

  const [rows, setRows] = useState<DraftRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const nextRowId = useRef(0);
  function newRowId(): string {
    nextRowId.current += 1;
    return `row-${String(nextRowId.current)}`;
  }

  useEffect(() => {
    let ignore = false;
    listAccounts()
      .then((response) => {
        if (!ignore) setAccounts(response.accounts);
      })
      .catch(() => {
        // The grid is simply empty of options; the rest of the page still works.
      });
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    getInvoiceSettings()
      .then((settings) => {
        if (!ignore) setInvoiceSettings(settings);
      })
      .catch(() => {
        // Falls back to the code-1120 receivable lookup below.
      });
    return () => {
      ignore = true;
    };
  }, []);

  // Seed the conversion date once, after settings load — same pattern as
  // FinancialSettingsPage.
  useEffect(() => {
    if (ledgerSettings.status === 'ready' && !dateSeeded) {
      setConversionDate(ledgerSettings.settings.booksStartDate);
      setDateSeeded(true);
    }
  }, [ledgerSettings, dateSeeded]);

  const excludedIds = useMemo(() => {
    const byCode = new Map(accounts.map((a) => [a.code, a.id]));
    const ids = new Set<string>();

    const retainedEarningsId = byCode.get('3200');
    if (retainedEarningsId !== undefined) ids.add(retainedEarningsId);

    const receivableAccountId = invoiceSettings?.receivableAccountId ?? byCode.get('1120') ?? null;
    if (receivableAccountId !== null) ids.add(receivableAccountId);

    const payableAccountId = byCode.get('2100');
    if (payableAccountId !== undefined) ids.add(payableAccountId);

    return ids;
  }, [accounts, invoiceSettings]);

  const eligibleAccounts = useMemo(
    () => accounts.filter((a) => a.isPostable && a.isActive && !excludedIds.has(a.id)),
    [accounts, excludedIds],
  );

  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  function optionsFor(currentAccountId: string): Account[] {
    return accounts.filter(
      (a) => a.id === currentAccountId || eligibleAccounts.some((e) => e.id === a.id),
    );
  }

  function addRow() {
    setRows((current) => [...current, { id: newRowId(), accountId: '', debit: '', credit: '' }]);
  }

  function removeRow(id: string) {
    setRows((current) => current.filter((r) => r.id !== id));
  }

  function updateRow(id: string, patch: Partial<DraftRow>) {
    setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function handleLoadChart() {
    setRows(eligibleAccounts.map((a) => ({ id: newRowId(), accountId: a.id, debit: '', credit: '' })));
  }

  const totals = useMemo(() => {
    let debits = 0;
    let credits = 0;
    let malformed = false;
    let hasBothSides = false;

    for (const row of rows) {
      const parsed = parsedRow(row);
      if (parsed.malformed) {
        malformed = true;
        continue;
      }
      if (parsed.debit > 0 && parsed.credit > 0) {
        hasBothSides = true;
        continue;
      }
      debits += parsed.debit;
      credits += parsed.credit;
    }

    return { debits, credits, malformed, hasBothSides, balanced: !malformed && debits === credits };
  }, [rows]);

  const canSave =
    !totals.malformed &&
    !totals.hasBothSides &&
    totals.balanced &&
    totals.debits > 0 &&
    !submitting;

  async function handleSaveDate() {
    setDateSaving(true);
    setDateSaved(false);
    setDateError(null);
    setDateNeedsOnboarding(false);
    try {
      const next = await updateLedgerSettings({ booksStartDate: conversionDate });
      ledgerSettings.applySettings(next);
      setDateSaved(true);
    } catch (err) {
      setDateError(err instanceof Error ? err.message : 'Could not save the conversion date');
      setDateNeedsOnboarding(err instanceof ApiRequestError && err.status === 409);
    } finally {
      setDateSaving(false);
    }
  }

  async function handleSaveAndReview() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const header = IMPORT_TEMPLATES.OPENING_BALANCES.columns.map((c) => csvField(c.header)).join(',');
      const csvRows: string[] = [];
      for (const row of rows) {
        const parsed = parsedRow(row);
        if (parsed.malformed || (parsed.debit === 0 && parsed.credit === 0)) continue;
        const code = accountsById.get(row.accountId)?.code ?? '';
        csvRows.push(
          [csvField(code), csvField(formatCents(parsed.debit)), csvField(formatCents(parsed.credit))].join(','),
        );
      }
      const content = `${header}\n${csvRows.join('\n')}\n`;

      const res = await createMigrationImport({
        kind: 'OPENING_BALANCES',
        fileName: 'conversion-balances.csv',
        content,
      });
      navigate(`${base}/migration-imports/${res.import.id}`, { replace: true });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not stage the import');
      setSubmitting(false);
    }
  }

  if (ledgerSettings.status !== 'ready') {
    return (
      <section className="flex flex-col gap-4 max-w-4xl">
        <SettingsTabs />
        <div aria-busy="true" className="flex flex-col gap-3">
          <div className="skeleton skeleton--card" />
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6 max-w-4xl">
      <header>
        <h2 className="text-lg font-semibold m-0">Settings</h2>
      </header>

      <SettingsTabs />

      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold m-0">Conversion date</h3>
        <div className="flex items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Conversion date</span>
            <input
              type="date"
              value={conversionDate}
              onChange={(e) => setConversionDate(e.target.value)}
              className={inputClass}
            />
          </label>
          <button
            type="button"
            className={primaryButtonClass}
            disabled={dateSaving}
            onClick={() => void handleSaveDate()}
          >
            {dateSaving ? 'Saving…' : 'Save date'}
          </button>
        </div>
        <span className="text-xs text-[var(--muted)]">Balances below are entered as at this date.</span>
        {dateError !== null && (
          <p className="status status--bad">
            {dateError}
            {dateNeedsOnboarding && (
              <>
                {' '}
                <a href={`${base}/onboarding`}>Open the setup wizard</a>
              </>
            )}
          </p>
        )}
        {dateSaved && dateError === null && <p className="status status--good">Saved.</p>}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-base font-semibold m-0">Opening balances</h3>
          <button type="button" onClick={handleLoadChart} className={ghostButtonClass}>
            Load chart
          </button>
        </div>
        <p className="text-sm text-[var(--muted)] m-0">
          Retained earnings and the AR/AP control accounts open from real documents, not a lump balance, so they
          are not listed here.
        </p>

        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[34rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Account</th>
                <th className="p-3 font-medium w-32 text-right">Debit</th>
                <th className="p-3 font-medium w-32 text-right">Credit</th>
                <th className="p-3 w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const parsed = parsedRow(row);
                const bothSides = !parsed.malformed && parsed.debit > 0 && parsed.credit > 0;
                return (
                  <tr key={row.id} className="border-t border-[var(--border)]">
                    <td className="p-2">
                      <select
                        value={row.accountId}
                        onChange={(e) => updateRow(row.id, { accountId: e.target.value })}
                        className={inputClass}
                        aria-label={`Account for row ${String(index + 1)}`}
                      >
                        <option value="">Select an account…</option>
                        {optionsFor(row.accountId).map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.code} · {account.name}
                          </option>
                        ))}
                      </select>
                      {bothSides && (
                        <p className="status status--bad text-xs m-0 mt-1">
                          A row carries a debit or a credit, not both.
                        </p>
                      )}
                    </td>
                    <td className="p-2">
                      <input
                        inputMode="decimal"
                        value={row.debit}
                        onChange={(e) => updateRow(row.id, { debit: e.target.value })}
                        placeholder="0.00"
                        aria-label={`Debit for row ${String(index + 1)}`}
                        className={`${inputClass} text-right tabular-nums`}
                      />
                    </td>
                    <td className="p-2">
                      <input
                        inputMode="decimal"
                        value={row.credit}
                        onChange={(e) => updateRow(row.id, { credit: e.target.value })}
                        placeholder="0.00"
                        aria-label={`Credit for row ${String(index + 1)}`}
                        className={`${inputClass} text-right tabular-nums`}
                      />
                    </td>
                    <td className="p-2 text-center">
                      <button
                        type="button"
                        onClick={() => removeRow(row.id)}
                        aria-label={`Remove row ${String(index + 1)}`}
                        className="text-[var(--muted)] hover:text-[var(--bad)] bg-transparent border-0 cursor-pointer p-1"
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[var(--border)] font-medium">
                <td className="p-3">
                  <button type="button" onClick={addRow} className={ghostButtonClass}>
                    <Plus size={15} /> Add row
                  </button>
                </td>
                <td className="p-3 text-right tabular-nums">{formatCents(totals.debits)}</td>
                <td className="p-3 text-right tabular-nums">{formatCents(totals.credits)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="flex items-center gap-4 flex-wrap">
          <button
            type="button"
            disabled={!canSave}
            onClick={() => void handleSaveAndReview()}
            className={primaryButtonClass}
          >
            {submitting ? 'Staging…' : 'Save and review'}
          </button>

          {totals.malformed && (
            <span className="text-sm text-[var(--bad)]">Amounts take at most two decimal places.</span>
          )}
          {!totals.malformed && !totals.balanced && (
            <span className="text-sm text-[var(--bad)] tabular-nums">
              Out of balance by {formatCents(Math.abs(totals.debits - totals.credits))}
            </span>
          )}
          {totals.balanced && totals.debits > 0 && !totals.hasBothSides && (
            <span className="text-sm text-[var(--good)]">Balanced</span>
          )}
        </div>

        {submitError !== null && <p className="status status--bad">{submitError}</p>}
      </div>
    </section>
  );
}
