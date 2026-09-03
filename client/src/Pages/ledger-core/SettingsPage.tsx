import { useEffect, useState } from 'react';
import { useOrg } from '../../context/OrgContext';
import { useAuthActions } from '../../context/AuthContext';
import { updateLedgerSettings, updateOrganization } from '../../services/fetchServices';
import { useLedgerSettings } from './LedgerSettingsContext';
import { fiscalYearBounds } from './fiscalYear';
import SettingsTabs from './SettingsTabs';

/**
 * A flat form over the same fields the onboarding wizard collects.
 *
 * Two calls on save, not one: organization name and base currency are
 * platform fields (`PATCH /organizations`), while the rest are LedgerCore's
 * own (`PATCH /ledger-core/settings`) — see docs/architecture.md's
 * platform/app split.
 *
 * `AuthContext` has no setter for "just the organization" — only
 * `applySession` with a full `SessionResponse`. Rather than fabricate one,
 * `refreshNow()` re-issues the session through the existing
 * `POST /auth/refresh` round trip, which rebuilds it from the database and
 * therefore picks up the renamed organization. `applySettings` updates the
 * LedgerCore-owned fields in place, no round trip needed.
 */

const CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'INR',
  'CAD',
  'AUD',
  'JPY',
  'SGD',
  'AED',
  'CHF',
  'NZD',
  'ZAR',
] as const;

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

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full disabled:opacity-50';
const primaryButtonClass =
  'px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed';

export default function SettingsPage() {
  const { organization } = useOrg();
  const { refreshNow } = useAuthActions();
  const ledgerSettings = useLedgerSettings();

  const [name, setName] = useState(organization?.name ?? '');
  const [baseCurrency, setBaseCurrency] = useState('USD');
  const [legalName, setLegalName] = useState('');
  const [fiscalYearStartMonth, setFiscalYearStartMonth] = useState(1);
  const [fiscalYearStartDay, setFiscalYearStartDay] = useState(1);
  const [industry, setIndustry] = useState('');
  const [taxNumber, setTaxNumber] = useState('');
  const [businessNumber, setBusinessNumber] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [seeded, setSeeded] = useState(false);

  // Seeds the form once the settings load, rather than reading them at
  // `useState` initialization time — `ledgerSettings` is a discriminated
  // union, and `.settings` only exists once `status === 'ready'`, which is
  // not yet true on the render where these hooks first run.
  useEffect(() => {
    if (ledgerSettings.status === 'ready' && !seeded) {
      const { settings } = ledgerSettings;
      setBaseCurrency(settings.baseCurrency);
      setLegalName(settings.legalName ?? '');
      setFiscalYearStartMonth(settings.fiscalYearStartMonth);
      setFiscalYearStartDay(settings.fiscalYearStartDay);
      setIndustry(settings.industry ?? '');
      setTaxNumber(organization?.taxNumber ?? '');
      setBusinessNumber(organization?.businessNumber ?? '');
      setSeeded(true);
    }
  }, [ledgerSettings, seeded, organization]);

  if (ledgerSettings.status !== 'ready') {
    return (
      <div aria-busy="true" className="flex flex-col gap-3">
        <div className="skeleton skeleton--card" />
      </div>
    );
  }

  const { settings, applySettings } = ledgerSettings;
  const derivedFiscalYear = fiscalYearBounds(fiscalYearStartMonth, fiscalYearStartDay, new Date().toISOString().slice(0, 10));

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateOrganization({
        name,
        baseCurrency,
        taxNumber: taxNumber.trim() === '' ? null : taxNumber.trim(),
        businessNumber: businessNumber.trim() === '' ? null : businessNumber.trim(),
      });
      await refreshNow();

      const nextSettings = await updateLedgerSettings({
        legalName: legalName.trim() === '' ? null : legalName.trim(),
        fiscalYearStartMonth,
        fiscalYearStartDay,
        industry: industry === '' ? null : industry,
      });
      applySettings(nextSettings);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 max-w-xl">
      <header>
        <h2 className="text-lg font-semibold m-0">Settings</h2>
      </header>

      <SettingsTabs />

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Organization name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          minLength={2}
          maxLength={120}
          className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Legal name</span>
        <input
          type="text"
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
          maxLength={200}
          className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Base currency</span>
        <select
          value={baseCurrency}
          onChange={(e) => setBaseCurrency(e.target.value)}
          disabled={settings.baseCurrencyLocked}
          className={inputClass}
        >
          {CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
        {settings.baseCurrencyLocked && (
          <span className="text-xs text-[var(--muted)]">
            Locked — journal entries already exist in this currency. Changing it would invalidate
            every posted line.
          </span>
        )}
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Industry</span>
        <input
          type="text"
          value={industry}
          onChange={(e) => setIndustry(e.target.value)}
          maxLength={80}
          className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Tax registration number</span>
        <input
          type="text"
          value={taxNumber}
          onChange={(e) => setTaxNumber(e.target.value)}
          maxLength={64}
          className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Business registration number</span>
        <input
          type="text"
          value={businessNumber}
          onChange={(e) => setBusinessNumber(e.target.value)}
          maxLength={64}
          className={inputClass}
        />
        <span className="text-xs text-[var(--muted)]">Also editable from your account settings.</span>
      </label>

      <div className="flex gap-3">
        <label className="flex flex-col gap-1 text-sm flex-1">
          <span className="text-[var(--muted)]">Fiscal year starts in</span>
          <select
            value={fiscalYearStartMonth}
            onChange={(e) => setFiscalYearStartMonth(Number(e.target.value))}
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
          <input
            type="number"
            min={1}
            max={28}
            value={fiscalYearStartDay}
            onChange={(e) => setFiscalYearStartDay(Number(e.target.value))}
            className={inputClass}
          />
        </label>
      </div>

      <p className="text-sm text-[var(--muted)] m-0">
        This fiscal year runs <strong>{derivedFiscalYear.startDate}</strong> to{' '}
        <strong>{derivedFiscalYear.endDate}</strong> ({derivedFiscalYear.label}).
      </p>

      {error !== null && <p className="status status--bad">{error}</p>}
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
