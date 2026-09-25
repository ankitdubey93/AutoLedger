import { useEffect, useState } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useOrg } from '../../context/OrgContext';
import { useAuthActions } from '../../context/AuthContext';
import { updateLedgerSettings, updateOrganization } from '../../services/fetchServices';
import { useLedgerSettings } from '../../context/LedgerSettingsContext';
import SettingsTabs from './SettingsTabs';
import PageHeader from '../../components/ui/PageHeader';
import { inputClass, primaryButtonClass } from '../../components/ui/formClasses';

/**
 * A flat form over the organization-identity fields the onboarding wizard
 * collects. The fiscal-year controls moved to the Financial tab in Phase 30.
 *
 * Two calls on save, not one: organization name and base currency are
 * platform fields (`PATCH /organizations`), while the rest are Accounting's
 * own (`PATCH /settings`) — see docs/architecture.md's
 * platform/app split.
 *
 * `AuthContext` has no setter for "just the organization" — only
 * `applySession` with a full `SessionResponse`. Rather than fabricate one,
 * `refreshNow()` re-issues the session through the existing
 * `POST /auth/refresh` round trip, which rebuilds it from the database and
 * therefore picks up the renamed organization. `applySettings` updates the
 * Accounting-owned fields in place, no round trip needed.
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

export default function GeneralSettingsPage() {
  const { organization } = useOrg();
  const { refreshNow } = useAuthActions();
  const ledgerSettings = useLedgerSettings();

  const [name, setName] = useState(organization?.name ?? '');
  const [baseCurrency, setBaseCurrency] = useState('USD');
  const [legalName, setLegalName] = useState('');
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
    <section className="flex flex-col gap-4">
      <PageHeader as="h2" icon={SettingsIcon} title="Settings" />

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

      <p className="text-sm text-[var(--muted)] m-0">
        <Link to="/account">Address, contact details and logo are on your account's Organisation page.</Link>
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
