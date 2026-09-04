import { Fragment, useEffect, useState } from 'react';
import {
  ApiRequestError,
  getAuditLogDetail,
  getAuditLogs,
  type AuditLogDetail,
  type AuditLogEntry,
  type AuditOperation,
} from '../../services/fetchServices';

/**
 * The audit trail (Phase 5) — every INSERT/UPDATE/DELETE across every app,
 * captured by database trigger, read here.
 *
 * No `appSlug` filter is applied by default: the trail is platform-level and
 * records `organizations`/`organization_members` changes too, not only
 * LedgerCore's. It is reached from LedgerCore's rail only because LedgerCore
 * is the only app with a UI today — this page moves to the platform shell
 * once a second app ships.
 *
 * No client-side role gating (the Phase 3.7 ruling): the page always
 * attempts the load, and a 403 from the server renders inline rather than
 * being anticipated client-side.
 *
 * Row values in `oldRow`/`newRow` are rendered exactly as the database holds
 * them — including raw integer cents — rather than run through money.ts's
 * formatters. The trail exists to show what is actually stored; formatting
 * it for display would hide the very thing an auditor is checking.
 */

const PAGE_SIZE = 20;

function OperationPill({ operation }: { operation: AuditOperation }) {
  const styles: Record<AuditOperation, string> = {
    INSERT: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20',
    UPDATE: 'bg-amber-500/10 text-amber-400 ring-amber-500/20',
    DELETE: 'bg-rose-500/10 text-rose-400 ring-rose-500/20',
  };
  return (
    <span
      className={`text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full ring-1 ring-inset ${styles[operation]}`}
    >
      {operation}
    </span>
  );
}

function DetailPanel({ log }: { log: AuditLogDetail }) {
  const keys =
    log.operation === 'UPDATE'
      ? (log.changedKeys ?? [])
      : Object.keys(log.newRow ?? log.oldRow ?? {}).sort();

  if (keys.length === 0) {
    return <p className="text-sm text-[var(--muted)] m-0">No field-level changes recorded.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs min-w-[30rem]">
        <thead>
          <tr className="text-left text-[var(--muted)] uppercase tracking-wide">
            <th className="p-2 font-medium">Field</th>
            <th className="p-2 font-medium">Before</th>
            <th className="p-2 font-medium">After</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key} className="border-t border-[var(--border)] align-top">
              <td className="p-2 font-medium">{key}</td>
              <td className="p-2 text-[var(--muted)] font-mono break-all">
                {log.oldRow === null ? '—' : JSON.stringify(log.oldRow[key])}
              </td>
              <td className="p-2 font-mono break-all">
                {log.newRow === null ? '—' : JSON.stringify(log.newRow[key])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AuditLogPage() {
  const [logs, setLogs] = useState<AuditLogEntry[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [appSlug, setAppSlug] = useState('');
  const [tableName, setTableName] = useState('');
  const [operation, setOperation] = useState<AuditOperation | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditLogDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setForbidden(false);

    getAuditLogs(
      {
        page,
        limit: PAGE_SIZE,
        ...(appSlug === '' ? {} : { appSlug }),
        ...(tableName === '' ? {} : { tableName }),
        ...(operation === '' ? {} : { operation }),
      },
      controller.signal,
    )
      .then((res) => {
        setLogs(res.logs);
        setTotalCount(res.totalCount);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 403) {
          setForbidden(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load the audit trail');
      });

    return () => controller.abort();
  }, [page, appSlug, tableName, operation]);

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
    getAuditLogDetail(id)
      .then((res) => setDetail(res.log))
      .catch((err: unknown) => {
        setDetailError(err instanceof Error ? err.message : 'Could not load this entry');
      });
  }

  function onFilterChange(setter: (value: string) => void) {
    return (value: string) => {
      setPage(1);
      setter(value);
    };
  }

  if (forbidden) {
    return (
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold m-0">Audit trail</h2>
        <p className="status status--bad">Only an owner or admin can view the audit trail.</p>
      </section>
    );
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold m-0">Audit trail</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Every record change across the suite, captured at the database.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          App
          <select
            value={appSlug}
            onChange={(e) => onFilterChange(setAppSlug)(e.target.value)}
            className="px-2 py-1.5 rounded-md border border-[var(--border)] bg-[var(--panel)] text-sm text-[var(--text)]"
          >
            <option value="">All</option>
            <option value="platform">Platform</option>
            <option value="ledger-core">LedgerCore</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          Table
          <input
            type="text"
            value={tableName}
            onChange={(e) => onFilterChange(setTableName)(e.target.value)}
            placeholder="e.g. invoices"
            className="px-2 py-1.5 rounded-md border border-[var(--border)] bg-[var(--panel)] text-sm text-[var(--text)]"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          Operation
          <select
            value={operation}
            onChange={(e) => onFilterChange((v) => setOperation(v as AuditOperation | ''))(e.target.value)}
            className="px-2 py-1.5 rounded-md border border-[var(--border)] bg-[var(--panel)] text-sm text-[var(--text)]"
          >
            <option value="">All</option>
            <option value="INSERT">INSERT</option>
            <option value="UPDATE">UPDATE</option>
            <option value="DELETE">DELETE</option>
          </select>
        </label>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
      {logs === null && error === null && <p className="muted">Loading…</p>}

      {logs !== null && logs.length === 0 && (
        <p className="text-sm text-[var(--muted)]">No audit entries match these filters.</p>
      )}

      {logs !== null && logs.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[50rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">When</th>
                <th className="p-3 font-medium">App</th>
                <th className="p-3 font-medium">Table</th>
                <th className="p-3 font-medium">Operation</th>
                <th className="p-3 font-medium">Changed</th>
                <th className="p-3 font-medium">Actor</th>
                <th className="p-3 font-medium">IP</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <Fragment key={log.id}>
                  <tr
                    className="border-t border-[var(--border)] cursor-pointer hover:bg-[var(--bg)]"
                    onClick={() => toggleRow(log.id)}
                  >
                    <td className="p-3 whitespace-nowrap">{new Date(log.createdAt).toLocaleString()}</td>
                    <td className="p-3">{log.appSlug}</td>
                    <td className="p-3 font-mono">{log.tableName}</td>
                    <td className="p-3">
                      <OperationPill operation={log.operation} />
                    </td>
                    <td className="p-3 text-[var(--muted)]">
                      {log.changedKeys !== null && log.changedKeys.length > 0 ? log.changedKeys.join(', ') : '—'}
                    </td>
                    <td className="p-3">{log.actorName ?? log.actorEmail ?? 'System'}</td>
                    <td className="p-3 text-[var(--muted)]">{log.clientIp ?? '—'}</td>
                  </tr>
                  {expandedId === log.id && (
                    <tr className="border-t border-[var(--border)] bg-[var(--bg)]">
                      <td colSpan={7} className="p-3">
                        {detailError !== null && <p className="status status--bad m-0">{detailError}</p>}
                        {detailError === null && detail === null && (
                          <p className="text-sm text-[var(--muted)] m-0">Loading…</p>
                        )}
                        {detail !== null && <DetailPanel log={detail} />}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {logs !== null && totalPages > 1 && (
        <div className="flex items-center gap-3 text-sm">
          <button
            type="button"
            className="btn btn--ghost"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span className="text-[var(--muted)]">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}
