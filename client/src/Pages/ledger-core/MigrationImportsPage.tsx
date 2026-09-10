import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { listMigrationImports, type MigrationImport } from '../../services/fetchServices';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * The register of staged migration imports (Phase 9b) — chart-of-accounts
 * and opening-balance CSVs, each staged before it is ever committed.
 */

const STATUS_LABEL: Record<MigrationImport['status'], string> = {
  DRAFT: 'Draft',
  VALIDATED: 'Validated',
  COMMITTED: 'Committed',
};

const KIND_LABEL: Record<MigrationImport['kind'], string> = {
  CHART_OF_ACCOUNTS: 'Chart of accounts',
  OPENING_BALANCES: 'Opening balances',
};

export default function MigrationImportsPage() {
  const base = useAppBasePath();
  const [imports, setImports] = useState<MigrationImport[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    listMigrationImports()
      .then((res) => {
        if (!ignore) setImports(res.imports);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load imports');
      });

    return () => {
      ignore = true;
    };
  }, []);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Data migration</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            A business moving off another system's way in — stage a chart-of-accounts or
            opening-balance CSV, fix what's wrong, then commit once.
          </p>
        </div>
        <Link
          to={`${base}/migration-imports/new`}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] no-underline"
        >
          <Plus size={15} aria-hidden="true" /> New import
        </Link>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {imports === null && error === null && <p className="muted">Loading…</p>}

      {imports !== null && imports.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center flex flex-col items-center gap-3">
          <p className="text-sm text-[var(--muted)] m-0">No imports yet.</p>
          <Link
            to={`${base}/migration-imports/new`}
            className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] no-underline"
          >
            Start the first import
          </Link>
        </div>
      )}

      {imports !== null && imports.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[42rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Kind</th>
                <th className="p-3 font-medium">File</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Rows</th>
                <th className="p-3 font-medium">Errors</th>
                <th className="p-3 font-medium">Created by</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((imp) => (
                <tr key={imp.id} className="border-t border-[var(--border)]">
                  <td className="p-3">{KIND_LABEL[imp.kind]}</td>
                  <td className="p-3">
                    <Link to={`${base}/migration-imports/${imp.id}`}>{imp.fileName}</Link>
                  </td>
                  <td className="p-3">
                    <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                      {STATUS_LABEL[imp.status]}
                    </span>
                  </td>
                  <td className="p-3">{imp.rowCount}</td>
                  <td className="p-3">{imp.errorCount}</td>
                  <td className="p-3">{imp.createdByName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
