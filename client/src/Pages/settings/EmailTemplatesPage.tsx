import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mail, Plus, Star } from 'lucide-react';
import {
  createStatementEmailTemplate,
  deleteStatementEmailTemplate,
  listStatementEmailTemplates,
  updateStatementEmailTemplate,
  STATEMENT_PLACEHOLDERS,
  type PartyKind,
  type StatementEmailTemplate,
  type StatementPlaceholder,
} from '../../services/fetchServices';
import { useOrg } from '../../context/OrgContext';
import PageHeader from '../../components/ui/PageHeader';
import TabBar from '../../components/ui/TabBar';
import ConfirmDialog from '../../components/ConfirmDialog';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../components/ui/formClasses';

/**
 * Statement email templates (Phase 39b): the subject and body a statement
 * email carries, per party kind, with `{{placeholders}}` from a closed list.
 * Chips insert a placeholder at the cursor; the preview fills them with
 * sample values locally. The server refuses any placeholder not on the list.
 */

const PLACEHOLDER_LABELS: Record<StatementPlaceholder, string> = {
  contact_name: 'Contact name',
  organization_name: 'Your organization',
  balance_due: 'Balance due',
  overdue_amount: 'Overdue amount',
  statement_date: 'Statement date',
  period_from: 'Period from',
  period_to: 'Period to',
  open_invoice_count: 'Open invoices',
};

function sampleValues(organizationName: string, currency: string): Record<StatementPlaceholder, string> {
  return {
    contact_name: 'Northwind Traders',
    organization_name: organizationName === '' ? 'Your organization' : organizationName,
    balance_due: `${currency} 3,300.00`,
    overdue_amount: `${currency} 1,450.00`,
    statement_date: '30 Sept 2026',
    period_from: '1 Sept 2026',
    period_to: '30 Sept 2026',
    open_invoice_count: '2',
  };
}

const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Client mirror of server/src/utils/placeholders.ts, for the preview only. */
export function fillSample(text: string, values: Record<StatementPlaceholder, string>): string {
  return text.replace(TOKEN, (whole, name: string) =>
    (STATEMENT_PLACEHOLDERS as readonly string[]).includes(name) ? values[name as StatementPlaceholder] : whole,
  );
}

function unknownNames(text: string): string[] {
  return [...text.matchAll(TOKEN)]
    .map((m) => m[1] ?? '')
    .filter((n) => !(STATEMENT_PLACEHOLDERS as readonly string[]).includes(n));
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

function toDraft(t: StatementEmailTemplate): Draft {
  return { id: t.id, builtIn: t.builtIn, name: t.name, subject: t.subject, body: t.body, isDefault: t.isDefault };
}

export default function EmailTemplatesPage() {
  const { organization } = useOrg();
  const [kind, setKind] = useState<PartyKind>('CUSTOMER');
  const [templates, setTemplates] = useState<StatementEmailTemplate[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const focused = useRef<'subject' | 'body'>('body');
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(
    async (selectId?: string | null) => {
      setError(null);
      try {
        const list = await listStatementEmailTemplates(kind);
        setTemplates(list);
        const selected = list.find((t) => t.id === selectId) ?? list.find((t) => t.isDefault) ?? list[0];
        setDraft(selected === undefined ? null : toDraft(selected));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load email templates');
      }
    },
    [kind],
  );

  useEffect(() => {
    setTemplates(null);
    void load();
  }, [load]);

  const values = useMemo(
    () => sampleValues(organization?.name ?? '', organization?.baseCurrency ?? 'USD'),
    [organization?.name, organization?.baseCurrency],
  );

  const selectedTemplate = templates?.find((t) => t.id === draft?.id && draft.id !== null) ?? null;
  const isBuiltIn = draft?.builtIn === true;
  const unknown = draft === null ? [] : [...new Set([...unknownNames(draft.subject), ...unknownNames(draft.body)])];
  const dirty =
    draft !== null &&
    (selectedTemplate === null
      ? !isBuiltIn
      : JSON.stringify(draft) !== JSON.stringify(toDraft(selectedTemplate)));

  function patch(change: Partial<Draft>) {
    setDraft((current) => (current === null ? current : { ...current, ...change }));
  }

  function insertPlaceholder(name: StatementPlaceholder) {
    if (draft === null) return;
    const token = `{{${name}}}`;
    const field = focused.current;
    const element = field === 'subject' ? subjectRef.current : bodyRef.current;
    const text = draft[field];
    const start = element?.selectionStart ?? text.length;
    const end = element?.selectionEnd ?? text.length;
    patch({ [field]: `${text.slice(0, start)}${token}${text.slice(end)}` });
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function startNew(from?: Draft) {
    setDraft({
      id: null,
      builtIn: false,
      name: from === undefined ? 'New template' : `${from.name} (copy)`,
      subject: from?.subject ?? 'Statement from {{organization_name}}',
      body: from?.body ?? 'Hi {{contact_name}},\n\nBalance due: {{balance_due}}',
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
          ? await createStatementEmailTemplate({ ...input, partyKind: kind, isDefault: draft.isDefault })
          : await updateStatementEmailTemplate(draft.id, {
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
      await deleteStatementEmailTemplate(draft.id);
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

  return (
    <section className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        icon={Mail}
        title="Statement email templates"
        subtitle="The message sent with a statement. Placeholders are filled in for each customer or vendor."
        actions={
          <button type="button" className={secondaryButtonClass} onClick={() => startNew()}>
            <span className="inline-flex items-center gap-1.5">
              <Plus size={15} aria-hidden="true" /> New template
            </span>
          </button>
        }
      />

      <TabBar
        ariaLabel="Template kind"
        variant="buttons"
        active={kind}
        onChange={(id) => setKind(id === 'VENDOR' ? 'VENDOR' : 'CUSTOMER')}
        items={[
          { id: 'CUSTOMER', label: 'Customer statements' },
          { id: 'VENDOR', label: 'Vendor statements' },
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
                ref={subjectRef}
                type="text"
                value={draft.subject}
                maxLength={200}
                disabled={readOnly}
                onFocus={() => (focused.current = 'subject')}
                onChange={(e) => patch({ subject: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Message</span>
              <textarea
                ref={bodyRef}
                value={draft.body}
                rows={12}
                maxLength={5000}
                disabled={readOnly}
                onFocus={() => (focused.current = 'body')}
                onChange={(e) => patch({ body: e.target.value })}
                className={inputClass}
              />
            </label>
            {!readOnly && (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-[var(--muted)]">Insert a placeholder</span>
                <div className="flex flex-wrap gap-1.5">
                  {STATEMENT_PLACEHOLDERS.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insertPlaceholder(name)}
                      className="rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-0.5 text-xs cursor-pointer text-[var(--text)]"
                    >
                      {PLACEHOLDER_LABELS[name]}
                    </button>
                  ))}
                </div>
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
                Use by default for {kind === 'CUSTOMER' ? 'customer' : 'vendor'} statements
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
                {fillSample(draft.subject, values)}
              </p>
              <p className="m-0 whitespace-pre-line" data-testid="preview-body">
                {fillSample(draft.body, values)}
              </p>
              <span className="self-start rounded-md bg-[var(--accent)] text-[var(--accent-fg)] px-3 py-1.5 text-xs font-semibold">
                {kind === 'CUSTOMER' ? 'Review and pay' : 'View statement'}
              </span>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete this template?"
          body="Statements already sent keep their history. If this is the default, another template takes over."
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
