import { useCallback, useEffect, useMemo, useState } from 'react';
import { Mail, Plus, Star } from 'lucide-react';
import {
  createQuoteEmailTemplate,
  deleteQuoteEmailTemplate,
  listQuoteEmailTemplates,
  updateQuoteEmailTemplate,
  type QuoteDirection,
  type QuoteEmailTemplate,
} from '../../services/fetchServices';
import { useOrg } from '../../context/OrgContext';
import PageHeader from '../../components/ui/PageHeader';
import TabBar from '../../components/ui/TabBar';
import ConfirmDialog from '../../components/ConfirmDialog';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../components/ui/formClasses';
import PlaceholderPicker from '../../components/placeholders/PlaceholderPicker';
import PlaceholderHints from '../../components/placeholders/PlaceholderHints';
import { fillPlaceholders, type PlaceholderContext } from '../../utils/placeholders';
import { usePlaceholderTarget } from '../../utils/usePlaceholderTarget';

/**
 * Quote email templates (Phase 42, Slice C): the subject and body a quote
 * email carries, per direction. Placeholders come from the QUOTE surface.
 * The preview fills them with sample values locally; the server refuses any
 * `{{double-brace}}` token, so the page refuses it too.
 */

const BRACE_TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function sampleContext(organizationName: string, currency: string): PlaceholderContext {
  return {
    date: '2026-09-30',
    contactName: 'Northwind Traders',
    organisationName: organizationName === '' ? 'Your organization' : organizationName,
    quoteNumber: 'QU-000012',
    quoteTotal: `${currency} 1,250.00`,
    validUntil: '2026-11-09',
    quoteTitle: 'Website redesign',
  };
}

function braceTokens(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(BRACE_TOKEN)) {
    const name = m[1];
    if (name !== undefined && !found.includes(name)) found.push(name);
  }
  return found;
}

interface Draft {
  id: string | null;
  /** The code default: shown read-only until copied. */
  builtIn: boolean;
  name: string;
  subject: string;
  body: string;
  isDefault: boolean;
}

function toDraft(t: QuoteEmailTemplate): Draft {
  return { id: t.id, builtIn: t.builtIn, name: t.name, subject: t.subject, body: t.body, isDefault: t.isDefault };
}

