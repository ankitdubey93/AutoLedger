import { Fragment, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ApiRequestError,
  getWebhookDelivery,
  getWebhookDeliveries,
  getWebhookEndpoints,
  retryWebhookDelivery,
  OUTBOX_EVENT_TYPES,
  type WebhookDelivery,
  type WebhookDeliveryDetail,
  type WebhookDeliveryStatus,
  type WebhookEndpoint,
} from '../../services/fetchServices';
import BackLink from './BackLink';
import ConfirmDialog from './ConfirmDialog';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * The delivery log for outbound financial-event webhooks (Phase 7) — every
 * attempt to reach a subscribed endpoint, its status, and (for FAILED rows)
 * a Retry action gated by confirmation, mirroring BankTransactionsPage's
 * ConfirmDialog-gated actions.
 *
 * Every filter is a server-side query parameter, never a client-side
 * post-filter of one page's rows — the same discipline AuditLogPage follows,
 * so the rendered rows never silently disagree with `totalCount`.
 */

const PAGE_SIZE = 20;

const inputClass =
  'px-2 py-1.5 rounded-md border border-[var(--border)] bg-[var(--panel)] text-sm text-[var(--text)]';

function statusBadge(status: WebhookDeliveryStatus) {
  if (status === 'DELIVERED') {
    return (
      <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
        Delivered
      </span>
    );
  }
  if (status === 'FAILED') {
    return (
      <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 ring-1 ring-inset ring-rose-500/20">
        Failed
      </span>
    );
  }
  return (
    <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 ring-1 ring-inset ring-sky-500/20">
      Pending
    </span>
  );
}

function DetailPanel({ delivery }: { delivery: WebhookDeliveryDetail }) {
  return (
    <div className="flex flex-col gap-2">
      {delivery.lastError !== null && (
        <p className="status status--bad m-0 text-xs font-mono break-all">{delivery.lastError}</p>
      )}
      <div className="overflow-x-auto">
        <pre className="text-xs font-mono bg-[var(--bg)] rounded-md p-3 border border-[var(--border)] m-0">
          {JSON.stringify(delivery.payload, null, 2)}
        </pre>
      </div>
    </div>
  );
}

