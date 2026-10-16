import { useEffect, useMemo, useState } from 'react';
import { ScrollText } from 'lucide-react';
import {
  getInvoiceSettings,
  getOrganizationProfile,
  getStatementSettings,
  updateStatementSettings,
  INVOICE_TEMPLATE_IDS,
  STATEMENT_TYPES,
  type InvoiceTemplateId,
  type OrganizationProfile,
  type StatementSettings,
  type StatementType,
} from '../../services/fetchServices';
import { useOrg } from '../../context/OrgContext';
import { useDocumentObjectUrl } from '../../utils/useDocumentObjectUrl';
import { addressLines } from '../sales/InvoiceDocument';
import StatementDocument from '../statements/StatementDocument';
import { sampleStatement } from '../statements/sampleStatement';
import SettingsTabs from './SettingsTabs';
import PageHeader from '../../components/ui/PageHeader';
import { inputClass } from '../../components/ui/formClasses';
import PlaceholderPicker from '../../components/placeholders/PlaceholderPicker';
import PlaceholderHints from '../../components/placeholders/PlaceholderHints';
import { usePlaceholderTarget } from '../../utils/usePlaceholderTarget';

/**
 * Statement template editor (Phase 39a): controls on the left, a live preview
 * of the real `StatementDocument` on the right, fed sample data and LOCAL,
 * unsaved state — the same split-pane shape as InvoiceTemplatePage.
 */

const TEMPLATE_LABELS: Record<InvoiceTemplateId, { label: string; blurb: string }> = {
  classic: { label: 'Classic', blurb: 'Bordered, accent rule on top.' },
  modern: { label: 'Modern', blurb: 'Accent band, zebra rows.' },
  compact: { label: 'Compact', blurb: 'Single column, tighter type.' },
};

const TYPE_LABELS: Record<StatementType, string> = {
  OUTSTANDING: 'Outstanding — open items on a date',
  ACTIVITY: 'Activity — every transaction in a range',
};

interface Draft {
  templateId: InvoiceTemplateId;
  documentTitle: string;
  defaultType: StatementType;
  accentColor: string;
  showLogo: boolean;
  showOrgAddress: boolean;
  showAgingSummary: boolean;
  showRemittance: boolean;
  footerNotes: string;
}

type ToggleKey = 'showLogo' | 'showOrgAddress' | 'showAgingSummary' | 'showRemittance';

const TOGGLES: { key: ToggleKey; label: string }[] = [
  { key: 'showLogo', label: 'Logo' },
  { key: 'showOrgAddress', label: 'Organization address' },
  { key: 'showAgingSummary', label: 'Aging summary (current, 1–30, 31–60 …)' },
  { key: 'showRemittance', label: 'How to pay (bank details from invoice template)' },
];

