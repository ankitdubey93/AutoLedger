import { useEffect, useState } from 'react';
import {
  getInvoiceSettings,
  listAccounts,
  updateInvoiceSettings,
  type Account,
} from '../../services/fetchServices';
import { formatRate, parseRateInput } from './money';
import SettingsTabs from './SettingsTabs';

/**
 * Invoice numbering, defaults, and branding — read with sensible defaults
 * before the organization has ever saved one (`configured: false`), written
 * as a single PATCH.
 */

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full disabled:opacity-50';

function accountOptions(accounts: Account[], type: Account['type']) {
  return accounts.filter((a) => a.isPostable && a.type === type);
}

export default function InvoiceSettingsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [numberPrefix, setNumberPrefix] = useState('');
  const [numberPadding, setNumberPadding] = useState(6);
  const [nextNumber, setNextNumber] = useState(1);
  const [defaultDueDays, setDefaultDueDays] = useState(30);
  const [defaultTaxRate, setDefaultTaxRate] = useState('');
  const [taxLabel, setTaxLabel] = useState('Tax');
  const [receivableAccountId, setReceivableAccountId] = useState('');
  const [defaultRevenueAccountId, setDefaultRevenueAccountId] = useState('');
  const [taxPayableAccountId, setTaxPayableAccountId] = useState('');
  const [showLegalName, setShowLegalName] = useState(true);
  const [showTaxNumber, setShowTaxNumber] = useState(true);
  const [showBusinessNumber, setShowBusinessNumber] = useState(false);
  const [billingAddress, setBillingAddress] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [footerNotes, setFooterNotes] = useState('');
  const [accentColor, setAccentColor] = useState('#2563eb');

  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let ignore = false;

    Promise.all([getInvoiceSettings(), listAccounts()])
      .then(([settingsRes, accountsRes]) => {
        if (ignore) return;
        setAccounts(accountsRes.accounts);
        setNumberPrefix(settingsRes.numberPrefix);
        setNumberPadding(settingsRes.numberPadding);
        setNextNumber(settingsRes.nextNumber);
        setDefaultDueDays(settingsRes.defaultDueDays);
        setDefaultTaxRate(settingsRes.defaultTaxRateBp === 0 ? '' : formatRate(settingsRes.defaultTaxRateBp));
        setTaxLabel(settingsRes.taxLabel);
        setReceivableAccountId(settingsRes.receivableAccountId ?? '');
        setDefaultRevenueAccountId(settingsRes.defaultRevenueAccountId ?? '');
        setTaxPayableAccountId(settingsRes.taxPayableAccountId ?? '');
        setShowLegalName(settingsRes.showLegalName);
        setShowTaxNumber(settingsRes.showTaxNumber);
        setShowBusinessNumber(settingsRes.showBusinessNumber);
        setBillingAddress(settingsRes.billingAddress ?? '');
        setPaymentTerms(settingsRes.paymentTerms ?? '');
        setFooterNotes(settingsRes.footerNotes ?? '');
        setAccentColor(settingsRes.accentColor);
        setSeeded(true);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load invoice settings');
      });

    return () => {
      ignore = true;
    };
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateInvoiceSettings({
        numberPrefix,
        numberPadding,
        nextNumber,
        defaultDueDays,
        defaultTaxRateBp: defaultTaxRate.trim() === '' ? 0 : (parseRateInput(defaultTaxRate) ?? 0),
        taxLabel,
        receivableAccountId: receivableAccountId === '' ? null : receivableAccountId,
        defaultRevenueAccountId: defaultRevenueAccountId === '' ? null : defaultRevenueAccountId,
        taxPayableAccountId: taxPayableAccountId === '' ? null : taxPayableAccountId,
        showLegalName,
        showTaxNumber,
        showBusinessNumber,
        billingAddress: billingAddress.trim() === '' ? null : billingAddress.trim(),
        paymentTerms: paymentTerms.trim() === '' ? null : paymentTerms.trim(),
        footerNotes: footerNotes.trim() === '' ? null : footerNotes.trim(),
        accentColor,
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save invoice settings');
    } finally {
      setSaving(false);
    }
  }

  if (!seeded) {
    return (
      <div aria-busy="true" className="flex flex-col gap-3">
        <div className="skeleton skeleton--card" />
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-4 max-w-xl">
      <header>
        <h2 className="text-lg font-semibold m-0">Invoice settings</h2>
      </header>

      <SettingsTabs />

      <fieldset className="flex flex-col gap-3 border border-[var(--border)] rounded-lg p-4">
        <legend className="text-sm font-semibold px-1">Numbering</legend>

        <div className="flex gap-3">
          <label className="flex flex-col gap-1 text-sm flex-1">
            <span className="text-[var(--muted)]">Prefix</span>
            <input
              type="text"
              value={numberPrefix}
              onChange={(e) => setNumberPrefix(e.target.value)}
              maxLength={12}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm w-28">
            <span className="text-[var(--muted)]">Digits</span>
            <input
              type="number"
              min={1}
              max={12}
              value={numberPadding}
              onChange={(e) => setNumberPadding(Number(e.target.value))}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm w-28">
            <span className="text-[var(--muted)]">Next</span>
            <input
              type="number"
              min={1}
              value={nextNumber}
              onChange={(e) => setNextNumber(Number(e.target.value))}
              className={inputClass}
            />
          </label>
        </div>

        <p className="text-xs text-[var(--muted)] m-0">
          Next invoice will be numbered {numberPrefix}
          {String(nextNumber).padStart(numberPadding, '0')}.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-3 border border-[var(--border)] rounded-lg p-4">
        <legend className="text-sm font-semibold px-1">Defaults</legend>

        <div className="flex gap-3">
          <label className="flex flex-col gap-1 text-sm flex-1">
            <span className="text-[var(--muted)]">Default due days</span>
            <input
              type="number"
              min={0}
              max={365}
              value={defaultDueDays}
              onChange={(e) => setDefaultDueDays(Number(e.target.value))}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm flex-1">
            <span className="text-[var(--muted)]">Default tax rate %</span>
            <input
              inputMode="decimal"
              value={defaultTaxRate}
              onChange={(e) => setDefaultTaxRate(e.target.value)}
              placeholder="0"
              className={inputClass}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Tax label</span>
          <input
            type="text"
            value={taxLabel}
            onChange={(e) => setTaxLabel(e.target.value)}
            maxLength={24}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Receivable account</span>
          <select
            value={receivableAccountId}
            onChange={(e) => setReceivableAccountId(e.target.value)}
            className={inputClass}
          >
            <option value="">Auto (1120)</option>
            {accountOptions(accounts, 'Asset').map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Default revenue account</span>
          <select
            value={defaultRevenueAccountId}
            onChange={(e) => setDefaultRevenueAccountId(e.target.value)}
            className={inputClass}
          >
            <option value="">Auto (4100)</option>
            {accountOptions(accounts, 'Revenue').map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Tax payable account</span>
          <select
            value={taxPayableAccountId}
            onChange={(e) => setTaxPayableAccountId(e.target.value)}
            className={inputClass}
          >
            <option value="">Auto (2140)</option>
            {accountOptions(accounts, 'Liability').map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-3 border border-[var(--border)] rounded-lg p-4">
        <legend className="text-sm font-semibold px-1">Appearance &amp; disclosure</legend>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showLegalName} onChange={(e) => setShowLegalName(e.target.checked)} />
          Show legal name
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showTaxNumber} onChange={(e) => setShowTaxNumber(e.target.checked)} />
          Show tax registration number
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showBusinessNumber}
            onChange={(e) => setShowBusinessNumber(e.target.checked)}
          />
          Show business registration number
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Billing address</span>
          <textarea
            value={billingAddress}
            onChange={(e) => setBillingAddress(e.target.value)}
            rows={2}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Payment terms</span>
          <textarea
            value={paymentTerms}
            onChange={(e) => setPaymentTerms(e.target.value)}
            rows={2}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Footer notes</span>
          <textarea
            value={footerNotes}
            onChange={(e) => setFooterNotes(e.target.value)}
            rows={2}
            className={inputClass}
          />
        </label>

        <label className="flex items-center gap-3 text-sm">
          <span className="text-[var(--muted)]">Accent colour</span>
          <input
            type="color"
            value={accentColor}
            onChange={(e) => setAccentColor(e.target.value)}
            className="h-8 w-14 rounded border border-[var(--border)] bg-transparent"
          />
        </label>
      </fieldset>

      {error !== null && <p className="status status--bad">{error}</p>}
      {saved && error === null && <p className="status status--good">Saved.</p>}

      <div>
        <button
          type="button"
          disabled={saving}
          onClick={() => void handleSave()}
          className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}
