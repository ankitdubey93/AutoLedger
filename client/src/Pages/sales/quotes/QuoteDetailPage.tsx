import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Download, Printer } from 'lucide-react';
import {
  ApiRequestError,
  convertQuote,
  deleteQuote,
  downloadQuotePdf,
  getQuote,
  listQuoteEmailTemplates,
  previewQuoteEmail,
  recordQuoteAcceptance,
  recordQuoteDecline,
  reviseQuote,
  revokeQuoteLink,
  sendQuote,
  voidQuote,
  type Quote,
  type QuoteEmailTemplate,
} from '../../../services/fetchServices';
import { formatCents } from '../../../utils/money';
import { formatDate } from '../../../utils/date';
import { useCan } from '../../../context/AuthContext';
import { useOrganizationName } from '../../../context/OrgContext';
import BackLink from '../../../components/BackLink';
import ConfirmDialog from '../../../components/ConfirmDialog';
import AttachmentsPanel from '../../../components/AttachmentsPanel';
import HistoryAndNotes from '../../../components/history/HistoryAndNotes';
import LoadingState from '../../../components/ui/LoadingState';
import QuoteDocument, { QuoteStatusPill, quoteLabel, type QuoteDocumentData } from './QuoteDocument';
import type { QuoteKindConfig } from './quoteKinds';

/**
 * One quote (Phase 41). Which actions show is decided by the quote's
 * effective status (QUOTE_TRANSITIONS on the server) and the member's
 * permissions; the server re-checks both. Nothing on this page posts to the
 * ledger — converting creates a *draft* invoice or expense, which posts only
 * when it is issued or approved from its own page.
 */

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';
const primaryClass =
  'px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40';
const secondaryClass =
  'px-3 py-1.5 rounded-md text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] cursor-pointer disabled:opacity-40 no-underline';

function today(): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError || err instanceof Error ? err.message : fallback;
}

/** Hands a Blob to the browser as a file download (Phase 42, Slice E). */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function toDocumentData(quote: Quote): QuoteDocumentData {
  return {
    direction: quote.direction,
    quoteNumber: quote.quoteNumber,
    revision: quote.revision,
    partyName: quote.partyNameSnapshot,
    partyAddress: quote.partyAddressSnapshot,
    partyTaxNumber: quote.partyTaxNumberSnapshot,
    partyReference: quote.partyReference,
    quoteDate: quote.quoteDate,
    validUntil: quote.validUntil,
    currencyCode: quote.currencyCode,
    title: quote.title,
    notes: quote.notes,
    terms: quote.terms,
    paymentTerms: quote.paymentTerms,
    lines: quote.lines,
    subtotalCents: quote.subtotalCents,
    taxCents: quote.taxCents,
    totalCents: quote.totalCents,
    depositPercentBp: quote.depositPercentBp,
  };
}

function Modal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="animate-pop-in w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 flex flex-col gap-3 shadow-[var(--shadow-lg)]">
        <h3 className="text-base font-semibold m-0">{title}</h3>
        {children}
      </div>
    </div>
  );
}

type DialogKind = 'send' | 'accept' | 'decline' | 'void' | 'convert' | 'delete' | null;

