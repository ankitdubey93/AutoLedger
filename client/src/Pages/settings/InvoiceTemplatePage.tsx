import { useEffect, useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import {
  getInvoiceSettings,
  getOrganizationProfile,
  updateInvoiceSettings,
  INVOICE_DENSITIES,
  INVOICE_FONT_FAMILIES,
  INVOICE_TEMPLATE_IDS,
  type InvoiceDensity,
  type InvoiceFontFamily,
  type InvoiceSettings,
  type InvoiceTemplateId,
  type OrganizationProfile,
} from '../../services/fetchServices';
import { useOrg } from '../../context/OrgContext';
import { useDocumentObjectUrl } from '../../utils/useDocumentObjectUrl';
import InvoiceDocument from '../sales/InvoiceDocument';
import { SAMPLE_INVOICE } from '../sales/sampleInvoice';
import SettingsTabs from './SettingsTabs';
import PageHeader from '../../components/ui/PageHeader';
import { inputClass } from '../../components/ui/formClasses';

/**
 * Invoice template editor: controls on the left, a live preview on the right.
 *
 * The preview is the real `InvoiceDocument` fed sample data and LOCAL,
 * unsaved state — typing never triggers a request. Numbering, due days, tax
 * rate and posting accounts stay on InvoiceSettingsPage; this page PATCHes
 * only the fields it owns.
 */

// Keyed by the literal unions, so adding an id to the whitelist without a label here
// is a compile error rather than a blank card.
const TEMPLATE_LABELS: Record<InvoiceTemplateId, { label: string; blurb: string }> = {
  classic: { label: 'Classic', blurb: 'Bordered table, totals right-aligned.' },
  modern: { label: 'Modern', blurb: 'Accent band, zebra rows, tinted totals.' },
  compact: { label: 'Compact', blurb: 'Single column, tighter type.' },
};

const FONT_LABELS: Record<InvoiceFontFamily, string> = {
  sans: 'Sans-serif',
  serif: 'Serif',
};

const DENSITY_LABELS: Record<InvoiceDensity, string> = {
  comfortable: 'Comfortable',
  compact: 'Compact',
};

/** Exactly the fields this page owns — nothing else is ever PATCHed from here. */
interface Draft {
  templateId: InvoiceTemplateId;
  documentTitle: string;
  fontFamily: InvoiceFontFamily;
  density: InvoiceDensity;
  accentColor: string;
  showLogo: boolean;
  showOrgAddress: boolean;
  showLegalName: boolean;
  showTaxNumber: boolean;
  showBusinessNumber: boolean;
  showPaymentTerms: boolean;
  showDueDate: boolean;
  bankDetails: string;
  footerNotes: string;
}

type ToggleKey =
  | 'showLogo'
  | 'showOrgAddress'
  | 'showLegalName'
  | 'showTaxNumber'
  | 'showBusinessNumber'
  | 'showPaymentTerms'
  | 'showDueDate';

const TOGGLES: { key: ToggleKey; label: string }[] = [
  { key: 'showLogo', label: 'Logo' },
  { key: 'showOrgAddress', label: 'Organization address' },
  { key: 'showLegalName', label: 'Legal name' },
  { key: 'showTaxNumber', label: 'Tax registration number' },
  { key: 'showBusinessNumber', label: 'Business registration number' },
  { key: 'showPaymentTerms', label: 'Payment terms' },
  { key: 'showDueDate', label: 'Due date' },
];

function toDraft(settings: InvoiceSettings): Draft {
  return {
    templateId: settings.templateId,
    documentTitle: settings.documentTitle,
    fontFamily: settings.fontFamily,
    density: settings.density,
    accentColor: settings.accentColor,
    showLogo: settings.showLogo,
    showOrgAddress: settings.showOrgAddress,
    showLegalName: settings.showLegalName,
    showTaxNumber: settings.showTaxNumber,
    showBusinessNumber: settings.showBusinessNumber,
    showPaymentTerms: settings.showPaymentTerms,
    showDueDate: settings.showDueDate,
    bankDetails: settings.bankDetails ?? '',
    footerNotes: settings.footerNotes ?? '',
  };
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The PATCH body: only Draft's fields, free text trimmed and blank becoming null. */
function toPatch(draft: Draft): Partial<InvoiceSettings> {
  return {
    ...draft,
    documentTitle: draft.documentTitle.trim(),
    bankDetails: blankToNull(draft.bankDetails),
    footerNotes: blankToNull(draft.footerNotes),
  };
}

export default function InvoiceTemplatePage() {
  const { organization } = useOrg();

  const [loaded, setLoaded] = useState<InvoiceSettings | null>(null);
  const [profile, setProfile] = useState<OrganizationProfile | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let ignore = false;

    // The profile is decoration (logo, address): a failed fetch means a preview
    // without them, never a broken editor.
    Promise.all([getInvoiceSettings(), getOrganizationProfile().catch(() => null)])
      .then(([settingsRes, profileRes]) => {
        if (ignore) return;
        setLoaded(settingsRes);
        setProfile(profileRes);
        setDraft(toDraft(settingsRes));
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load invoice settings');
      });

    return () => {
      ignore = true;
    };
  }, []);

  const logoSrc = useDocumentObjectUrl(profile?.logoDocumentId ?? null);

  const baseCurrency = organization?.baseCurrency ?? SAMPLE_INVOICE.currencyCode;

  // The preview's settings are the loaded ones with the draft laid over them, so the
  // fields this page does not own (billing address, numbering, ...) render as saved.
  const previewSettings = useMemo<InvoiceSettings | null>(() => {
    if (loaded === null || draft === null) return null;
    const title = draft.documentTitle.trim();
    return {
      ...loaded,
      ...draft,
      documentTitle: title === '' ? loaded.documentTitle : title,
      bankDetails: blankToNull(draft.bankDetails),
      footerNotes: blankToNull(draft.footerNotes),
    };
  }, [loaded, draft]);

  // Base currency = invoice currency keeps the "approx. in base currency" row out of the
  // preview. The invoice's own payment terms stay SAMPLE_INVOICE's fixed 'Net 30': they are a
  // per-invoice snapshot, and the showPaymentTerms toggle is what governs them.
  const previewInvoice = useMemo(
    () => ({ ...SAMPLE_INVOICE, currencyCode: baseCurrency }),
    [baseCurrency],
  );

  const dirty = useMemo(
    () => loaded !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(toDraft(loaded)),
    [loaded, draft],
  );

  function patchDraft(change: Partial<Draft>) {
    setDraft((current) => (current === null ? current : { ...current, ...change }));
    setSaved(false);
  }

  async function handleSave() {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await updateInvoiceSettings(toPatch(draft));
      setLoaded(next);
      setDraft(toDraft(next));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save invoice template');
    } finally {
      setSaving(false);
    }
  }

  function handleDiscard() {
    if (loaded === null) return;
    setDraft(toDraft(loaded));
    setError(null);
    setSaved(false);
  }

  if (loaded === null || draft === null || previewSettings === null) {
    return (
      <div aria-busy="true" className="flex flex-col gap-3">
        {error !== null && <p className="status status--bad">{error}</p>}
        <div className="skeleton skeleton--card" />
      </div>
    );
  }

  const titleBlank = draft.documentTitle.trim() === '';

  return (
    <section className="flex flex-col gap-4">
      <PageHeader as="h2" icon={FileText} title="Invoice template" />

      <SettingsTabs />

      <div className="grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] gap-6">
        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-3 border border-[var(--border)] rounded-lg p-4">
            <legend className="text-sm font-semibold px-1">Template</legend>

            <div role="radiogroup" aria-label="Template" className="grid grid-cols-3 gap-2">
              {INVOICE_TEMPLATE_IDS.map((id) => {
                const selected = draft.templateId === id;
                return (
                  <label
                    key={id}
                    className={[
                      'flex flex-col gap-1 rounded-md border p-2 text-sm cursor-pointer',
                      selected ? 'border-[var(--text)] bg-[var(--panel)]' : 'border-[var(--border)]',
                    ].join(' ')}
                  >
                    <input
                      type="radio"
                      name="templateId"
                      value={id}
                      checked={selected}
                      onChange={() => patchDraft({ templateId: id })}
                      className="sr-only"
                    />
                    <span className="font-medium">{TEMPLATE_LABELS[id].label}</span>
                    <span className="text-xs text-[var(--muted)]">{TEMPLATE_LABELS[id].blurb}</span>
                  </label>
                );
              })}
            </div>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Document title</span>
              <input
                type="text"
                value={draft.documentTitle}
                onChange={(e) => patchDraft({ documentTitle: e.target.value })}
                maxLength={24}
                className={inputClass}
              />
            </label>

            <div className="flex gap-3">
              <label className="flex flex-col gap-1 text-sm flex-1">
                <span className="text-[var(--muted)]">Font</span>
                <select
                  value={draft.fontFamily}
                  onChange={(e) => {
                    const next = INVOICE_FONT_FAMILIES.find((f) => f === e.target.value);
                    if (next !== undefined) patchDraft({ fontFamily: next });
                  }}
                  className={inputClass}
                >
                  {INVOICE_FONT_FAMILIES.map((f) => (
                    <option key={f} value={f}>
                      {FONT_LABELS[f]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm flex-1">
                <span className="text-[var(--muted)]">Density</span>
                <select
                  value={draft.density}
                  onChange={(e) => {
                    const next = INVOICE_DENSITIES.find((d) => d === e.target.value);
                    if (next !== undefined) patchDraft({ density: next });
                  }}
                  className={inputClass}
                >
                  {INVOICE_DENSITIES.map((d) => (
                    <option key={d} value={d}>
                      {DENSITY_LABELS[d]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="flex items-center gap-3 text-sm">
              <span className="text-[var(--muted)]">Accent colour</span>
              <input
                type="color"
                value={draft.accentColor}
                onChange={(e) => patchDraft({ accentColor: e.target.value })}
                className="h-8 w-14 rounded border border-[var(--border)] bg-transparent"
              />
            </label>
          </fieldset>

          <fieldset className="flex flex-col gap-2 border border-[var(--border)] rounded-lg p-4">
            <legend className="text-sm font-semibold px-1">Show on invoice</legend>
            {TOGGLES.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft[key]}
                  onChange={(e) => patchDraft({ [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
          </fieldset>

          <fieldset className="flex flex-col gap-3 border border-[var(--border)] rounded-lg p-4">
            <legend className="text-sm font-semibold px-1">Footer</legend>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Bank details</span>
              <textarea
                value={draft.bankDetails}
                onChange={(e) => patchDraft({ bankDetails: e.target.value })}
                rows={3}
                maxLength={500}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Footer notes</span>
              <textarea
                value={draft.footerNotes}
                onChange={(e) => patchDraft({ footerNotes: e.target.value })}
                rows={2}
                className={inputClass}
              />
            </label>
          </fieldset>

          {titleBlank && <p className="status status--bad">Document title cannot be blank.</p>}
          {error !== null && <p className="status status--bad">{error}</p>}
          {saved && !dirty && error === null && <p className="status status--good">Saved.</p>}
          {dirty && (
            <p className="text-xs text-[var(--muted)] m-0" role="status">
              Unsaved changes
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              disabled={saving || !dirty || titleBlank}
              onClick={() => void handleSave()}
              className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              disabled={saving || !dirty}
              onClick={handleDiscard}
              className="px-4 py-2 rounded-md text-sm font-medium cursor-pointer border border-[var(--border)] bg-transparent text-[var(--text)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Discard changes
            </button>
          </div>
        </div>

        <div className="lg:sticky lg:top-20 lg:self-start">
          <InvoiceDocument
            invoice={previewInvoice}
            settings={previewSettings}
            profile={profile}
            organizationName={organization?.name ?? ''}
            taxNumber={organization?.taxNumber ?? null}
            businessNumber={organization?.businessNumber ?? null}
            legalName={profile?.legalName ?? null}
            baseCurrency={baseCurrency}
            logoSrc={logoSrc}
            preview
          />
        </div>
      </div>
    </section>
  );
}
