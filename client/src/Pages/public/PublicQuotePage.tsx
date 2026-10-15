import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, Download, Printer, XCircle } from 'lucide-react';
import {
  acceptPublicQuote,
  ApiRequestError,
  declinePublicQuote,
  downloadPublicQuotePdf,
  getPublicQuote,
  getPublicQuoteLogo,
  type PublicQuoteView,
  requestPublicQuoteCode,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { formatDate } from '../../utils/date';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../components/ui/formClasses';
import QuoteDocument from '../sales/quotes/QuoteDocument';

/**
 * The page an emailed quote links to (Phase 41). Public: no session, no app
 * shell — the token in the URL is the only credential, and the server
 * resolves the organization from it.
 *
 * The recipient reads the quote exactly as it was frozen when sent, then
 * accepts it by typing their full name and ticking that they accept the
 * terms — or declines it, optionally saying why. The acceptance carries the
 * fingerprint of the content shown here, so a quote changed in the meantime
 * is refused rather than accepted unseen.
 */

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

export default function PublicQuotePage() {
  const { token = '' } = useParams<{ token: string }>();
  const [view, setView] = useState<PublicQuoteView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [logoSrc, setLogoSrc] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const [mode, setMode] = useState<'accept' | 'decline'>('accept');
  const [signerName, setSignerName] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [sendingCode, setSendingCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getPublicQuote(token, controller.signal)
      .then((res) => setView(res.quote))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(
          err instanceof ApiRequestError && err.status === 404
            ? 'This quote link is not valid or has expired. Please contact the sender for a new one.'
            : err instanceof Error
              ? err.message
              : 'Could not load the quote',
        );
      });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (view?.merchant.hasLogo !== true) return;
    const controller = new AbortController();
    let url: string | null = null;
    getPublicQuoteLogo(token, controller.signal)
      .then((blob) => {
        if (blob === null || controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setLogoSrc(url);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [token, view?.merchant.hasLogo]);

  async function downloadPdf() {
    if (view === null) return;
    setPdfError(null);
    try {
      const blob = await downloadPublicQuotePdf(token);
      saveBlob(blob, `${view.quoteNumber}.pdf`);
    } catch (err: unknown) {
      setPdfError(err instanceof Error ? err.message : 'Could not download the PDF');
    }
  }

  async function sendCode() {
    const email = signerEmail.trim();
    setSendingCode(true);
    setError(null);
    try {
      await requestPublicQuoteCode(token, email);
      setCodeSentTo(email);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not send the code');
    } finally {
      setSendingCode(false);
    }
  }

  async function respond() {
    if (view === null) return;
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === 'accept'
          ? await acceptPublicQuote(token, {
              signerName: signerName.trim(),
              signerEmail: signerEmail.trim() === '' ? null : signerEmail.trim(),
              acceptTerms: true,
              contentSha256: view.contentSha256,
              code: view.requiresEmailCode ? code.trim() : null,
            })
          : await declinePublicQuote(token, reason.trim() === '' ? null : reason.trim());
      setView(res.quote);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not send your response');
    } finally {
      setBusy(false);
    }
  }

  if (loadError !== null) {
    return (
      <main className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center p-6">
        <p className="status status--bad max-w-md">{loadError}</p>
      </main>
    );
  }

  if (view === null) {
    return (
      <main className="min-h-screen bg-[var(--bg)] p-6" aria-busy="true">
        <div className="skeleton skeleton--card max-w-5xl mx-auto" />
      </main>
    );
  }

  const purchase = view.direction === 'PURCHASE';
  const noun = purchase ? 'price confirmation' : 'quote';
  const emailReady = !view.requiresEmailCode || signerEmail.trim() !== '';
  const codeReady = !view.requiresEmailCode || /^\d{6}$/.test(code.trim());
  const canAccept = signerName.trim() !== '' && agreed && emailReady && codeReady && !busy;

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="no-print border-b border-[var(--border)] bg-[var(--panel)]">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3">
          {logoSrc !== null && <img src={logoSrc} alt="" className="max-h-10 max-w-[8rem] object-contain" />}
          <div>
            <p className="m-0 font-semibold">{view.merchant.name}</p>
            <p className="m-0 text-xs text-[var(--muted)]">{purchase ? 'Price confirmation request' : 'Quote'}</p>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="flex flex-col gap-4 min-w-0" aria-label="Quote">
          <div className="no-print">
            <h1 className="text-xl font-semibold m-0">Hi {view.partyName}</h1>
            <p className="text-sm text-[var(--muted)] m-0 mt-1">
              {view.merchant.name} has sent you {purchase ? 'a price confirmation request' : 'a quote'} for{' '}
              {formatCents(view.totalCents)} {view.currencyCode}, valid until {formatDate(view.validUntil)}.
            </p>
          </div>
          <QuoteDocument
            quote={view}
            merchantName={view.merchant.name}
            merchantAddressLines={view.merchant.addressLines}
            logoSrc={logoSrc}
          />
        </section>

        <aside className="no-print lg:sticky lg:top-6 lg:self-start flex flex-col gap-3">
          {view.response !== null && (
            <div
              className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-2 text-sm"
              role="status"
            >
              {view.response.response === 'ACCEPTED' ? (
                <p className="m-0 font-semibold flex items-center gap-2 text-[var(--good)]">
                  <CheckCircle2 size={18} aria-hidden="true" /> Accepted
                </p>
              ) : (
                <p className="m-0 font-semibold flex items-center gap-2">
                  <XCircle size={18} aria-hidden="true" /> Declined
                </p>
              )}
              <p className="m-0 text-[var(--muted)]">
                {view.response.response === 'ACCEPTED' && view.response.signerName !== null
                  ? `Accepted by ${view.response.signerName} on ${new Date(view.response.respondedAt).toLocaleString()}.`
                  : `Recorded on ${new Date(view.response.respondedAt).toLocaleString()}.`}{' '}
                {view.merchant.name} has been notified.
              </p>
            </div>
          )}

          {view.response === null && !view.canRespond && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 text-sm" role="status">
              <p className="m-0 font-semibold">
                {view.effectiveStatus === 'EXPIRED' ? 'This quote has expired' : 'This quote is no longer open'}
              </p>
              <p className="m-0 mt-1 text-[var(--muted)]">
                {view.effectiveStatus === 'EXPIRED'
                  ? `It was valid until ${formatDate(view.validUntil)}. Contact ${view.merchant.name} for an updated quote.`
                  : `Contact ${view.merchant.name} if you have questions.`}
              </p>
            </div>
          )}

          {view.canRespond && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-3 text-sm">
              <div className="flex gap-1" role="tablist" aria-label="Your response">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'accept'}
                  onClick={() => setMode('accept')}
                  className={mode === 'accept' ? primaryButtonClass : secondaryButtonClass}
                >
                  {purchase ? 'Confirm' : 'Accept'}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'decline'}
                  onClick={() => setMode('decline')}
                  className={mode === 'decline' ? primaryButtonClass : secondaryButtonClass}
                >
                  Decline
                </button>
              </div>

              {mode === 'accept' ? (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-[var(--muted)]">Your full name</span>
                    <input
                      value={signerName}
                      maxLength={200}
                      autoComplete="name"
                      onChange={(e) => setSignerName(e.target.value)}
                      className={inputClass}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[var(--muted)]">
                      {view.requiresEmailCode ? 'Your email' : 'Your email (optional)'}
                    </span>
                    <input
                      type="email"
                      value={signerEmail}
                      maxLength={254}
                      autoComplete="email"
                      required={view.requiresEmailCode}
                      onChange={(e) => setSignerEmail(e.target.value)}
                      className={inputClass}
                    />
                  </label>
                  {view.requiresEmailCode && (
                    <div className="flex flex-col gap-2">
                      <button
                        type="button"
                        className={secondaryButtonClass}
                        disabled={signerEmail.trim() === '' || sendingCode}
                        onClick={() => void sendCode()}
                      >
                        {sendingCode ? 'Sending…' : 'Send code'}
                      </button>
                      {codeSentTo !== null && (
                        <p className="m-0 text-xs text-[var(--muted)]">We emailed a 6-digit code to {codeSentTo}.</p>
                      )}
                      <label className="flex flex-col gap-1">
                        <span className="text-[var(--muted)]">Verification code</span>
                        <input
                          value={code}
                          inputMode="numeric"
                          maxLength={6}
                          autoComplete="one-time-code"
                          onChange={(e) => setCode(e.target.value)}
                          className={inputClass}
                        />
                      </label>
                    </div>
                  )}
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" />
                    <span>
                      I have read this {noun}
                      {view.terms !== null ? ' and its terms and conditions' : ''}, and I accept it on behalf of{' '}
                      {view.partyName}.
                    </span>
                  </label>
                  <p className="m-0 text-xs text-[var(--muted)]">
                    Your name, the time, your IP address and browser are recorded with your acceptance.
                  </p>
                  <button type="button" className={primaryButtonClass} disabled={!canAccept} onClick={() => void respond()}>
                    {busy ? 'Sending…' : `${purchase ? 'Confirm' : 'Accept'} ${formatCents(view.totalCents)} ${view.currencyCode}`}
                  </button>
                </>
              ) : (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-[var(--muted)]">Reason (optional)</span>
                    <textarea
                      value={reason}
                      maxLength={1000}
                      rows={3}
                      onChange={(e) => setReason(e.target.value)}
                      className={inputClass}
                    />
                  </label>
                  <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void respond()}>
                    {busy ? 'Sending…' : `Decline this ${noun}`}
                  </button>
                </>
              )}
              {error !== null && <p className="status status--bad m-0">{error}</p>}
            </div>
          )}

          {pdfError !== null && <p className="status status--bad m-0">{pdfError}</p>}
          <button type="button" className={secondaryButtonClass} onClick={() => void downloadPdf()}>
            <span className="inline-flex items-center gap-1.5">
              <Download size={15} aria-hidden="true" /> Download PDF
            </span>
          </button>

          <button type="button" className={secondaryButtonClass} onClick={() => window.print()}>
            <span className="inline-flex items-center gap-1.5">
              <Printer size={15} aria-hidden="true" /> Print {noun}
            </span>
          </button>
        </aside>
      </div>
    </main>
  );
}