export default function QuoteDetailPage({ config }: { config: QuoteKindConfig }) {
  const { quoteId = '' } = useParams<{ quoteId: string }>();
  const navigate = useNavigate();
  const can = useCan();
  const organizationName = useOrganizationName() ?? '';

  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // Dialog fields.
  const [delivery, setDelivery] = useState<'EMAIL' | 'MANUAL'>('EMAIL');
  const [toEmail, setToEmail] = useState('');
  const [message, setMessage] = useState('');
  const [signerName, setSignerName] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [documentDate, setDocumentDate] = useState(today);
  const [dueDate, setDueDate] = useState('');
  const [vendorReference, setVendorReference] = useState('');
  // Convert dialog (Phase 42): a draft invoice/bill, or a confirmed order.
  const [convertTarget, setConvertTarget] = useState<'INVOICE' | 'ORDER'>('INVOICE');
  // Send dialog: the email template picked (null = built-in), its choices, and the preview.
  const [emailTemplates, setEmailTemplates] = useState<QuoteEmailTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setNotFound(false);
    getQuote(config.direction, quoteId, controller.signal)
      .then((res) => setQuote(res.quote))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiRequestError && err.status === 404) setNotFound(true);
        else setError(messageOf(err, 'Could not load the quote'));
      });
    return () => controller.abort();
  }, [config, quoteId]);

  function open(kind: Exclude<DialogKind, null>) {
    if (quote === null) return;
    setDialogError(null);
    setNote('');
    setReason('');
    if (kind === 'send') {
      setDelivery(quote.status === 'DRAFT' && quote.partyEmailSnapshot === null ? 'MANUAL' : 'EMAIL');
      setToEmail(quote.partyEmailSnapshot ?? '');
      setMessage('');
      setPreview(null);
      setEmailTemplates([]);
      setTemplateId(null);
      listQuoteEmailTemplates(config.direction)
        .then((list) => {
          setEmailTemplates(list);
          // The stored default is selected first; with none, the built-in (null id) is.
          setTemplateId(list.find((t) => t.isDefault && t.id !== null)?.id ?? null);
        })
        .catch(() => setEmailTemplates([]));
    }
    if (kind === 'accept') setSignerName('');
    if (kind === 'convert') {
      setDocumentDate(today());
      setDueDate('');
      setVendorReference(quote.partyReference ?? quote.quoteNumber ?? '');
      setConvertTarget('INVOICE');
    }
    setDialog(kind);
  }

  async function downloadPdf() {
    if (quote === null) return;
    setDialogError(null);
    try {
      const blob = await downloadQuotePdf(config.direction, quote.id);
      saveBlob(blob, `${quote.quoteNumber ?? 'quote-draft'}.pdf`);
    } catch (err: unknown) {
      setDialogError(messageOf(err, 'Could not download the PDF'));
    }
  }

  async function run(action: () => Promise<Quote | null>, fallback: string) {
    setBusy(true);
    setDialogError(null);
    try {
      const next = await action();
      if (next !== null) setQuote(next);
      setDialog(null);
    } catch (err: unknown) {
      setDialogError(messageOf(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to={`/${config.path}`} label={`Back to ${config.plural.toLowerCase()}`} />
        <p className="status status--bad">Quote not found.</p>
      </section>
    );
  }
  if (quote === null) {
    return error !== null ? (
      <section className="flex flex-col gap-3">
        <BackLink to={`/${config.path}`} label={`Back to ${config.plural.toLowerCase()}`} />
        <p className="status status--bad">{error}</p>
      </section>
    ) : (
      <LoadingState />
    );
  }

  const status = quote.effectiveStatus;
  const canEdit = can(config.permissions.edit);
  const canSend = can(config.permissions.send);
  const canConvert = can(config.permissions.convert);
  const purchase = config.direction === 'PURCHASE';
  const revisable = status === 'SENT' || status === 'DECLINED' || status === 'EXPIRED';
  const draftRevision = quote.revisions.find((r) => r.status === 'DRAFT' && r.id !== quote.id);
  const liveLink = quote.links.find((l) => l.live);

  return (
    <section className="flex flex-col gap-6">
      <BackLink to={`/${config.path}`} label={`Back to ${config.plural.toLowerCase()}`} />

      <header className="no-print flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0 flex items-center gap-2">
            {quoteLabel(quote)} <QuoteStatusPill status={status} />
          </h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            {quote.partyName} · {formatCents(quote.totalCents)} {quote.currencyCode} · valid until{' '}
            {formatDate(quote.validUntil)}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {status === 'DRAFT' && canEdit && (
            <Link to={`/${config.path}/${quote.id}/edit`} className={secondaryClass}>
              Edit
            </Link>
          )}
          {status === 'DRAFT' && canSend && (
            <button type="button" className={primaryClass} onClick={() => open('send')}>
              Send
            </button>
          )}
          {status === 'SENT' && canSend && (
            <button type="button" className={secondaryClass} onClick={() => open('send')}>
              {liveLink === undefined ? 'Email' : 'Email again'}
            </button>
          )}
          {(status === 'DRAFT' || status === 'SENT') && canSend && (
            <>
              <button type="button" className={secondaryClass} onClick={() => open('accept')}>
                Record acceptance
              </button>
              <button type="button" className={secondaryClass} onClick={() => open('decline')}>
                Record decline
              </button>
            </>
          )}
          {status === 'ACCEPTED' && canConvert && (
            <button type="button" className={primaryClass} onClick={() => open('convert')}>
              Convert to {config.convertNoun}
            </button>
          )}
          {revisable && canEdit && draftRevision === undefined && (
            <button
              type="button"
              className={secondaryClass}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const { quote: revision } = await reviseQuote(config.direction, quote.id);
                  void navigate(`/${config.path}/${revision.id}/edit`);
                  return null;
                }, 'Could not create a revision')
              }
            >
              Revise
            </button>
          )}
          {(quote.status === 'SENT' || quote.status === 'ACCEPTED') && canSend && (
            <button type="button" className={secondaryClass} onClick={() => open('void')}>
              Void
            </button>
          )}
          {status === 'DRAFT' && canEdit && (
            <button type="button" className={secondaryClass} onClick={() => open('delete')}>
              Delete
            </button>
          )}
          <button
            type="button"
            onClick={() => void downloadPdf()}
            className={`${secondaryClass} flex items-center gap-1.5`}
          >
            <Download size={14} aria-hidden="true" /> Download PDF
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className={`${secondaryClass} flex items-center gap-1.5`}
          >
            <Printer size={14} aria-hidden="true" /> Print
          </button>
        </div>
      </header>

      {dialogError !== null && dialog === null && <p className="status status--bad no-print">{dialogError}</p>}

      <div className="no-print flex flex-col gap-2">
        {status === 'EXPIRED' && (
          <p className="status status--bad m-0">
            This quote expired on {formatDate(quote.validUntil)} and can no longer be accepted. Revise it to send an updated offer.
          </p>
        )}
        {status === 'SUPERSEDED' && (
          <p className="status m-0">This version was replaced by a later revision.</p>
        )}
        {status === 'VOID' && <p className="status status--bad m-0">Voided — {quote.voidReason}</p>}
        {draftRevision !== undefined && (
          <p className="status m-0">
            A draft revision exists —{' '}
            <Link to={`/${config.path}/${draftRevision.id}`}>open revision {String(draftRevision.revision)}</Link>.
          </p>
        )}
        {quote.convertedDocument !== null && (
          <p className="status status--good m-0">
            Converted to{' '}
            {quote.convertedDocument.kind === 'ORDER'
              ? purchase
                ? 'purchase order'
                : 'sales order'
              : config.convertNoun}{' '}
            <Link
              to={
                quote.convertedDocument.kind === 'ORDER'
                  ? `/${purchase ? 'purchase-orders' : 'sales-orders'}/${quote.convertedDocument.id}`
                  : `/${config.convertPath}/${quote.convertedDocument.id}`
              }
            >
              {quote.convertedDocument.number ?? 'draft'}
            </Link>{' '}
            ({quote.convertedDocument.status.toLowerCase()}).
          </p>
        )}
        {quote.indicativeFxRate !== null && quote.indicativeBaseTotalCents !== null && (
          <p className="text-sm text-[var(--muted)] m-0">
            Indicative only: ≈ {formatCents(quote.indicativeBaseTotalCents)} at {quote.indicativeFxRate} on the quote date.
            The {config.convertNoun} uses the rate on its own date.
          </p>
        )}
      </div>

      <QuoteDocument quote={toDocumentData(quote)} merchantName={organizationName} />

      {quote.response !== null && (
        <section className="no-print rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-2 text-sm" aria-label="Response">
          <h3 className="text-base font-semibold m-0">
            {quote.response.response === 'ACCEPTED' ? 'Acceptance' : 'Decline'} record
          </h3>
          <dl className="grid grid-cols-[10rem_minmax(0,1fr)] gap-x-4 gap-y-1 m-0">
            <dt className="text-[var(--muted)]">When</dt>
            <dd className="m-0">{new Date(quote.response.respondedAt).toLocaleString()}</dd>
            <dt className="text-[var(--muted)]">How</dt>
            <dd className="m-0">
              {quote.response.channel === 'PUBLIC_LINK'
                ? 'On the emailed review page'
                : `Recorded by ${quote.response.recordedByName ?? 'a team member'}`}
            </dd>
            {quote.response.signerName !== null && (
              <>
                <dt className="text-[var(--muted)]">Signed by</dt>
                <dd className="m-0">
                  {quote.response.signerName}
                  {quote.response.signerEmail !== null ? ` (${quote.response.signerEmail})` : ''}
                  {quote.response.signerEmailVerified ? ' — email verified' : ''}
                  {quote.response.termsAccepted ? ' — accepted the terms' : ''}
                </dd>
              </>
            )}
            {quote.response.declineReason !== null && (
              <>
                <dt className="text-[var(--muted)]">Reason</dt>
                <dd className="m-0">{quote.response.declineReason}</dd>
              </>
            )}
            {quote.response.note !== null && (
              <>
                <dt className="text-[var(--muted)]">Note</dt>
                <dd className="m-0">{quote.response.note}</dd>
              </>
            )}
            {quote.response.clientIp !== null && (
              <>
                <dt className="text-[var(--muted)]">IP address</dt>
                <dd className="m-0 font-mono text-xs">{quote.response.clientIp}</dd>
              </>
            )}
            {quote.response.userAgent !== null && (
              <>
                <dt className="text-[var(--muted)]">Browser</dt>
                <dd className="m-0 text-xs break-all">{quote.response.userAgent}</dd>
              </>
            )}
            <dt className="text-[var(--muted)]">Content fingerprint</dt>
            <dd className="m-0 font-mono text-xs break-all">{quote.response.quoteContentSha256}</dd>
          </dl>
        </section>
      )}

      {quote.links.length > 0 && (
        <section className="no-print flex flex-col gap-2" aria-label="Review links">
          <h3 className="text-base font-semibold m-0">Review links</h3>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[36rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium">Sent to</th>
                  <th className="p-3 font-medium">Sent</th>
                  <th className="p-3 font-medium">Last viewed</th>
                  <th className="p-3 font-medium">State</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {quote.links.map((link) => (
                  <tr key={link.id} className="border-t border-[var(--border)]">
                    <td className="p-3">{link.toEmail}</td>
                    <td className="p-3 whitespace-nowrap">
                      {new Date(link.createdAt).toLocaleString()}
                      {link.sentByName !== null ? ` · ${link.sentByName}` : ''}
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      {link.lastViewedAt === null ? 'Not opened' : new Date(link.lastViewedAt).toLocaleString()}
                    </td>
                    <td className="p-3">{link.live ? 'Live' : link.revokedAt !== null ? 'Revoked' : 'Expired'}</td>
                    <td className="p-3 text-right">
                      {link.live && canSend && (
                        <button
                          type="button"
                          className={secondaryClass}
                          disabled={busy}
                          onClick={() =>
                            void run(
                              async () => (await revokeQuoteLink(config.direction, quote.id, link.id)).quote,
                              'Could not revoke the link',
                            )
                          }
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {quote.revisions.length > 1 && (
        <section className="no-print flex flex-col gap-2" aria-label="Revisions">
          <h3 className="text-base font-semibold m-0">Revisions</h3>
          <ul className="m-0 pl-5 text-sm flex flex-col gap-1">
            {quote.revisions.map((r) => (
              <li key={r.id}>
                {r.id === quote.id ? (
                  <strong>Revision {r.revision}</strong>
                ) : (
                  <Link to={`/${config.path}/${r.id}`}>Revision {r.revision}</Link>
                )}{' '}
                — <QuoteStatusPill status={r.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="no-print">
        <AttachmentsPanel module="ledger-core" entityType="quote" entityId={quote.id} />
        <HistoryAndNotes basePath={`/${config.path}`} entityId={quote.id} notePermission={config.permissions.edit} />
      </div>

      {dialog === 'send' && (
        <Modal title={quote.status === 'DRAFT' ? `Send ${config.sendNoun}` : `Email ${config.sendNoun} again`}>
          <p className="text-sm text-[var(--muted)] m-0">
            {quote.status === 'DRAFT'
              ? 'Sending allocates the quote number and freezes this version. Later changes are made as a revision.'
              : 'A new review link is emailed; the previous link stops working.'}
          </p>
          {quote.status === 'DRAFT' && (
            <fieldset className="flex flex-col gap-1 text-sm border-0 p-0 m-0">
              <label className="flex items-center gap-2">
                <input type="radio" name="delivery" checked={delivery === 'EMAIL'} onChange={() => setDelivery('EMAIL')} />
                Email a review link to {purchase ? 'the vendor' : 'the customer'}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="delivery" checked={delivery === 'MANUAL'} onChange={() => setDelivery('MANUAL')} />
                Mark as sent — I’ll print or send it myself
              </label>
            </fieldset>
          )}
          {delivery === 'EMAIL' && (
            <>
              {emailTemplates.length > 0 && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-[var(--muted)]">Email template</span>
                  <select
                    aria-label="Email template"
                    value={templateId ?? ''}
                    onChange={(e) => {
                      setTemplateId(e.target.value === '' ? null : e.target.value);
                      setPreview(null);
                    }}
                    className={inputClass}
                  >
                    {emailTemplates.map((t) => (
                      <option key={t.id ?? 'built-in'} value={t.id ?? ''}>
                        {t.name}
                        {t.builtIn ? ' (built-in)' : ''}
                        {t.isDefault ? ' — default' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-[var(--muted)]">Email to</span>
                <input type="email" value={toEmail} onChange={(e) => setToEmail(e.target.value)} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-[var(--muted)]">Message (optional)</span>
                <textarea value={message} maxLength={2000} rows={3} onChange={(e) => setMessage(e.target.value)} className={inputClass} />
              </label>
              <div>
                <button
                  type="button"
                  className={secondaryClass}
                  disabled={busy}
                  onClick={() =>
                    void previewQuoteEmail(config.direction, quote.id, templateId)
                      .then((res) => setPreview({ subject: res.subject, body: res.body }))
                      .catch((err: unknown) => setDialogError(messageOf(err, 'Could not preview the email')))
                  }
                >
                  Preview
                </button>
              </div>
              {preview !== null && (
                <div aria-label="Email preview" className="rounded-md border border-[var(--border)] p-3 flex flex-col gap-1 text-sm">
                  <p className="m-0 font-semibold">{preview.subject}</p>
                  <p className="m-0 whitespace-pre-line">{preview.body}</p>
                </div>
              )}
            </>
          )}
          {dialogError !== null && <p className="status status--bad m-0">{dialogError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn--ghost" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryClass}
              disabled={busy || (delivery === 'EMAIL' && toEmail.trim() === '')}
              onClick={() =>
                void run(
                  async () =>
                    (
                      await sendQuote(config.direction, quote.id, {
                        delivery: quote.status === 'DRAFT' ? delivery : 'EMAIL',
                        toEmail: delivery === 'EMAIL' || quote.status !== 'DRAFT' ? toEmail.trim() : null,
                        message: message.trim() === '' ? null : message.trim(),
                        templateId,
                      })
                    ).quote,
                  'Could not send the quote',
                )
              }
            >
              {delivery === 'EMAIL' || quote.status !== 'DRAFT' ? 'Send email' : 'Mark as sent'}
            </button>
          </div>
        </Modal>
      )}

      {dialog === 'accept' && (
        <Modal title="Record acceptance">
          <p className="text-sm text-[var(--muted)] m-0">
            For an acceptance received outside the review link — a signed copy, an email, a call. Attach any signed document
            below.{quote.status === 'DRAFT' ? ' The quote is numbered and frozen first.' : ''}
          </p>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Accepted by (full name)</span>
            <input value={signerName} maxLength={200} onChange={(e) => setSignerName(e.target.value)} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Note (optional)</span>
            <input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} className={inputClass} />
          </label>
          {dialogError !== null && <p className="status status--bad m-0">{dialogError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn--ghost" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryClass}
              disabled={busy || signerName.trim() === ''}
              onClick={() =>
                void run(
                  async () =>
                    (
                      await recordQuoteAcceptance(config.direction, quote.id, {
                        signerName: signerName.trim(),
                        note: note.trim() === '' ? null : note.trim(),
                      })
                    ).quote,
                  'Could not record the acceptance',
                )
              }
            >
              Record acceptance
            </button>
          </div>
        </Modal>
      )}

      {dialog === 'decline' && (
        <Modal title="Record decline">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Reason (optional)</span>
            <input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} className={inputClass} />
          </label>
          {dialogError !== null && <p className="status status--bad m-0">{dialogError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn--ghost" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryClass}
              disabled={busy}
              onClick={() =>
                void run(
                  async () =>
                    (
                      await recordQuoteDecline(config.direction, quote.id, {
                        reason: reason.trim() === '' ? null : reason.trim(),
                        note: null,
                      })
                    ).quote,
                  'Could not record the decline',
                )
              }
            >
              Record decline
            </button>
          </div>
        </Modal>
      )}

      {dialog === 'void' && (
        <Modal title="Void quote">
          <p className="text-sm text-[var(--muted)] m-0">
            Withdraws the offer. Its review link stops working. This cannot be undone.
          </p>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Reason</span>
            <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className={inputClass} />
          </label>
          {dialogError !== null && <p className="status status--bad m-0">{dialogError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn--ghost" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryClass}
              disabled={busy || reason.trim() === ''}
              onClick={() =>
                void run(async () => (await voidQuote(config.direction, quote.id, reason.trim())).quote, 'Could not void the quote')
              }
            >
              Void quote
            </button>
          </div>
        </Modal>
      )}

      {dialog === 'convert' && (
        <Modal title={convertTarget === 'ORDER' ? 'Create an order' : `Convert to ${config.convertNoun}`}>
          <fieldset className="flex flex-col gap-1 text-sm border-0 p-0 m-0">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="convert-target"
                checked={convertTarget === 'INVOICE'}
                onChange={() => setConvertTarget('INVOICE')}
              />
              {purchase ? 'Create a draft expense' : 'Create a draft invoice'}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="convert-target"
                checked={convertTarget === 'ORDER'}
                onChange={() => setConvertTarget('ORDER')}
              />
              {purchase ? 'Create a purchase order' : 'Create a sales order'}
            </label>
          </fieldset>
          {convertTarget === 'ORDER' ? (
            <p className="text-sm text-[var(--muted)] m-0">
              Creates a confirmed order with this quote’s lines. An order posts nothing to the ledger; invoice or bill it in
              part or in full from the order.
            </p>
          ) : (
            <p className="text-sm text-[var(--muted)] m-0">
              Creates a draft {config.convertNoun} with these lines. Nothing is posted until you{' '}
              {purchase ? 'approve the expense' : 'issue the invoice'}, at the exchange rate on its own date.
            </p>
          )}
          {convertTarget === 'INVOICE' && (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-[var(--muted)]">{purchase ? 'Expense date' : 'Invoice date'}</span>
                <input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-[var(--muted)]">Due date (blank uses the payment terms)</span>
                <input type="date" value={dueDate} min={documentDate} onChange={(e) => setDueDate(e.target.value)} className={inputClass} />
              </label>
              {purchase && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-[var(--muted)]">Vendor’s invoice no.</span>
                  <input
                    value={vendorReference}
                    maxLength={100}
                    onChange={(e) => setVendorReference(e.target.value)}
                    className={inputClass}
                  />
                </label>
              )}
            </>
          )}
          {dialogError !== null && <p className="status status--bad m-0">{dialogError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn--ghost" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryClass}
              disabled={
                busy ||
                (convertTarget === 'INVOICE' && (documentDate === '' || (purchase && vendorReference.trim() === '')))
              }
              onClick={() =>
                void run(async () => {
                  const { document } = await convertQuote(config.direction, quote.id, {
                    documentDate,
                    dueDate: dueDate === '' ? null : dueDate,
                    vendorReference: purchase ? vendorReference.trim() : null,
                    target: convertTarget,
                  });
                  void navigate(
                    document.kind === 'ORDER'
                      ? `/${purchase ? 'purchase-orders' : 'sales-orders'}/${document.id}`
                      : `/${config.convertPath}/${document.id}`,
                  );
                  return null;
                }, 'Could not convert the quote')
              }
            >
              {convertTarget === 'ORDER'
                ? purchase
                  ? 'Create purchase order'
                  : 'Create sales order'
                : `Create draft ${config.convertNoun}`}
            </button>
          </div>
        </Modal>
      )}

      {dialog === 'delete' && (
        <ConfirmDialog
          title="Delete draft quote?"
          body="The draft is removed. No number has been allocated, so nothing is skipped in the sequence."
          confirmLabel="Delete draft"
          tone="danger"
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() =>
            void run(async () => {
              await deleteQuote(config.direction, quote.id);
              void navigate(`/${config.path}`);
              return null;
            }, 'Could not delete the quote')
          }
        />
      )}
    </section>
  );
}