export default function WebhookDeliveriesPage() {
  const base = useAppBasePath();
  const [params, setParams] = useSearchParams();
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WebhookDeliveryDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [retryTarget, setRetryTarget] = useState<WebhookDelivery | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const page = Number(params.get('page') ?? '1');
  const endpointId = params.get('endpointId') ?? '';
  const status = (params.get('status') ?? '') as WebhookDeliveryStatus | '';
  const eventType = params.get('eventType') ?? '';

  useEffect(() => {
    getWebhookEndpoints()
      .then((res) => setEndpoints(res.endpoints))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setForbidden(false);

    getWebhookDeliveries(
      {
        page,
        limit: PAGE_SIZE,
        ...(endpointId === '' ? {} : { endpointId }),
        ...(status === '' ? {} : { status }),
        ...(eventType === '' ? {} : { eventType }),
      },
      controller.signal,
    )
      .then((res) => {
        setDeliveries(res.deliveries);
        setTotalCount(res.totalCount);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 403) {
          setForbidden(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load deliveries');
      });

    return () => controller.abort();
  }, [page, endpointId, status, eventType, reloadToken]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    next.delete('page');
    setParams(next);
  }

  function setPage(next: number) {
    const nextParams = new URLSearchParams(params);
    nextParams.set('page', String(next));
    setParams(nextParams);
  }

  function toggleRow(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      setDetailError(null);
      return;
    }

    setExpandedId(id);
    setDetail(null);
    setDetailError(null);
    getWebhookDelivery(id)
      .then((res) => setDetail(res.delivery))
      .catch((err: unknown) => {
        setDetailError(err instanceof Error ? err.message : 'Could not load this delivery');
      });
  }

  async function confirmRetry() {
    if (retryTarget === null) return;
    setRetryBusy(true);
    try {
      await retryWebhookDelivery(retryTarget.id);
      setRetryTarget(null);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not retry this delivery');
    } finally {
      setRetryBusy(false);
    }
  }

  if (forbidden) {
    return (
      <section className="flex flex-col gap-4">
        <BackLink to={`${base}/webhooks`} label="Back to webhooks" />
        <h2 className="text-lg font-semibold m-0">Deliveries</h2>
        <p className="status status--bad">Only an owner or admin can view deliveries.</p>
      </section>
    );
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <section className="flex flex-col gap-4">
      <BackLink to={`${base}/webhooks`} label="Back to webhooks" />

      <header>
        <h2 className="text-lg font-semibold m-0">Deliveries</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">Every attempt to reach a subscribed endpoint.</p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          Endpoint
          <select value={endpointId} onChange={(e) => setFilter('endpointId', e.target.value)} className={inputClass}>
            <option value="">All</option>
            {endpoints.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          Status
          <select value={status} onChange={(e) => setFilter('status', e.target.value)} className={inputClass}>
            <option value="">All</option>
            <option value="PENDING">Pending</option>
            <option value="DELIVERED">Delivered</option>
            <option value="FAILED">Failed</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          Event
          <select value={eventType} onChange={(e) => setFilter('eventType', e.target.value)} className={inputClass}>
            <option value="">All</option>
            {OUTBOX_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
      {deliveries === null && error === null && <p className="muted">Loading…</p>}

      {deliveries !== null && deliveries.length === 0 && (
        <p className="text-sm text-[var(--muted)]">No deliveries match these filters.</p>
      )}

      {deliveries !== null && deliveries.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[50rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Created</th>
                <th className="p-3 font-medium">Event</th>
                <th className="p-3 font-medium">Endpoint</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Attempts</th>
                <th className="p-3 font-medium">Code</th>
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <Fragment key={delivery.id}>
                  <tr
                    className="border-t border-[var(--border)] cursor-pointer hover:bg-[var(--bg)]"
                    onClick={() => toggleRow(delivery.id)}
                  >
                    <td className="p-3 whitespace-nowrap">{new Date(delivery.createdAt).toLocaleString()}</td>
                    <td className="p-3 font-mono text-xs">{delivery.eventType}</td>
                    <td className="p-3">{delivery.endpointLabel}</td>
                    <td className="p-3">{statusBadge(delivery.status)}</td>
                    <td className="p-3">{delivery.attemptCount}</td>
                    <td className="p-3">{delivery.lastStatusCode ?? '—'}</td>
                    <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>
                      {delivery.status === 'FAILED' && (
                        <button type="button" onClick={() => setRetryTarget(delivery)} className="btn btn--ghost">
                          Retry
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedId === delivery.id && (
                    <tr className="border-t border-[var(--border)] bg-[var(--bg)]">
                      <td colSpan={7} className="p-3">
                        {detailError !== null && <p className="status status--bad m-0">{detailError}</p>}
                        {detailError === null && detail === null && (
                          <p className="text-sm text-[var(--muted)] m-0">Loading…</p>
                        )}
                        {detail !== null && <DetailPanel delivery={detail} />}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deliveries !== null && totalPages > 1 && (
        <div className="flex items-center gap-3 text-sm">
          <button type="button" className="btn btn--ghost" disabled={page <= 1} onClick={() => setPage(Math.max(1, page - 1))}>
            Previous
          </button>
          <span className="text-[var(--muted)]">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={page >= totalPages}
            onClick={() => setPage(Math.min(totalPages, page + 1))}
          >
            Next
          </button>
        </div>
      )}

      {retryTarget !== null && (
        <ConfirmDialog
          title="Retry delivery"
          body="Send this event to the endpoint again?"
          confirmLabel="Retry"
          busy={retryBusy}
          onConfirm={() => void confirmRetry()}
          onCancel={() => setRetryTarget(null)}
        />
      )}
    </section>
  );
}
