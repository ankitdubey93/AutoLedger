import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { listFpaModels, type FpaModel, type FpaModelStatus } from '../../services/fetchServices';
import { useAppBasePath } from '../../apps/useAppBasePath';

const STATUS_FILTERS: (FpaModelStatus | 'ALL')[] = ['ALL', 'DRAFT', 'ACTIVE', 'ARCHIVED'];

export default function FpaModelsPage() {
  const base = useAppBasePath();
  const [models, setModels] = useState<FpaModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<FpaModelStatus | 'ALL'>('ALL');

  useEffect(() => {
    let ignore = false;
    setModels(null);
    listFpaModels({ ...(statusFilter === 'ALL' ? {} : { status: statusFilter }), limit: 100 })
      .then((res) => {
        if (!ignore) setModels(res.models);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load models');
      });
    return () => {
      ignore = true;
    };
  }, [statusFilter]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">FP&amp;A models</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            A linked 3-statement projection over your posted actuals — one model, several scenarios.
          </p>
        </div>
        <Link
          to={`${base}/new`}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium no-underline bg-[var(--text)] text-[var(--bg)]"
        >
          <Plus size={15} aria-hidden="true" /> New model
        </Link>
      </header>

      <div className="flex gap-2">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={[
              'px-3 py-1 rounded-md text-xs font-medium border cursor-pointer',
              statusFilter === s
                ? 'bg-[var(--text)] text-[var(--bg)] border-transparent'
                : 'bg-transparent text-[var(--muted)] border-[var(--border)]',
            ].join(' ')}
          >
            {s}
          </button>
        ))}
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
      {models === null && error === null && <p className="muted">Loading…</p>}

      {models !== null && models.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center flex flex-col items-center gap-3">
          <p className="text-sm text-[var(--muted)] m-0">No models yet.</p>
          <Link
            to={`${base}/new`}
            className="px-3 py-1.5 rounded-md text-sm font-medium no-underline bg-[var(--text)] text-[var(--bg)]"
          >
            Build the first model
          </Link>
        </div>
      )}

      {models !== null && models.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[40rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Name</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Starts</th>
                <th className="p-3 font-medium">Horizon</th>
                <th className="p-3 font-medium">Scenarios</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr key={model.id} className="border-t border-[var(--border)]">
                  <td className="p-3">
                    <Link to={`${base}/${model.id}`} className="text-[var(--text)] no-underline hover:underline">
                      {model.name}
                    </Link>
                  </td>
                  <td className="p-3 text-[var(--muted)]">{model.status}</td>
                  <td className="p-3">{model.startsOn}</td>
                  <td className="p-3">{model.horizonMonths} mo</td>
                  <td className="p-3">{model.scenarioCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
