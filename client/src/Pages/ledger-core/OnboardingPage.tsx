import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOrg } from '../../context/OrgContext';
import {
  completeLedgerOnboarding,
  listAccounts,
  type Account,
  type OnboardingInput,
} from '../../services/fetchServices';
import { useLedgerSettings } from './LedgerSettingsContext';
import { fiscalYearBounds } from './fiscalYear';

/**
 * LedgerCore's first-run wizard. Collected once per organization and never
 * shown again — `LedgerCoreRoutes`'s gate redirects here only while
 * `settings.onboardedAt` is `null`, and away again the instant it isn't.
 *
 * Renders full-width, without the sidebar: this is a suite-level moment, not
 * one more LedgerCore page.
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

const INDUSTRIES = ['Software', 'Services', 'Retail', 'Manufacturing', 'Nonprofit', 'Other'];

type WizardStep = { step: 1 } | { step: 2 } | { step: 3 };

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';
const primaryButtonClass =
  'px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed';
const ghostButtonClass =
  'px-4 py-2 rounded-md text-sm font-medium border border-[var(--border)] bg-transparent text-[var(--text)] cursor-pointer';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { organization } = useOrg();
  const { applySettings } = useLedgerSettings();

  const [wizardStep, setWizardStep] = useState<WizardStep>({ step: 1 });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [organizationName, setOrganizationName] = useState(organization?.name ?? '');
  const [legalName, setLegalName] = useState('');
  const [industry, setIndustry] = useState('');

  const [baseCurrency, setBaseCurrency] = useState<string>('USD');
  const [fiscalYearStartMonth, setFiscalYearStartMonth] = useState(1);
  const [fiscalYearStartDay, setFiscalYearStartDay] = useState(1);
  const [booksStartDate, setBooksStartDate] = useState(todayIso());
  const [cashAccountId, setCashAccountId] = useState('');

  const [accounts, setAccounts] = useState<Account[]>([]);

  useEffect(() => {
    let ignore = false;

    listAccounts()
      .then((res) => {
        if (ignore) return;
        setAccounts(res.accounts);
        const defaultCash = res.accounts.find((a) => a.code === '1110');
        if (defaultCash !== undefined) setCashAccountId(defaultCash.id);
      })
      .catch(() => {
        // The wizard still works without a cash account preselected — the
        // dashboard's cash tile simply renders "—" until one is configured.
      });

    return () => {
      ignore = true;
    };
  }, []);

  const derivedFiscalYear = fiscalYearBounds(fiscalYearStartMonth, fiscalYearStartDay, todayIso());

  async function handleFinish() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    const input: OnboardingInput = {
      organizationName,
      legalName: legalName.trim() === '' ? null : legalName.trim(),
      baseCurrency,
      fiscalYearStartMonth,
      fiscalYearStartDay,
      booksStartDate,
      industry: industry === '' ? null : industry,
      timezone: 'UTC',
      cashAccountId: cashAccountId === '' ? null : cashAccountId,
    };

    try {
      const settings = await completeLedgerOnboarding(input);
      applySettings(settings);
      navigate('..', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete onboarding');
      setSubmitting(false);
    }
  }

  return (
    <section className="shell shell--narrow flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold m-0">Set up LedgerCore</h1>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Step {wizardStep.step} of 3
        </p>
      </header>

      {wizardStep.step === 1 && (
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold m-0">Workspace</h2>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Organization name</span>
            <input
              type="text"
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
              minLength={2}
              maxLength={120}
              required
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Legal name (optional)</span>
            <input
              type="text"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              maxLength={200}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Industry</span>
            <select value={industry} onChange={(e) => setIndustry(e.target.value)} className={inputClass}>
              <option value="">Select an industry…</option>
              {INDUSTRIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <div className="flex justify-end">
            <button
              type="button"
              className={primaryButtonClass}
              disabled={organizationName.trim().length < 2}
              onClick={() => setWizardStep({ step: 2 })}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {wizardStep.step === 2 && (
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold m-0">Financial year</h2>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Base currency</span>
            <select
              value={baseCurrency}
              onChange={(e) => setBaseCurrency(e.target.value)}
              className={inputClass}
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>

          <div className="flex gap-3">
            <label className="flex flex-col gap-1 text-sm flex-1">
              <span className="text-[var(--muted)]">Fiscal year starts in</span>
              <select
                value={fiscalYearStartMonth}
                onChange={(e) => setFiscalYearStartMonth(Number(e.target.value))}
                className={inputClass}
              >
                {MONTHS.map((name, index) => (
                  <option key={name} value={index + 1}>
                    {name}
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

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Books start date</span>
            <input
              type="date"
              value={booksStartDate}
              onChange={(e) => setBooksStartDate(e.target.value)}
              required
              className={inputClass}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Cash account for the dashboard</span>
            <select
              value={cashAccountId}
              onChange={(e) => setCashAccountId(e.target.value)}
              className={inputClass}
            >
              <option value="">None yet</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex justify-between">
            <button type="button" className={ghostButtonClass} onClick={() => setWizardStep({ step: 1 })}>
              Back
            </button>
            <button type="button" className={primaryButtonClass} onClick={() => setWizardStep({ step: 3 })}>
              Next
            </button>
          </div>
        </div>
      )}

      {wizardStep.step === 3 && (
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold m-0">Review</h2>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-[var(--muted)]">Organization</dt>
            <dd className="m-0">{organizationName}</dd>
            <dt className="text-[var(--muted)]">Legal name</dt>
            <dd className="m-0">{legalName === '' ? '—' : legalName}</dd>
            <dt className="text-[var(--muted)]">Industry</dt>
            <dd className="m-0">{industry === '' ? '—' : industry}</dd>
            <dt className="text-[var(--muted)]">Base currency</dt>
            <dd className="m-0">{baseCurrency}</dd>
            <dt className="text-[var(--muted)]">Fiscal year</dt>
            <dd className="m-0">
              {derivedFiscalYear.startDate} – {derivedFiscalYear.endDate} ({derivedFiscalYear.label})
            </dd>
            <dt className="text-[var(--muted)]">Books start date</dt>
            <dd className="m-0">{booksStartDate}</dd>
            <dt className="text-[var(--muted)]">Cash account</dt>
            <dd className="m-0">
              {cashAccountId === ''
                ? 'None yet'
                : (accounts.find((a) => a.id === cashAccountId)?.name ?? '—')}
            </dd>
          </dl>

          {error !== null && <p className="status status--bad">{error}</p>}

          <div className="flex justify-between">
            <button
              type="button"
              className={ghostButtonClass}
              onClick={() => setWizardStep({ step: 2 })}
              disabled={submitting}
            >
              Back
            </button>
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => void handleFinish()}
              disabled={submitting}
            >
              {submitting ? 'Finishing…' : 'Finish'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
