import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiRequestError,
  getApFlowDocument,
  getApFlowPageImage,
  listAccounts,
  postApFlowDocument,
  reextractApFlowDocument,
  updateApFlowLineItem,
  type Account,
  type ApFlowDocumentDetail,
  type ApFlowDocumentStatus,
  type ApFlowMappingSource,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import BackLink from '../../components/BackLink';
import ConfirmDialog from '../../components/ConfirmDialog';

/**
 * One captured document, in full: the redacted preview image that proves
 * the pipeline's central claim (the caption says so explicitly), the
 * extracted fields with their confidence, and — from Phase 11 — the
 * side-by-side review: per-line account override and one-click posting
 * into LedgerCore.
 */

function statusLabel(status: ApFlowDocumentStatus): string {
  if (status === 'PENDING') return 'Pending';
  if (status === 'PROCESSING') return 'Processing';
  if (status === 'EXTRACTED') return 'Extracted';
  if (status === 'POSTED') return 'Posted';
  return 'Failed';
}

function confidencePercent(fieldConfidence: Record<string, number>, field: string): string | null {
  const value = fieldConfidence[field];
  return value === undefined ? null : `${String(Math.round(value * 100))}%`;
}

function mappingSourceLabel(source: ApFlowMappingSource): string {
  if (source === 'HISTORY') return 'History';
  if (source === 'CHART') return 'Chart';
  if (source === 'MODEL') return 'AI';
  if (source === 'MANUAL') return 'Manual';
  return 'Unmapped';
}

function mappingSourceClass(source: ApFlowMappingSource): string {
  if (source === 'NONE') {
    return 'bg-red-500/10 text-red-400 ring-1 ring-inset ring-red-500/20';
  }
  return 'bg-sky-500/10 text-sky-400 ring-1 ring-inset ring-sky-500/20';
}

