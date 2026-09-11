import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { listForecasterPlans, type ForecasterPlan, type ForecasterPlanStatus } from '../../services/fetchServices';
import { useAppBasePath } from '../../apps/useAppBasePath';

const STATUS_FILTERS: (ForecasterPlanStatus | 'ALL')[] = ['ALL', 'DRAFT', 'ACTIVE', 'ARCHIVED'];

export default function ForecasterPlansPage() {
  const base = useAppBasePath();
  const [plans, setPlans] = useState<ForecasterPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ForecasterPlanStatus | 'ALL'>('ALL');

  useEffect(() => {
    let ignore = false;
    setPlans(null);
    listForecasterPlans({ ...(statusFilter === 'ALL' ? {} : { status: statusFilter }), limit: 100 })
      .then((res) => {
        if (!ignore) setPlans(res.plans);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load plans');
      });
    return () => {
      ignore = true;
    };
  }, [statusFilter]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Forecast plans</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Driver-based rolling forecasts, headcount plans and zero-based budgets.
          </p>
        </div>
        <Link
          to={`${base}/new`}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium no-underline bg-[var(--text)] text-[var(--bg)]"
        >
          <Plus size={15} aria-hidden="true" /> New plan
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
      {plans === null && error === null && <p className="muted">Loading…</p>}

      {plans !== null && plans.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center flex flex-col items-center gap-3">
          <p className="text-sm text-[var(--muted)] m-0">No plans yet.</p>
          <Link
            to={`${base}/new`}
            className="px-3 py-1.5 rounded-md text-sm font-medium no-underline bg-[var(--text)] text-[var(--bg)]"
          >
            Build the first plan
          </Link>
        </div>
      )}

      {plans !== null && plans.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[40rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Name</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Starts</th>
                <th className="p-3 font-medium">Horizon</th>
                <th className="p-3 font-medium">Actuals through</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => (
                <tr key={plan.id} className="border-t border-[var(--border)]">
                  <td className="p-3">
                    <Link to={`${base}/${plan.id}`} className="text-[var(--text)] no-underline hover:underline">
                      {plan.name}
                    </Link>
                  </td>
                  <td className="p-3 text-[var(--muted)]">{plan.status}</td>
                  <td className="p-3">{plan.startsOn}</td>
                  <td className="p-3">{plan.horizonMonths} mo</td>
                  <td className="p-3">{plan.actualsThrough}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
