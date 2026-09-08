import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  ApiRequestError,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoints,
  rotateWebhookSecret,
  updateWebhookEndpoint,
  OUTBOX_EVENT_TYPES,
  type OutboxEventType,
  type WebhookEndpoint,
} from '../../services/fetchServices';
import BackLink from './BackLink';
import ConfirmDialog from './ConfirmDialog';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * Webhook endpoint configuration (Phase 7) — where a tenant registers a
 * receiver for outbound financial-event delivery. OWNER/ADMIN can create
 * and edit; only OWNER can delete an endpoint or rotate its signing key,
 * since both are irreversible.
 *
 * The secret is shown exactly once, right after create or rotate, in a
 * dismissible panel — it is never present in any list or detail response,
 * so a page reload loses it by design.
 */

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

const EVENT_LABELS: Record<OutboxEventType, string> = {
  'invoice.issued': 'Invoice issued',
  'bill.approved': 'Bill approved',
  'payment.recorded': 'Payment recorded',
  'fiscal_period.closed': 'Fiscal period closed',
  'bank.large_unmatched': 'Large unmatched bank line',
};

function SecretPanel({ secret, notice, onDismiss }: { secret: string; notice: string; onDismiss: () => void }) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 flex flex-col gap-2">
      <p className="text-sm font-medium m-0 text-amber-400">{notice}</p>
      <code className="text-xs font-mono break-all bg-[var(--bg)] rounded-md p-2 border border-[var(--border)]">
        {secret}
      </code>
      <button type="button" onClick={onDismiss} className="btn btn--ghost w-fit">
        I've stored it
      </button>
    </div>
  );
}

function EndpointForm({ onCreated, onCancel }: { onCreated: (secret: string, notice: string) => void; onCancel: () => void }) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [eventTypes, setEventTypes] = useState<OutboxEventType[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleEventType(type: OutboxEventType) {
    setEventTypes((current) =>
      current.includes(type) ? current.filter((t) => t !== type) : [...current, type],
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await createWebhookEndpoint({ url: url.trim(), label: label.trim(), eventTypes });
      onCreated(res.endpoint.secret, res.secretNotice);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the endpoint');
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"
    >
      <h3 className="text-sm font-semibold m-0">New endpoint</h3>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
          <span className="text-[var(--muted)]">Label</span>
          <input
            type="text"
            required
            maxLength={100}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm flex-[2] min-w-64">
          <span className="text-[var(--muted)]">URL</span>
          <input
            type="text"
            required
            maxLength={500}
            placeholder="https://hooks.example.com/autoledger"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      <fieldset className="flex flex-col gap-1.5 border-0 p-0 m-0">
        <legend className="text-sm text-[var(--muted)] p-0 mb-1">Events</legend>
        {OUTBOX_EVENT_TYPES.map((type) => (
          <label key={type} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={eventTypes.includes(type)}
              onChange={() => toggleEventType(type)}
            />
            {EVENT_LABELS[type]}
          </label>
        ))}
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || label.trim() === '' || url.trim() === '' || eventTypes.length === 0}
          className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Creating…' : 'Create endpoint'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="btn btn--ghost">
          Cancel
        </button>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
    </form>
  );
}

