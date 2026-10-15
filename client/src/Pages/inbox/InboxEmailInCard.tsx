import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import {
  ApiRequestError,
  getInboundMailAddress,
  listInboundMessages,
  rotateInboundMailAddress,
  type InboundMailMessagesPage,
} from '../../services/fetchServices';
import ConfirmDialog from '../../components/ConfirmDialog';
import Pagination from '../../components/ui/Pagination';
import LoadingState from '../../components/ui/LoadingState';

/**
 * Phase 43d — "Email bills in" on the bill inbox settings page. Shows the
 * organization's address (forwarded PDF/PNG/JPEG attachments land in the bill
 * inbox), a copy button, a rotate action, and the recent message log.
 * When the server answers 404 the feature is off, so the card renders nothing.
 */

const STATUS_LABEL: Record<InboundMailMessagesPage['messages'][number]['status'], string> = {
  RECEIVED: 'Received',
  IMPORTED: 'Imported',
  PARTIAL: 'Partly imported',
  REJECTED: 'Rejected',
  FAILED: 'Failed',
};

export default function InboxEmailInCard() {
  const [address, setAddress] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [messagesPage, setMessagesPage] = useState<InboundMailMessagesPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let ignore = false;
    getInboundMailAddress()
      .then((res) => {
        if (!ignore) setAddress(res.address);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setHidden(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load the email address');
      });
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (address === null || hidden) return;
    let ignore = false;
    listInboundMessages({ page })
      .then((res) => {
        if (!ignore) setMessagesPage(res);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load recent emails');
      });
    return () => {
      ignore = true;
    };
  }, [address, hidden, page]);

  async function handleCopy() {
    if (address === null) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the address is shown on the page to copy by hand.
    }
  }

  async function handleRotate() {
    setError(null);
    setBusy(true);
    try {
      const res = await rotateInboundMailAddress();
      setAddress(res.address);
      setConfirmingRotate(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not generate a new address');
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;

  return (
    <div className="card flex flex-col gap-3">
      <h3 className="text-sm font-semibold m-0 flex items-center gap-1.5">
        <Mail size={14} aria-hidden="true" className="text-[var(--muted)]" /> Email bills in
      </h3>

      {error !== null && <p className="status status--bad">{error}</p>}

      {address === null && error === null && <LoadingState />}

      {address !== null && (
        <>
          <p className="text-sm text-[var(--muted)] m-0">
            Forward a vendor bill to this address. Its PDF, PNG or JPEG attachments land in the bill inbox the same way
            a direct upload does.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <code className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2 py-1 text-xs">{address}</code>
            <button type="button" onClick={() => void handleCopy()} className="btn btn--ghost">
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirmingRotate(true)} className="btn btn--ghost">
              Generate new address
            </button>
          </div>
        </>
      )}

      {messagesPage !== null && messagesPage.totalCount === 0 && (
        <p className="text-sm text-[var(--muted)] m-0">No emails received yet.</p>
      )}

      {messagesPage !== null && messagesPage.totalCount > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[var(--muted)]">
                  <th className="font-medium py-1.5 pr-3">Received</th>
                  <th className="font-medium py-1.5 pr-3">From</th>
                  <th className="font-medium py-1.5 pr-3">Subject</th>
                  <th className="font-medium py-1.5 pr-3">Status</th>
                  <th className="font-medium py-1.5 pr-3">Imported</th>
                </tr>
              </thead>
              <tbody>
                {messagesPage.messages.map((message) => (
                  <tr key={message.id} className="border-t border-[var(--border)]">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{new Date(message.receivedAt).toLocaleString()}</td>
                    <td className="py-1.5 pr-3">{message.fromAddress}</td>
                    <td className="py-1.5 pr-3">{message.subject ?? '—'}</td>
                    <td className="py-1.5 pr-3" title={message.error ?? undefined}>
                      {STATUS_LABEL[message.status]}
                    </td>
                    <td className="py-1.5 pr-3">
                      {message.importedCount} of {message.attachmentCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={messagesPage.currentPage}
            totalPages={messagesPage.totalPages}
            shownCount={messagesPage.messages.length}
            totalCount={messagesPage.totalCount}
            noun="emails"
            onPageChange={setPage}
          />
        </>
      )}

      {confirmingRotate && (
        <ConfirmDialog
          title="Generate a new address?"
          body="The current address will stop working."
          confirmLabel="Generate new address"
          tone="danger"
          busy={busy}
          onConfirm={() => void handleRotate()}
          onCancel={() => setConfirmingRotate(false)}
        />
      )}
    </div>
  );
}