export default function QuoteEmailTemplatesPage() {
  const { organization } = useOrg();
  const [direction, setDirection] = useState<QuoteDirection>('SALES');
  const [templates, setTemplates] = useState<QuoteEmailTemplate[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const target = usePlaceholderTarget('body');

  const load = useCallback(
    async (selectId?: string | null) => {
      setError(null);
      try {
        const list = await listQuoteEmailTemplates(direction);
        setTemplates(list);
        const selected = list.find((t) => t.id === selectId) ?? list.find((t) => t.isDefault) ?? list[0];
        setDraft(selected === undefined ? null : toDraft(selected));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load email templates');
      }
    },
    [direction],
  );

  useEffect(() => {
    setTemplates(null);
    void load();
  }, [load]);

  const sample = useMemo(
    () => sampleContext(organization?.name ?? '', organization?.baseCurrency ?? 'USD'),
    [organization?.name, organization?.baseCurrency],
  );

  const selectedTemplate = templates?.find((t) => t.id === draft?.id && draft.id !== null) ?? null;
  const isBuiltIn = draft?.builtIn === true;
  const unknown =
    draft === null ? [] : [...new Set([...braceTokens(draft.subject), ...braceTokens(draft.body)])];
  const dirty =
    draft !== null &&
    (selectedTemplate === null
      ? !isBuiltIn
      : JSON.stringify(draft) !== JSON.stringify(toDraft(selectedTemplate)));

  function patch(change: Partial<Draft>) {
    setDraft((current) => (current === null ? current : { ...current, ...change }));
  }

  function startNew(from?: Draft) {
    setDraft({
      id: null,
      builtIn: false,
      name: from === undefined ? 'New template' : `${from.name} (copy)`,
      subject: from?.subject ?? 'Quote [Quote Number] from [Organisation Name]',
      body: from?.body ?? 'Hi [Contact Name],\n\nPlease see [Quote Number] for [Quote Total], valid until [Valid Until].\n\nThank you,\n[Organisation Name]',
      isDefault: false,
    });
  }

  async function save() {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    try {
      const input = { name: draft.name.trim(), subject: draft.subject.trim(), body: draft.body.trim() };
      const saved =
        draft.id === null
          ? await createQuoteEmailTemplate({ ...input, direction, isDefault: draft.isDefault })
          : await updateQuoteEmailTemplate(draft.id, {
              ...input,
              ...(draft.isDefault && selectedTemplate?.isDefault !== true ? { isDefault: true } : {}),
            });
      await load(saved.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the template');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (draft?.id == null) return;
    setSaving(true);
    try {
      await deleteQuoteEmailTemplate(draft.id);
      setConfirmDelete(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the template');
    } finally {
      setSaving(false);
    }
  }

  const readOnly = isBuiltIn;
  const blank = draft !== null && (draft.name.trim() === '' || draft.subject.trim() === '' || draft.body.trim() === '');
  const directionLabel = direction === 'SALES' ? 'sales quotes' : 'purchase quotes';

  return (
    <section className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        icon={Mail}
        title="Quote email templates"
        subtitle="The message sent with a quote. Placeholders are filled in for each quote."
        actions={
          <button type="button" className={secondaryButtonClass} onClick={() => startNew()}>
            <span className="inline-flex items-center gap-1.5">
              <Plus size={15} aria-hidden="true" /> New template
            </span>
          </button>
        }
      />

      <TabBar
        ariaLabel="Template direction"
        variant="buttons"
        active={direction}
        onChange={(id) => setDirection(id === 'PURCHASE' ? 'PURCHASE' : 'SALES')}
        items={[
          { id: 'SALES', label: 'Sales quotes' },
          { id: 'PURCHASE', label: 'Purchase quotes' },
        ]}
      />

      {error !== null && <p className="status status--bad">{error}</p>}
      {templates === null && error === null && <div className="skeleton skeleton--card" aria-busy="true" />}

      {templates !== null && draft !== null && (
        <div className="grid lg:grid-cols-[14rem_minmax(0,1fr)_minmax(0,1fr)] gap-4">
          <ul className="list-none m-0 p-0 flex flex-col gap-1" aria-label="Templates">
            {templates.map((t) => (
              <li key={t.id ?? 'built-in'}>
                <button
                  type="button"
                  onClick={() => setDraft(toDraft(t))}
                  className={`w-full text-left rounded-md border px-3 py-2 text-sm cursor-pointer bg-transparent text-[var(--text)] ${
                    t.id === draft.id && t.builtIn === draft.builtIn ? 'border-[var(--accent)]' : 'border-[var(--border)]'
                  }`}
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    {t.isDefault && <Star size={13} aria-label="Default" className="text-[var(--accent)]" />}
                    {t.name}
                  </span>
                  {t.builtIn && <span className="text-xs text-[var(--muted)]">Built-in</span>}
                </button>
              </li>
            ))}
            {draft.id === null && !isBuiltIn && (
              <li className="rounded-md border border-dashed border-[var(--accent)] px-3 py-2 text-sm">{draft.name || 'Untitled'} (unsaved)</li>
            )}
          </ul>

          <div className="flex flex-col gap-3">
            {readOnly && (
              <p className="status">
                This is the built-in template.{' '}
                <button type="button" className="btn btn--ghost" onClick={() => startNew(draft)}>
                  Customize a copy
                </button>
              </p>
            )}
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Template name</span>
              <input
                type="text"
                value={draft.name}
                maxLength={100}
                disabled={readOnly}
                onChange={(e) => patch({ name: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Subject</span>
              <input
                {...target.bind('subject', (subject) => patch({ subject }))}
                type="text"
                value={draft.subject}
                maxLength={200}
                disabled={readOnly}
                onChange={(e) => patch({ subject: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Message</span>
              <textarea
                {...target.bind('body', (body) => patch({ body }))}
                value={draft.body}
                rows={12}
                maxLength={5000}
                disabled={readOnly}
                onChange={(e) => patch({ body: e.target.value })}
                className={inputClass}
              />
            </label>
            {!readOnly && (
              <div className="flex flex-col gap-1.5">
                <div>
                  <PlaceholderPicker surface="QUOTE" onInsert={target.insert} />
                </div>
                <PlaceholderHints text={[draft.subject, draft.body]} surface="QUOTE" />
              </div>
            )}
            {!readOnly && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.isDefault}
                  disabled={selectedTemplate?.isDefault === true}
                  onChange={(e) => patch({ isDefault: e.target.checked })}
                />
                Use by default for {directionLabel}
              </label>
            )}
            {unknown.length > 0 && (
              <p className="status status--bad">
                Unknown placeholder{unknown.length > 1 ? 's' : ''}: {unknown.map((n) => `{{${n}}}`).join(', ')}
              </p>
            )}
            {!readOnly && (
              <div className="flex gap-2">
                <button
                  type="button"
                  className={primaryButtonClass}
                  disabled={saving || !dirty || blank || unknown.length > 0}
                  onClick={() => void save()}
                >
                  {saving ? 'Saving…' : 'Save template'}
                </button>
                {draft.id !== null && (
                  <button type="button" className={secondaryButtonClass} disabled={saving} onClick={() => setConfirmDelete(true)}>
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2" aria-label="Preview">
            <span className="text-xs uppercase tracking-wide text-[var(--muted)]">Preview</span>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-3 text-sm">
              <p className="m-0 font-semibold" data-testid="preview-subject">
                {fillPlaceholders(draft.subject, 'QUOTE', sample)}
              </p>
              <p className="m-0 whitespace-pre-line" data-testid="preview-body">
                {fillPlaceholders(draft.body, 'QUOTE', sample)}
              </p>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete this template?"
          body="Quotes already sent keep their history. If this is the default, another template takes over."
          confirmLabel="Delete"
          tone="danger"
          busy={saving}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </section>
  );
}