export default function ApFlowDocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const base = useAppBasePath();

  const [document, setDocument] = useState<ApFlowDocumentDetail | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingReextract, setConfirmingReextract] = useState(false);
  const [confirmingPost, setConfirmingPost] = useState(false);
  const [activePage, setActivePage] = useState(1);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (id === undefined) return;
    let ignore = false;

    getApFlowDocument(id)
      .then((res) => {
        if (!ignore) setDocument(res.document);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setNotFound(true);
        } else {
          setError(err instanceof Error ? err.message : 'Could not load this document');
        }
      });

    return () => {
      ignore = true;
    };
  }, [id, reloadToken]);

  useEffect(() => {
    let ignore = false;
    listAccounts()
      .then((res) => {
        if (!ignore) setAccounts(res.accounts.filter((a) => a.isPostable && a.isActive));
      })
      .catch(() => {
        // Non-fatal: the account selects just show nothing to pick from.
      });
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (id === undefined || document === null || document.pages.length === 0) return;
    let ignore = false;
    let objectUrl: string | null = null;

    getApFlowPageImage(id, activePage)
      .then(({ blob }) => {
        if (ignore) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      })
      .catch(() => {
        if (!ignore) setImageUrl(null);
      });

    return () => {
      ignore = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [id, document, activePage]);

  async function handleReextract() {
    if (id === undefined) return;
    setError(null);
    setBusy(true);
    try {
      await reextractApFlowDocument(id);
      setConfirmingReextract(false);
      setActivePage(1);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not start re-extraction');
    } finally {
      setBusy(false);
    }
  }

  async function handleAccountChange(lineItemId: string, accountId: string) {
    if (id === undefined || accountId === '') return;
    setError(null);
    try {
      const res = await updateApFlowLineItem(id, lineItemId, accountId);
      setDocument(res.document);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not update this line item');
    }
  }

  async function handlePost() {
    if (id === undefined) return;
    setError(null);
    setBusy(true);
    try {
      const res = await postApFlowDocument(id);
      setDocument(res.document);
      setConfirmingPost(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not post this document');
    } finally {
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <section className="flex flex-col gap-4">
        <BackLink to={base} label="Back to AP-Flow" />
        <p className="status status--bad">Document not found.</p>
      </section>
    );
  }

  if (document === null) {
    return (
      <section className="flex flex-col gap-4" aria-busy="true">
        <BackLink to={base} label="Back to AP-Flow" />
        <p className="muted">Loading…</p>
      </section>
    );
  }

  const extraction = document.extraction;
  // POSTED is terminal — neither Re-extract nor Post appears for it.
  const canReextract = document.status === 'EXTRACTED' || document.status === 'FAILED';
  const canReview = document.status === 'EXTRACTED';
  const hasUnmappedLine = document.lineItems.some((item) => item.accountId === null);
  const canPost = canReview && (extraction?.arithmeticOk ?? false) && !hasUnmappedLine && document.lineItems.length > 0;
  const postBlockedReason =
    extraction !== null && !extraction.arithmeticOk
      ? "Totals don't reconcile — re-extract before posting."
      : hasUnmappedLine
        ? 'Every line item needs an account before this can be posted.'
        : document.lineItems.length === 0
          ? 'This document needs at least one line item before it can be posted.'
          : null;

  return (
    <section className="flex flex-col gap-5">
      <BackLink to={base} label="Back to AP-Flow" />

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold m-0">{document.originalFilename}</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            {statusLabel(document.status)}
            {document.pageCount !== null && ` · ${String(document.pageCount)} page(s)`}
            {' · captured '}
            {new Date(document.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canReextract && (
            <button type="button" className="btn btn--ghost" onClick={() => setConfirmingReextract(true)}>
              Re-extract
            </button>
          )}
          {canReview && (
            <button
              type="button"
              className="btn"
              disabled={!canPost}
              onClick={() => setConfirmingPost(true)}
            >
              Post to ledger
            </button>
          )}
        </div>
      </header>

      {canReview && postBlockedReason !== null && (
        <p className="text-sm text-[var(--muted)] m-0">{postBlockedReason}</p>
      )}

      {error !== null && <p className="status status--bad">{error}</p>}

      {document.status === 'FAILED' && document.failureReason !== null && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
          <p className="text-sm text-red-400 m-0 font-medium">Extraction failed</p>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">{document.failureReason}</p>
        </div>
      )}

      {document.status === 'POSTED' && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 flex flex-col gap-2">
          <p className="text-sm text-emerald-400 m-0 font-medium">Posted to the ledger</p>
          {document.journalEntryId !== null && (
            <p className="text-sm m-0">
              <Link to={`/app/ledger-core/journals/${document.journalEntryId}`} className="underline">
                View journal entry
              </Link>
            </p>
          )}
          {document.postedAt !== null && (
            <p className="text-sm text-[var(--muted)] m-0">
              Posted {new Date(document.postedAt).toLocaleString()}
            </p>
          )}
          {document.postedSha256 !== null && (
            <div>
              <p className="text-xs text-[var(--muted)] m-0 mb-1">Source document hash at posting</p>
              <p className="font-mono text-xs break-all m-0">{document.postedSha256}</p>
            </div>
          )}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        {document.pages.length > 0 && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-3">
            <p className="text-sm text-[var(--muted)] m-0">
              Redacted preview — this is the image sent to the model
            </p>
            {document.pages.length > 1 && (
              <div className="flex items-center gap-2">
                {document.pages.map((page) => (
                  <button
                    key={page.id}
                    type="button"
                    onClick={() => setActivePage(page.pageNumber)}
                    className={`btn btn--ghost ${activePage === page.pageNumber ? 'font-semibold' : ''}`}
                  >
                    Page {page.pageNumber}
                  </button>
                ))}
              </div>
            )}
            {imageUrl !== null && (
              <img
                src={imageUrl}
                alt={`Redacted preview of page ${String(activePage)}`}
                className="max-w-full border border-[var(--border)] rounded-md"
              />
            )}
          </div>
        )}

        {extraction !== null && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-4">
            {!extraction.arithmeticOk && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-sm text-amber-400 m-0 font-medium">Arithmetic does not check out</p>
                <ul className="text-sm text-[var(--muted)] m-0 mt-1 pl-4 list-disc">
                  {extraction.validationErrors.map((msg) => (
                    <li key={msg}>{msg}</li>
                  ))}
                </ul>
              </div>
            )}

            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm m-0">
              {(
                [
                  ['Vendor', extraction.vendorName, 'vendor_name'],
                  ['Invoice number', extraction.invoiceNumber, 'invoice_number'],
                  ['Invoice date', extraction.invoiceDate, 'invoice_date'],
                  ['Currency', extraction.currency, 'currency'],
                ] as const
              ).map(([label, value, field]) => (
                <div key={field} className="contents">
                  <dt className="text-[var(--muted)]">{label}</dt>
                  <dd className="m-0 flex items-center gap-2">
                    {value ?? '—'}
                    {confidencePercent(extraction.fieldConfidence, field) !== null && (
                      <span className="text-xs text-[var(--muted)]">
                        {confidencePercent(extraction.fieldConfidence, field)}
                      </span>
                    )}
                  </dd>
                </div>
              ))}
              {(
                [
                  ['Subtotal', extraction.subtotalCents, 'subtotal'],
                  ['Tax', extraction.taxCents, 'tax'],
                  ['Total', extraction.totalCents, 'total'],
                ] as const
              ).map(([label, cents, field]) => (
                <div key={field} className="contents">
                  <dt className="text-[var(--muted)]">{label}</dt>
                  <dd className="m-0 flex items-center gap-2">
                    {cents === null ? '—' : formatCents(cents)}
                    {confidencePercent(extraction.fieldConfidence, field) !== null && (
                      <span className="text-xs text-[var(--muted)]">
                        {confidencePercent(extraction.fieldConfidence, field)}
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>

            {document.lineItems.length > 0 && (
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th className="text-left px-2 py-1.5 border-b border-[var(--border)]">Description</th>
                    <th className="text-right px-2 py-1.5 border-b border-[var(--border)]">Amount</th>
                    <th className="text-left px-2 py-1.5 border-b border-[var(--border)]">Account</th>
                    <th className="text-left px-2 py-1.5 border-b border-[var(--border)]">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {document.lineItems.map((item) => (
                    <tr key={item.id}>
                      <td className="px-2 py-1.5 border-b border-[var(--border)]">{item.description}</td>
                      <td className="px-2 py-1.5 border-b border-[var(--border)] text-right">
                        {formatCents(item.amountCents)}
                      </td>
                      <td className="px-2 py-1.5 border-b border-[var(--border)]">
                        <select
                          value={item.accountId ?? ''}
                          disabled={!canReview}
                          aria-label={`Account for ${item.description}`}
                          onChange={(e) => void handleAccountChange(item.id, e.target.value)}
                          className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2 py-1 text-sm text-[var(--text)] disabled:opacity-60"
                        >
                          <option value="">Select…</option>
                          {accounts.map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.code} · {account.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1.5 border-b border-[var(--border)]">
                        <span
                          className={`text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full ${mappingSourceClass(item.mappingSource)}`}
                        >
                          {mappingSourceLabel(item.mappingSource)}
                        </span>
                        {item.mappingConfidence !== null && item.mappingSource !== 'MANUAL' && (
                          <span className="text-xs text-[var(--muted)] ml-1.5">
                            {String(Math.round(item.mappingConfidence * 100))}%
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {confirmingReextract && (
        <ConfirmDialog
          title="Re-extract this document?"
          body="The current extraction, including any account overrides, will be replaced. This cannot be undone."
          confirmLabel="Re-extract"
          busy={busy}
          onConfirm={() => void handleReextract()}
          onCancel={() => setConfirmingReextract(false)}
        />
      )}

      {confirmingPost && (
        <ConfirmDialog
          title="Post this document to the ledger?"
          body="This creates a real journal entry in LedgerCore. It cannot be edited afterwards — a correction requires reversing the entry."
          confirmLabel="Post"
          busy={busy}
          onConfirm={() => void handlePost()}
          onCancel={() => setConfirmingPost(false)}
        />
      )}
    </section>
  );
}
