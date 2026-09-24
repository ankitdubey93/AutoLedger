import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  connectDriveServiceAccount,
  createDriveFolder,
  deleteDriveFolder,
  disconnectDrive,
  getDriveIntegration,
  startDriveConnect,
  syncDriveFolder,
  type CreateDriveFolderInput,
  type DriveConnection,
  type DriveFolder,
  type DriveModes,
} from '../services/fetchServices';
import ConfirmDialog from '../components/ConfirmDialog';
import DriveFolderForm from './integrations/DriveFolderForm';

/**
 * Platform Integrations — Phase 19.3. One page because a Drive connection now
 * feeds two apps (AP-Flow and LedgerCore) depending on a folder's purpose;
 * there is no single app this belongs under (guardrails rule 16, mirrored on
 * the client: it sits beside /documents, not under /app/:appSlug).
 */

function connectionStatusLabel(connection: DriveConnection | null): string {
  if (connection === null) return 'Not connected';
  if (connection.status === 'PENDING_AUTH') return 'Waiting for Google authorization';
  if (connection.status === 'NEEDS_REAUTH') return 'Access revoked — reconnect';
  return `Connected as ${connection.googleAccountEmail ?? 'unknown account'}`;
}

export default function IntegrationsPage() {
  const [searchParams] = useSearchParams();
  const driveParam = searchParams.get('drive');

  const [loaded, setLoaded] = useState(false);
  const [connection, setConnection] = useState<DriveConnection | null>(null);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [modes, setModes] = useState<DriveModes>({ oauth: false, serviceAccount: false, serviceAccountEmail: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let ignore = false;
    getDriveIntegration()
      .then((res) => {
        if (ignore) return;
        setConnection(res.connection);
        setFolders(res.folders);
        setModes(res.modes);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load Google Drive status');
      });
    return () => {
      ignore = true;
    };
  }, [reloadToken]);

  async function handleConnectServiceAccount() {
    setError(null);
    setBusy(true);
    try {
      await connectDriveServiceAccount();
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not connect the service account');
    } finally {
      setBusy(false);
    }
  }

  async function handleConnectOAuth() {
    setError(null);
    setBusy(true);
    try {
      const res = await startDriveConnect();
      window.location.assign(res.authorizationUrl);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not start the Google Drive connection');
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setError(null);
    setBusy(true);
    try {
      await disconnectDrive();
      setConfirmingDisconnect(false);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not disconnect Google Drive');
    } finally {
      setBusy(false);
    }
  }

  async function handleAddFolder(input: CreateDriveFolderInput) {
    setError(null);
    setBusy(true);
    try {
      await createDriveFolder(input);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not add the folder');
    } finally {
      setBusy(false);
    }
  }

  async function handleSyncNow(folderId: string) {
    setError(null);
    setBusy(true);
    try {
      await syncDriveFolder(folderId);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not start a sync');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteFolder(folderId: string) {
    setError(null);
    setBusy(true);
    try {
      await deleteDriveFolder(folderId);
      setConfirmingDeleteId(null);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not remove the folder');
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyServiceAccountEmail() {
    if (modes.serviceAccountEmail === null) return;
    try {
      await navigator.clipboard.writeText(modes.serviceAccountEmail);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied by the browser; the address is still
      // visible on the page to copy by hand.
    }
  }

  const notConfigured = loaded && !modes.serviceAccount && !modes.oauth;

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold m-0">Integrations</h2>
        <p className="text-sm text-[var(--muted)] m-0">
          Connect a Google Drive folder and files dropped into it are picked up automatically — vendor bills go to
          AP-Flow, bank statements go to LedgerCore.
        </p>
      </header>

      {driveParam === 'connected' && <p className="status status--good">Google Drive connected — now add a folder.</p>}
      {driveParam === 'error' && <p className="status status--bad">Google Drive could not be connected. Try again.</p>}
      {error !== null && <p className="status status--bad">{error}</p>}

      {!loaded && error === null && <p className="muted">Loading…</p>}

      {notConfigured && (
        <p className="text-sm text-[var(--muted)] m-0">
          Google Drive intake is not configured on this server. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and
          GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (recommended), or GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and
          INTEGRATION_ENCRYPTION_KEY, in server/.env.
        </p>
      )}

      {loaded && !notConfigured && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-3">
          <h3 className="text-sm font-semibold m-0">Google Drive</h3>
          <p className="text-sm m-0">{connectionStatusLabel(connection)}</p>

          {connection === null && modes.serviceAccount && modes.serviceAccountEmail !== null && (
            <div className="flex flex-col gap-2 text-sm">
              <p className="m-0">
                1. In Google Drive, share your folder with this address — Viewer is enough:
              </p>
              <div className="flex items-center gap-2">
                <code className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2 py-1 text-xs">
                  {modes.serviceAccountEmail}
                </code>
                <button type="button" onClick={() => void handleCopyServiceAccountEmail()} className="btn btn--ghost">
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="m-0">2. Then connect below, and add the folder.</p>
              <button type="button" disabled={busy} onClick={() => void handleConnectServiceAccount()} className="btn self-start">
                Connect with service account
              </button>
            </div>
          )}

          {(connection === null || connection.authMode === 'OAUTH') && modes.oauth && (
            <button type="button" disabled={busy} onClick={() => void handleConnectOAuth()} className="btn btn--ghost self-start">
              {connection?.status === 'NEEDS_REAUTH' ? 'Reconnect' : 'Connect with your Google account instead'}
            </button>
          )}

          {connection !== null && connection.status === 'CONNECTED' && (
            <button type="button" disabled={busy} onClick={() => setConfirmingDisconnect(true)} className="btn btn--ghost self-start">
              Disconnect
            </button>
          )}

          {connection !== null && connection.status === 'CONNECTED' && (
            <>
              <h4 className="text-sm font-semibold m-0 mt-2">Watched folders</h4>

              {folders.length === 0 && <p className="text-sm text-[var(--muted)] m-0">No folders yet.</p>}

              {folders.map((folder) => (
                <div key={folder.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {folder.folderName}{' '}
                      <span className="text-[var(--muted)] font-normal">
                        · {folder.purpose === 'VENDOR_BILL' ? 'Vendor bills' : 'Bank statements'}
                      </span>
                    </span>
                    <div className="flex items-center gap-2">
                      <button type="button" disabled={busy} onClick={() => void handleSyncNow(folder.id)} className="btn btn--ghost">
                        Sync now
                      </button>
                      <button type="button" disabled={busy} onClick={() => setConfirmingDeleteId(folder.id)} className="btn btn--ghost">
                        Remove
                      </button>
                    </div>
                  </div>
                  {folder.purpose === 'BANK_STATEMENT' && folder.ledgerAccountCode !== null && (
                    <p className="text-sm text-[var(--muted)] m-0">Account {folder.ledgerAccountCode}</p>
                  )}
                  {folder.lastSyncedAt !== null && (
                    <p className="text-sm text-[var(--muted)] m-0">
                      Last synced {new Date(folder.lastSyncedAt).toLocaleString()} · {folder.importedFileCount} imported ·{' '}
                      {folder.skippedFileCount} skipped
                    </p>
                  )}
                  {folder.lastSyncError !== null && <p className="status status--bad">{folder.lastSyncError}</p>}
                </div>
              ))}

              <DriveFolderForm busy={busy} onSubmit={(input) => void handleAddFolder(input)} />
            </>
          )}
        </div>
      )}

      {confirmingDisconnect && (
        <ConfirmDialog
          title="Disconnect Google Drive?"
          body="Files already imported stay where they landed. Only the connection and its folders are removed."
          confirmLabel="Disconnect"
          tone="danger"
          busy={busy}
          onConfirm={() => void handleDisconnect()}
          onCancel={() => setConfirmingDisconnect(false)}
        />
      )}

      {confirmingDeleteId !== null && (
        <ConfirmDialog
          title="Remove this folder?"
          body="Files already imported stay where they landed. New files added to this Drive folder will no longer be picked up."
          confirmLabel="Remove"
          tone="danger"
          busy={busy}
          onConfirm={() => void handleDeleteFolder(confirmingDeleteId)}
          onCancel={() => setConfirmingDeleteId(null)}
        />
      )}
    </section>
  );
}