function toDraft(settings: StatementSettings): Draft {
  return {
    templateId: settings.templateId,
    documentTitle: settings.documentTitle,
    defaultType: settings.defaultType,
    accentColor: settings.accentColor,
    showLogo: settings.showLogo,
    showOrgAddress: settings.showOrgAddress,
    showAgingSummary: settings.showAgingSummary,
    showRemittance: settings.showRemittance,
    footerNotes: settings.footerNotes ?? '',
  };
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export default function StatementTemplatePage() {
  const { organization } = useOrg();
  const [loaded, setLoaded] = useState<StatementSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const placeholderTarget = usePlaceholderTarget('footerNotes');
  const [profile, setProfile] = useState<OrganizationProfile | null>(null);
  const [bankDetails, setBankDetails] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let ignore = false;
    Promise.all([
      getStatementSettings(),
      getOrganizationProfile().catch(() => null),
      getInvoiceSettings().catch(() => null),
    ])
      .then(([settingsRes, profileRes, invoiceRes]) => {
        if (ignore) return;
        setLoaded(settingsRes);
        setDraft(toDraft(settingsRes));
        setProfile(profileRes);
        setBankDetails(invoiceRes?.bankDetails ?? null);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load statement settings');
      });
    return () => {
      ignore = true;
    };
  }, []);

  const logoSrc = useDocumentObjectUrl(profile?.logoDocumentId ?? null);

  const previewSettings = useMemo<StatementSettings | null>(() => {
    if (loaded === null || draft === null) return null;
    const title = draft.documentTitle.trim();
    return {
      ...loaded,
      ...draft,
      documentTitle: title === '' ? loaded.documentTitle : title,
      footerNotes: blankToNull(draft.footerNotes),
    };
  }, [loaded, draft]);

  const previewStatement = useMemo(() => sampleStatement(draft?.defaultType ?? 'OUTSTANDING'), [draft?.defaultType]);
  // Phase 46b — the title and footer preview against the sample statement.
  const previewContext = {
    date: previewStatement.statementDate,
    contactName: previewStatement.party.name,
    organisationName: organization?.name ?? null,
    statementDate: previewStatement.statementDate,
    periodFrom: previewStatement.from,
    periodTo: previewStatement.statementDate,
  };

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
    try {
      const next = await updateStatementSettings({
        ...draft,
        documentTitle: draft.documentTitle.trim(),
        footerNotes: blankToNull(draft.footerNotes),
      });
      setLoaded(next);
      setDraft(toDraft(next));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save statement template');
    } finally {
      setSaving(false);
    }
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
      <PageHeader as="h2" icon={ScrollText} title="Statement template" />
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
                {...placeholderTarget.bind('documentTitle', (documentTitle) => patchDraft({ documentTitle }))}
                value={draft.documentTitle}
                onChange={(e) => patchDraft({ documentTitle: e.target.value })}
                maxLength={24}
                className={inputClass}
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Default statement type</span>
              <select
                value={draft.defaultType}
                onChange={(e) => {
                  const next = STATEMENT_TYPES.find((t) => t === e.target.value);
                  if (next !== undefined) patchDraft({ defaultType: next });
                }}
                className={inputClass}
              >
                {STATEMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>

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
            <legend className="text-sm font-semibold px-1">Show on statement</legend>
            {TOGGLES.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft[key]} onChange={(e) => patchDraft({ [key]: e.target.checked })} />
                {label}
              </label>
            ))}
          </fieldset>

          <fieldset className="flex flex-col gap-3 border border-[var(--border)] rounded-lg p-4">
            <legend className="text-sm font-semibold px-1">Footer</legend>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-[var(--muted)]">
                Placeholders here and in the title are filled in for each statement.
              </span>
              <PlaceholderPicker surface="STATEMENT" onInsert={placeholderTarget.insert} preview={previewContext} />
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Footer notes</span>
              <textarea
                {...placeholderTarget.bind('footerNotes', (footerNotes) => patchDraft({ footerNotes }))}
                value={draft.footerNotes}
                onChange={(e) => patchDraft({ footerNotes: e.target.value })}
                rows={3}
                maxLength={500}
                className={inputClass}
              />
            </label>
            <PlaceholderHints
              text={[draft.documentTitle, draft.footerNotes]}
              labels={['Title', 'Footer']}
              surface="STATEMENT"
              preview={previewContext}
            />
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
              onClick={() => {
                setDraft(toDraft(loaded));
                setSaved(false);
              }}
              className="px-4 py-2 rounded-md text-sm font-medium cursor-pointer border border-[var(--border)] bg-transparent text-[var(--text)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Discard changes
            </button>
          </div>
        </div>

        <div className="lg:sticky lg:top-20 lg:self-start">
          <StatementDocument
            statement={previewStatement}
            settings={previewSettings}
            organizationName={organization?.name ?? ''}
            orgAddressLines={profile !== null ? addressLines(profile) : []}
            baseCurrency={organization?.baseCurrency ?? 'USD'}
            logoSrc={logoSrc}
            bankDetails={bankDetails}
            preview
          />
        </div>
      </div>
    </section>
  );
}
