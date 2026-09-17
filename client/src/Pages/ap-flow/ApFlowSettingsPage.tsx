import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  disconnectApFlowDrive,
  getApFlowDriveConnection,
  getApFlowSettings,
  setApFlowDriveFolder,
  startApFlowDriveConnect,
  syncApFlowDrive,
  updateApFlowSettings,
  type ApFlowDriveConnection,
} from '../../services/fetchServices';
import { formatCents, parseCentsInput } from '../../utils/money';
import BackLink from '../../components/BackLink';
import ConfirmDialog from '../../components/ConfirmDialog';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * AP-Flow's settings page — the auto-post gate a reviewer or owner tunes
 * (Phase 19), plus the Google Drive folder connection (Phase 19.2).
 */

function driveStatusLabel(connection: ApFlowDriveConnection | null): string {
  if (connection === null) return 'Not connected';
  if (connection.status === 'PENDING_AUTH') return 'Waiting for Google authorization';
  if (connection.status === 'NEEDS_REAUTH') return 'Access revoked — reconnect';
  return `Connected as ${connection.googleAccountEmail ?? 'unknown account'}`;
}

export default function ApFlowSettingsPage() {
  const base = useAppBasePath();
  const [searchParams] = useSearchParams();

  const [loaded, setLoaded] = useState(false);
  const [autoPostEnabled, setAutoPostEnabled] = useState(false);
  const [minConfidence, setMinConfidence] = useState('0.90');
  const [maxTotal, setMaxTotal] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [driveConfigured, setDriveConfigured] = useState(false);
  const [connection, setConnection] = useState<ApFlowDriveConnection | null>(null);
  const [driveLoaded, setDriveLoaded] = useState(false);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [folderInput, setFolderInput] = useState('');
  const [driveBusy, setDriveBusy] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [driveReloadToken, setDriveReloadToken] = useState(0);

  const driveParam = searchParams.get('drive');

  useEffect(() => {
    let ignore = false;
    getApFlowSettings()
      .then((res) => {
        if (ignore) return;
        setAutoPostEnabled(res.settings.autoPostEnabled);
        setMinConfidence(res.settings.autoPostMinConfidence.toFixed(2));
        setMaxTotal(res.settings.autoPostMaxTotalCents === null ? '' : formatCents(res.settings.autoPostMaxTotalCents));
        setUpdatedAt(res.settings.updatedAt);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load settings');
      });
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    getApFlowDriveConnection()
      .then((res) => {
        if (ignore) return;
        setDriveConfigured(res.configured);
        setConnection(res.connection);
        setFolderInput(res.connection?.folderId ?? '');
        setDriveLoaded(true);
      })
      .catch((err: unknown) => {
        if (!ignore) setDriveError(err instanceof Error ? err.message : 'Could not load Google Drive status');
      });
    return () => {
      ignore = true;
    };
  }, [driveReloadToken]);

  async function handleSave() {
    setError(null);
    setSaved(false);

    const confidence = Number(minConfidence);
    if (!Number.isFinite(confidence) || confidence < 0.5 || confidence > 1) {
      setError('Minimum confidence must be between 0.5 and 1');
      return;
    }

    let maxTotalCents: number | null = null;
    if (maxTotal.trim() !== '') {
      const parsed = parseCentsInput(maxTotal);
      if (parsed === null || parsed <= 0) {
        setError('Enter an amount like 1500.00, or leave it blank for no limit');
        return;
      }
      maxTotalCents = parsed;
    }

    setSaving(true);
    try {
      const res = await updateApFlowSettings({
        autoPostEnabled,
        autoPostMinConfidence: confidence,
        autoPostMaxTotalCents: maxTotalCents,
      });
      setUpdatedAt(res.settings.updatedAt);
      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save settings');
    } finally {
      setSaving(false);
    }
  }

  async function handleConnect() {
    setDriveError(null);
    setDriveBusy(true);
    try {
      const res = await startApFlowDriveConnect();
      window.location.assign(res.authorizationUrl);
    } catch (err: unknown) {
      setDriveError(err instanceof Error ? err.message : 'Could not start the Google Drive connection');
      setDriveBusy(false);
    }
  }

  async function handleSaveFolder() {
    setDriveError(null);
    setDriveBusy(true);
    try {
      const res = await setApFlowDriveFolder(folderInput);
      setConnection(res.connection);
    } catch (err: unknown) {
      setDriveError(err instanceof Error ? err.message : 'Could not save the folder');
    } finally {
      setDriveBusy(false);
    }
  }

  async function handleSyncNow() {
    setDriveError(null);
    setDriveBusy(true);
    try {
      await syncApFlowDrive();
      setDriveReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setDriveError(err instanceof Error ? err.message : 'Could not start a sync');
    } finally {
      setDriveBusy(false);
    }
  }

  async function handleDisconnect() {
    setDriveError(null);
    setDriveBusy(true);
    try {
      await disconnectApFlowDrive();
      setConnection(null);
      setFolderInput('');
      setConfirmingDisconnect(false);
    } catch (err: unknown) {
      setDriveError(err instanceof Error ? err.message : 'Could not disconnect Google Drive');
    } finally {
      setDriveBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 max-w-xl">
      <BackLink to={base} label="AP-Flow" />
      <header>
        <h2 className="text-lg font-semibold m-0">AP-Flow settings</h2>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      {!loaded && error === null && <p className="muted">Loading…</p>}

      {loaded && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-3">
          <h3 className="text-sm font-semibold m-0">Auto-posting</h3>
          <p className="text-sm text-[var(--muted)] m-0">
            Documents that fail any check stay in the review queue with the reason shown.
          </p>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoPostEnabled}
              onChange={(e) => setAutoPostEnabled(e.target.checked)}
            />
            Post automatically when every check passes
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Minimum confidence</span>
            <input
              type="number"
              min={0.5}
              max={1}
              step={0.01}
              value={minConfidence}
              onChange={(e) => setMinConfidence(e.target.value)}
              className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] max-w-[10rem]"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Auto-post limit (base currency, blank for none)</span>
            <input
              type="text"
              placeholder="e.g. 1500.00"
              value={maxTotal}
              onChange={(e) => setMaxTotal(e.target.value)}
              className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] max-w-[12rem]"
            />
          </label>

          <div className="flex items-center gap-3">
            <button type="button" disabled={saving} onClick={() => void handleSave()} className="btn">
              Save
            </button>
            {saved && <span className="text-emerald-400 text-sm">Saved</span>}
            {updatedAt !== null && (
              <span className="text-[var(--muted)] text-sm">Last saved {new Date(updatedAt).toLocaleString()}</span>
            )}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-3">
        <h3 className="text-sm font-semibold m-0">Google Drive</h3>

        {driveParam === 'connected' && (
          <p className="status status--good">Google Drive connected — now choose a folder.</p>
        )}
        {driveParam === 'error' && (
          <p className="status status--bad">Google Drive could not be connected. Try again.</p>
        )}
        {driveError !== null && <p className="status status--bad">{driveError}</p>}

        {!driveLoaded && driveError === null && <p className="muted">Loading…</p>}

        {driveLoaded && !driveConfigured && (
          <p className="text-sm text-[var(--muted)] m-0">
            Google Drive intake is not configured on this server. Set GOOGLE_OAUTH_CLIENT_ID,
            GOOGLE_OAUTH_CLIENT_SECRET and INTEGRATION_ENCRYPTION_KEY in server/.env.
          </p>
        )}

        {driveLoaded && driveConfigured && (
          <>
            <p className="text-sm m-0">{driveStatusLabel(connection)}</p>

            <div className="flex items-center gap-2">
              <button type="button" disabled={driveBusy} onClick={() => void handleConnect()} className="btn btn--ghost">
                {connection !== null && connection.status === 'NEEDS_REAUTH' ? 'Reconnect' : 'Connect Google Drive'}
              </button>
              {connection !== null && connection.status === 'CONNECTED' && (
                <button
                  type="button"
                  disabled={driveBusy}
                  onClick={() => setConfirmingDisconnect(true)}
                  className="btn btn--ghost"
                >
                  Disconnect
                </button>
              )}
            </div>

            {connection !== null && connection.status === 'CONNECTED' && (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-[var(--muted)]">Drive folder</span>
                  <input
                    type="text"
                    placeholder="Paste a Google Drive folder link"
                    value={folderInput}
                    onChange={(e) => setFolderInput(e.target.value)}
                    className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]"
                  />
                </label>

                <div className="flex items-center gap-2">
                  <button type="button" disabled={driveBusy} onClick={() => void handleSaveFolder()} className="btn btn--ghost">
                    Save folder
                  </button>
                  <button
                    type="button"
                    disabled={driveBusy || connection.folderId === null}
                    onClick={() => void handleSyncNow()}
                    className="btn"
                  >
                    Sync now
                  </button>
                </div>

                {connection.lastSyncedAt !== null && (
                  <p className="text-sm text-[var(--muted)] m-0">
                    Last synced {new Date(connection.lastSyncedAt).toLocaleString()}
                    {' · '}
                    {connection.importedFileCount} imported · {connection.skippedFileCount} skipped
                  </p>
                )}
                {connection.lastSyncError !== null && (
                  <p className="status status--bad">{connection.lastSyncError}</p>
                )}
              </>
            )}
          </>
        )}
      </div>

      {confirmingDisconnect && (
        <ConfirmDialog
          title="Disconnect Google Drive?"
          body="Files already imported stay in AP-Flow. Only the connection itself is removed."
          confirmLabel="Disconnect"
          tone="danger"
          busy={driveBusy}
          onConfirm={() => void handleDisconnect()}
          onCancel={() => setConfirmingDisconnect(false)}
        />
      )}
    </section>
  );
}