export default function WebhooksPage() {
  const base = useAppBasePath();
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [revealedSecret, setRevealedSecret] = useState<{ secret: string; notice: string } | null>(null);
  const [rotateTarget, setRotateTarget] = useState<WebhookEndpoint | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WebhookEndpoint | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);

  useEffect(() => {
    let ignore = false;
    setError(null);
    setForbidden(false);

    getWebhookEndpoints()
      .then((res) => {
        if (!ignore) {
          setEndpoints(res.endpoints);
          if (res.endpoints.length === 0) setShowForm(true);
        }
      })
      .catch((err: unknown) => {
        if (ignore) return;
        if (err instanceof ApiRequestError && err.status === 403) {
          setForbidden(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load webhook endpoints');
      });

    return () => {
      ignore = true;
    };
  }, [reloadToken]);

  async function toggleActive(endpoint: WebhookEndpoint) {
    try {
      await updateWebhookEndpoint(endpoint.id, { isActive: !endpoint.isActive });
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not update the endpoint');
    }
  }

  async function confirmRotate() {
    if (rotateTarget === null) return;
    setDialogBusy(true);
    try {
      const res = await rotateWebhookSecret(rotateTarget.id);
      setRotateTarget(null);
      setRevealedSecret({ secret: res.endpoint.secret, notice: res.secretNotice });
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not rotate the secret');
    } finally {
      setDialogBusy(false);
    }
  }

  async function confirmDelete() {
    if (deleteTarget === null) return;
    setDialogBusy(true);
    try {
      await deleteWebhookEndpoint(deleteTarget.id);
      setDeleteTarget(null);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete the endpoint');
    } finally {
      setDialogBusy(false);
    }
  }

  if (forbidden) {
    return (
      <section className="flex flex-col gap-4">
        <BackLink to={base} label="Back to dashboard" />
        <h2 className="text-lg font-semibold m-0">Webhooks</h2>
        <p className="status status--bad">Only an owner or admin can manage webhooks.</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <BackLink to={base} label="Back to dashboard" />

      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Webhooks</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Outbound notifications when a financial event fires.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((open) => !open)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)]"
        >
          <Plus size={15} aria-hidden="true" /> New endpoint
        </button>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      {revealedSecret !== null && (
        <SecretPanel
          secret={revealedSecret.secret}
          notice={revealedSecret.notice}
          onDismiss={() => setRevealedSecret(null)}
        />
      )}

      {showForm && (
        <EndpointForm
          onCreated={(secret, notice) => {
            setShowForm(false);
            setRevealedSecret({ secret, notice });
            setReloadToken((t) => t + 1);
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {endpoints === null && error === null && <p className="muted">Loading…</p>}

      {endpoints !== null && endpoints.length === 0 && !showForm && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center flex flex-col items-center gap-3">
          <p className="text-sm text-[var(--muted)] m-0">No webhook endpoints yet.</p>
        </div>
      )}

      {endpoints !== null && endpoints.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[50rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Label</th>
                <th className="p-3 font-medium">URL</th>
                <th className="p-3 font-medium">Events</th>
                <th className="p-3 font-medium">Active</th>
                <th className="p-3 font-medium">Created</th>
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((endpoint) => (
                <tr key={endpoint.id} className="border-t border-[var(--border)]">
                  <td className="p-3">{endpoint.label}</td>
                  <td className="p-3 font-mono text-xs break-all max-w-xs">{endpoint.url}</td>
                  <td className="p-3 text-[var(--muted)] text-xs">
                    {endpoint.eventTypes.map((t) => EVENT_LABELS[t]).join(', ')}
                  </td>
                  <td className="p-3">
                    {endpoint.isActive ? (
                      <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Active</span>
                    ) : (
                      <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20">
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="p-3 whitespace-nowrap">{new Date(endpoint.createdAt).toLocaleDateString()}</td>
                  <td className="p-3 text-right whitespace-nowrap">
                    <button type="button" onClick={() => void toggleActive(endpoint)} className="btn btn--ghost">
                      {endpoint.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                    <button type="button" onClick={() => setRotateTarget(endpoint)} className="btn btn--ghost">
                      Rotate secret
                    </button>
                    <button type="button" onClick={() => setDeleteTarget(endpoint)} className="btn btn--ghost">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rotateTarget !== null && (
        <ConfirmDialog
          title="Rotate secret"
          body="Rotating the secret breaks the existing receiver until it is updated. Continue?"
          confirmLabel="Rotate"
          busy={dialogBusy}
          onConfirm={() => void confirmRotate()}
          onCancel={() => setRotateTarget(null)}
        />
      )}

      {deleteTarget !== null && (
        <ConfirmDialog
          title="Delete endpoint"
          body="Deleting this endpoint also deletes its delivery history. This cannot be undone."
          confirmLabel="Delete"
          tone="danger"
          busy={dialogBusy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </section>
  );
}
