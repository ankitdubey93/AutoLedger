import { useEffect, useState } from 'react';
import { Landmark } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  ApiRequestError,
  getFiscalPeriods,
  listAccounts,
  updateLedgerSettings,
  type Account,
  type AccountType,
  type FiscalPeriodStatus,
} from '../../services/fetchServices';
import { fiscalYearBounds } from '../accounting/fiscalYear';
import { useLedgerSettings } from '../../context/LedgerSettingsContext';
import SettingsTabs from './SettingsTabs';
import PageHeader from '../../components/ui/PageHeader';
import { inputClass, primaryButtonClass } from '../../components/ui/formClasses';

/**
 * Phase 30 — the Financial tab: fiscal year, books start date and the default
 * posting accounts. Every field here is Accounting's own, so the whole tab is
 * one `PATCH /settings`.
 *
 * The financial year END is never stored. `fiscalYearBounds` derives it from
 * the start month/day, which is the single source of truth — the read-only
 * line below is a computation, not a field.
 *
 * Fiscal periods are shown as counts only; generating, closing and locking
 * stay on FiscalPeriodsPage, where the period FSM lives (rule 10).
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DAYS = Array.from({ length: 28 }, (_, index) => index + 1);

/** `2027-03-31` → `31 March 2027`. Parsed from the string, never `new Date(iso)` (local-midnight shift). */
function formatLongDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  const monthName = month === undefined ? undefined : MONTHS[month - 1];
  if (year === undefined || day === undefined || monthName === undefined) return iso;
  return `${String(day)} ${monthName} ${String(year)}`;
}

interface PeriodCounts {
  OPEN: number;
  CLOSED: number;
  LOCKED: number;
}

interface AccountSelectProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  accounts: Account[];
  /** `null` shows every postable account — used where the plan could not name a single type. */
  type: AccountType | null;
  hint?: string;
}

function AccountSelect({ label, value, onChange, accounts, type, hint }: AccountSelectProps) {
  const options = accounts.filter(
    (account) =>
      account.id === value || (account.isPostable && account.isActive && (type === null || account.type === type)),
  );

  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-[var(--muted)]">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        <option value="">Not set</option>
        {options.map((account) => (
          <option key={account.id} value={account.id}>
            {account.code} {account.name}
          </option>
        ))}
      </select>
      {hint !== undefined && <span className="text-xs text-[var(--muted)]">{hint}</span>}
    </label>
  );
}

