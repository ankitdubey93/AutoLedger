import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchBoardDeckBva,
  listForecasterPlans,
  ApiRequestError,
  type BoardDeckBva,
  type ForecasterPlan,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

/**
 * Budget-vs-actual at board grain: four sections (Revenue, Cost of Sales,
 * Operating Expenses, Other — always all four, even at zero) plus the top
 * variance drivers.
 *
 * A 422 from a plan with no approved budget version renders a clean empty
 * state with a link to ForecasterPro, never a raw error — the posture
 * UniteconPvmPage established for its own 422.
 */
export default function BoardDeckBvaPage() {
  const [plans, setPlans] = useState<ForecasterPlan[]>([]);
  const [planId, setPlanId] = useState('');
  const [bva, setBva] = useState<BoardDeckBva | null>(null);
  const [needsApprovedBudget, setNeedsApprovedBudget] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listForecasterPlans()
      .then((res) => {
        setPlans(res.plans);
        if (res.plans.length > 0 && res.plans[0] !== undefined) setPlanId(res.plans[0].id);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load plans'));
  }, []);

  useEffect(() => {
    if (planId === '') return;
    let ignore = false;
    setError(null);
    setNeedsApprovedBudget(false);
    fetchBoardDeckBva(planId)
      .then((res) => {
        if (!ignore) setBva(res.bva);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        if (err instanceof ApiRequestError && err.status === 422) {
          setNeedsApprovedBudget(true);
          setBva(null);
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load budget vs actual');
      });
    return () => {
      ignore = true;
    };
  }, [planId]);

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold m-0">Budget vs Actual</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Board-grade variance summary and top drivers for the selected plan.
        </p>
      </header>

      <label className="flex flex-col gap-1 max-w-sm">
        <span className="text-xs text-[var(--muted)]">Plan</span>
        <select value={planId} onChange={(e) => setPlanId(e.target.value)} className={inputClass}>
          <option value="">Select…</option>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      {error !== null && <p className="status status--bad">{error}</p>}

      {needsApprovedBudget && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center">
          <p className="text-sm text-[var(--muted)] m-0">
            This plan has no approved budget version.{' '}
            <Link to="/app/forecaster" className="text-[var(--text)] underline">
              Go to ForecasterPro
            </Link>
            .
          </p>
        </div>
      )}

      {bva !== null && (
        <>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium">Section</th>
                  <th className="p-3 font-medium text-right">Budget</th>
                  <th className="p-3 font-medium text-right">Actual</th>
                  <th className="p-3 font-medium text-right">Variance</th>
                  <th className="p-3 font-medium text-right">Fav/Unfav</th>
                </tr>
              </thead>
              <tbody>
                {bva.summary.sections.map((s) => (
                  <tr key={s.section} className="border-t border-[var(--border)]">
                    <td className="p-3">{s.section}</td>
                    <td className="p-3 text-right font-mono">{formatCents(s.budgetCents)}</td>
                    <td className="p-3 text-right font-mono">{formatCents(s.actualCents)}</td>
                    <td className="p-3 text-right font-mono">{formatCents(s.varianceCents)}</td>
                    <td className="p-3 text-right">{s.favourable ? 'Fav' : 'Unfav'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-[var(--border)] font-medium">
                  <td className="p-3">Total</td>
                  <td className="p-3 text-right font-mono">{formatCents(bva.summary.totalBudgetCents)}</td>
                  <td className="p-3 text-right font-mono">{formatCents(bva.summary.totalActualCents)}</td>
                  <td className="p-3 text-right font-mono">{formatCents(bva.summary.totalVarianceCents)}</td>
                  <td className="p-3" />
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <h3 className="text-sm font-semibold m-0 p-3">Top variance drivers</h3>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium">Account</th>
                  <th className="p-3 font-medium">Section</th>
                  <th className="p-3 font-medium text-right">Variance</th>
                  <th className="p-3 font-medium text-right">Fav/Unfav</th>
                </tr>
              </thead>
              <tbody>
                {bva.summary.drivers.map((d) => (
                  <tr key={d.accountId} className="border-t border-[var(--border)]">
                    <td className="p-3">
                      {d.accountCode} {d.accountName}
                    </td>
                    <td className="p-3">{d.section}</td>
                    <td className="p-3 text-right font-mono">{formatCents(d.varianceCents)}</td>
                    <td className="p-3 text-right">{d.favourable ? 'Fav' : 'Unfav'}</td>
                  </tr>
                ))}
                {bva.summary.drivers.length === 0 && (
                  <tr>
                    <td className="p-3 text-sm text-[var(--muted)]" colSpan={4}>
                      No variance to report.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
