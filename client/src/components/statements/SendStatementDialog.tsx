import { useEffect, useMemo, useState } from 'react';
import {
  listStatementEmailTemplates,
  previewStatementEmail,
  sendStatements,
  type PartyKind,
  type SendStatementsResult,
  type StatementEmailPreview,
  type StatementEmailTemplate,
  type StatementPartyPath,
  type StatementRequest,
} from '../../services/fetchServices';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../ui/formClasses';

/**
 * "Email statements" (Phase 39b): choose a template, check the recipient(s),
 * read exactly what the first one will receive, send. One party may be sent
 * to a different address than the one on file; a bulk send uses each party's
 * own email and reports who was skipped for having none.
 */

export interface SendRecipient {
  partyId: string;
  name: string;
  email: string | null;
}

export interface SendStatementDialogProps {
  kind: PartyKind;
  path: StatementPartyPath;
  recipients: SendRecipient[];
  request: StatementRequest;
  onClose: () => void;
  onSent: (result: SendStatementsResult) => void;
}

const TEMPLATE_DEFAULT = '';

export default function SendStatementDialog(props: SendStatementDialogProps) {
  const { kind, path, recipients, request } = props;
  const single = recipients.length === 1 ? recipients[0] : undefined;
  const [templates, setTemplates] = useState<StatementEmailTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState(TEMPLATE_DEFAULT);
  const [toEmail, setToEmail] = useState(single?.email ?? '');
  const [preview, setPreview] = useState<StatementEmailPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SendStatementsResult | null>(null);

  const withEmail = recipients.filter((r) => r.email !== null);
  const previewParty = single ?? withEmail[0];
  const requestKey = JSON.stringify(request);

  useEffect(() => {
    listStatementEmailTemplates(kind)
      .then(setTemplates)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load templates'));
  }, [kind]);

  useEffect(() => {
    if (previewParty === undefined) return;
    let ignore = false;
    setPreview(null);
    previewStatementEmail(path, {
      partyId: previewParty.partyId,
      request,
      templateId: templateId === TEMPLATE_DEFAULT ? null : templateId,
    })
      .then((p) => {
        if (!ignore) setPreview(p);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not preview the email');
      });
    return () => {
      ignore = true;
    };
    // `requestKey` stands in for `request`, which is a fresh object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, previewParty?.partyId, templateId, requestKey]);

  const overrideEmail = useMemo(() => {
    if (single === undefined) return null;
    const trimmed = toEmail.trim();
    return trimmed === '' || trimmed.toLowerCase() === (single.email ?? '').toLowerCase() ? null : trimmed;
  }, [single, toEmail]);

  const nothingToSend = single !== undefined ? toEmail.trim() === '' : withEmail.length === 0;

  async function handleSend() {
    setBusy(true);
    setError(null);
    try {
      const res = await sendStatements(path, {
        partyIds: recipients.map((r) => r.partyId),
        request,
        templateId: templateId === TEMPLATE_DEFAULT ? null : templateId,
        toEmail: overrideEmail,
      });
      setResult({ sent: res.sent, skipped: res.skipped });
      props.onSent({ sent: res.sent, skipped: res.skipped });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-statement-title"
        className="animate-pop-in w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 flex flex-col gap-4 shadow-[var(--shadow-lg)]"
      >
        <h3 id="send-statement-title" className="text-base font-semibold m-0">
          {single !== undefined ? `Email statement to ${single.name}` : `Email ${String(recipients.length)} statements`}
        </h3>

        {result !== null ? (
          <div className="flex flex-col gap-2 text-sm">
            <p className="status status--good m-0">
              {result.sent.length} statement{result.sent.length === 1 ? '' : 's'} queued to send.
            </p>
            {result.skipped.length > 0 && (
              <p className="status status--bad m-0">
                Skipped — no email address: {result.skipped.map((s) => s.name).join(', ')}
              </p>
            )}
            <div className="flex justify-end">
              <button type="button" className={primaryButtonClass} onClick={props.onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Email template</span>
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={inputClass}>
                <option value={TEMPLATE_DEFAULT}>Default template</option>
                {(templates ?? [])
                  .filter((t) => t.id !== null)
                  .map((t) => (
                    <option key={t.id} value={t.id ?? ''}>
                      {t.name}
                      {t.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
              </select>
            </label>

            {single !== undefined ? (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-[var(--muted)]">To</span>
                <input
                  type="email"
                  value={toEmail}
                  placeholder="customer@example.com"
                  onChange={(e) => setToEmail(e.target.value)}
                  className={inputClass}
                />
              </label>
            ) : (
              <p className="text-sm m-0">
                To {withEmail.length} recipient{withEmail.length === 1 ? '' : 's'} at their saved email address.
                {recipients.length > withEmail.length && (
                  <span className="text-[var(--bad)]">
                    {' '}
                    {recipients.length - withEmail.length} without an email will be skipped.
                  </span>
                )}
              </p>
            )}

            <div className="rounded-md border border-[var(--border)] p-3 flex flex-col gap-2 text-sm" aria-label="Email preview">
              {previewParty !== undefined && (
                <span className="text-xs uppercase tracking-wide text-[var(--muted)]">
                  Preview{single === undefined ? ` — ${previewParty.name}` : ''}
                </span>
              )}
              {preview === null ? (
                <span className="text-[var(--muted)]">{previewParty === undefined ? 'Nobody to preview.' : 'Loading preview…'}</span>
              ) : (
                <>
                  <p className="m-0 font-semibold">{preview.subject}</p>
                  <p className="m-0 whitespace-pre-line">{preview.body}</p>
                  <span className="self-start rounded-md bg-[var(--accent)] text-[var(--accent-fg)] px-3 py-1 text-xs font-semibold">
                    {kind === 'CUSTOMER' ? 'Review and pay' : 'View statement'}
                  </span>
                </>
              )}
            </div>

            {error !== null && <p className="status status--bad m-0">{error}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" className={secondaryButtonClass} onClick={props.onClose} disabled={busy}>
                Cancel
              </button>
              <button type="button" className={primaryButtonClass} onClick={() => void handleSend()} disabled={busy || nothingToSend}>
                {busy ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