export default function FinancialSettingsPage() {
  const ledgerSettings = useLedgerSettings();

  const [startMonth, setStartMonth] = useState(1);
  const [startDay, setStartDay] = useState(1);
  const [booksStartDate, setBooksStartDate] = useState('');
  const [cashAccountId, setCashAccountId] = useState('');
  const [realizedGainId, setRealizedGainId] = useState('');
  const [realizedLossId, setRealizedLossId] = useState('');
  const [unrealizedId, setUnrealizedId] = useState('');
  const [seeded, setSeeded] = useState(false);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [periodCounts, setPeriodCounts] = useState<PeriodCounts | null>(null);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  // Seed once, after the settings load — `.settings` only exists on the
  // `ready` arm of the union (same pattern as GeneralSettingsPage).
  useEffect(() => {
    if (ledgerSettings.status === 'ready' && !seeded) {
      const { settings } = ledgerSettings;
      setStartMonth(settings.fiscalYearStartMonth);
      setStartDay(settings.fiscalYearStartDay);
      setBooksStartDate(settings.booksStartDate);
      setCashAccountId(settings.cashAccountId ?? '');
      setRealizedGainId(settings.realizedFxGainAccountId ?? '');
      setRealizedLossId(settings.realizedFxLossAccountId ?? '');
      setUnrealizedId(settings.unrealizedFxAccountId ?? '');
      setSeeded(true);
    }
  }, [ledgerSettings, seeded]);

  useEffect(() => {
    let ignore = false;
    listAccounts()
      .then((response) => {
        if (!ignore) setAccounts(response.accounts);
      })
      .catch(() => {
        // Selects simply stay empty; the page is still usable for the fiscal year.
      });
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    getFiscalPeriods()
      .then((response) => {
        if (ignore) return;
        const counts: PeriodCounts = { OPEN: 0, CLOSED: 0, LOCKED: 0 };
        for (const period of response.periods) {
          const status: FiscalPeriodStatus = period.status;
          counts[status] += 1;
        }
        setPeriodCounts(counts);
      })
      .catch(() => {
        // A failed read shows nothing rather than an error — the counts are context, not a control.
      });
    return () => {
      ignore = true;
    };
  }, []);

  if (ledgerSettings.status !== 'ready') {
    return (
      <section className="flex flex-col gap-4">
        <SettingsTabs />
        <div aria-busy="true" className="flex flex-col gap-3">
          <div className="skeleton skeleton--card" />
        </div>
      </section>
    );
  }

  const { applySettings } = ledgerSettings;
  const derivedFiscalYear = fiscalYearBounds(startMonth, startDay, new Date().toISOString().slice(0, 10));

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    setNeedsOnboarding(false);
    try {
      const next = await updateLedgerSettings({
        fiscalYearStartMonth: startMonth,
        fiscalYearStartDay: startDay,
        booksStartDate,
        cashAccountId: cashAccountId === '' ? null : cashAccountId,
        realizedFxGainAccountId: realizedGainId === '' ? null : realizedGainId,
        realizedFxLossAccountId: realizedLossId === '' ? null : realizedLossId,
        unrealizedFxAccountId: unrealizedId === '' ? null : unrealizedId,
      });
      applySettings(next);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings');
      setNeedsOnboarding(err instanceof ApiRequestError && err.status === 409);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <PageHeader as="h2" icon={Landmark} title="Settings" />

      <SettingsTabs />

      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold m-0">Fiscal year</h3>
        <div className="flex gap-3">
          <label className="flex flex-col gap-1 text-sm flex-1">
            <span className="text-[var(--muted)]">Fiscal year starts in</span>
            <select
              value={startMonth}
              onChange={(e) => setStartMonth(Number(e.target.value))}
              className={inputClass}
            >
              {MONTHS.map((monthName, index) => (
                <option key={monthName} value={index + 1}>
                  {monthName}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm w-24">
            <span className="text-[var(--muted)]">Day</span>
            <select value={startDay} onChange={(e) => setStartDay(Number(e.target.value))} className={inputClass}>
              {DAYS.map((day) => (
                <option key={day} value={day}>
                  {day}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-sm text-[var(--muted)] m-0">
          Financial year end: <strong>{formatLongDate(derivedFiscalYear.endDate)}</strong> ({derivedFiscalYear.label})
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold m-0">Books start date</h3>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Books start date</span>
          <input
            type="date"
            value={booksStartDate}
            onChange={(e) => setBooksStartDate(e.target.value)}
            className={inputClass}
          />
          <span className="text-xs text-[var(--muted)]">Opening balances post as at this date.</span>
        </label>
        <p className="text-sm m-0">
          <Link to="/settings/conversion-balances">Enter conversion balances</Link>
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold m-0">Default posting accounts</h3>
        <AccountSelect
          label="Cash account"
          value={cashAccountId}
          onChange={setCashAccountId}
          accounts={accounts}
          type="Asset"
        />
        <AccountSelect
          label="Realized FX gain account"
          value={realizedGainId}
          onChange={setRealizedGainId}
          accounts={accounts}
          type="Revenue"
        />
        <AccountSelect
          label="Realized FX loss account"
          value={realizedLossId}
          onChange={setRealizedLossId}
          accounts={accounts}
          type="Expense"
        />
        <AccountSelect
          label="Unrealized FX account"
          value={unrealizedId}
          onChange={setUnrealizedId}
          accounts={accounts}
          type={null}
          hint="Revaluation posts either a gain or a loss here, so any postable account is offered."
        />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-base font-semibold m-0">Fiscal periods</h3>
        {periodCounts !== null && (
          <p className="text-sm text-[var(--muted)] m-0">
            {periodCounts.OPEN} open · {periodCounts.CLOSED} closed · {periodCounts.LOCKED} locked
          </p>
        )}
        <p className="text-sm m-0">
          <Link to="/fiscal-periods">Manage fiscal periods</Link>
        </p>
      </div>

      {error !== null && (
        <p className="status status--bad">
          {error}
          {needsOnboarding && (
            <>
              {' '}
              <Link to="/onboarding">Open the setup wizard</Link>
            </>
          )}
        </p>
      )}
      {saved && error === null && <p className="status status--good">Saved.</p>}

      <div>
        <button
          type="button"
          className={primaryButtonClass}
          disabled={saving}
          onClick={() => void handleSave()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}
