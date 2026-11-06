import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { createBas, listBas, type BasPeriodSuggestion, type BasReturnSummary } from '../../services/fetchServices';
import { useCan } from '../../context/AuthContext';
import { formatDate, orgToday } from '../../utils/date';
import PageHeader from '../../components/ui/PageHeader';
import LoadingState from '../../components/ui/LoadingState';
import { primaryButtonClass } from '../../components/ui/formClasses';

const STATUS_LABEL: Record<BasReturnSummary['status'], string> = {
  DRAFT: 'Draft',
  FINALISED: 'Finalised, not yet lodged',
  LODGED: 'Lodged',
};

/** Phase 49d — every BAS, plus the periods that don't have one yet. */
export default function BasListPage() {
  const navigate = useNavigate();
  const can = useCan();
  const [returns, setReturns] = useState<BasReturnSummary[] | null>(null);
  const [suggested, setSuggested] = useState<BasPeriodSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false;
    listBas()
      .then((res) => {
        if (ignore) return;
        setReturns(res.returns);
        setSuggested(res.suggested);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load your BAS list');
      });
    return () => {
      ignore = true;
    };
  }, []);

  async function start(periodStart: string) {
    setBusy(true);
    setError(null);
    try {
      const { bas } = await createBas(periodStart);
      navigate(`/bas/${bas.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not start that BAS');
      setBusy(false);
    }
  }

  const today = orgToday();

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        as="h2"
        icon={CalendarClock}
        title="Business activity statements"
        subtitle="Prepare your BAS here, then lodge it through ATO Online or your agent and record it."
      />

      {error !== null && <p className="status status--bad">{error}</p>}
      {returns === null && error === null && <LoadingState />}

      {suggested.length > 0 && can('bas.prepare') && (
        <div className="flex flex-col gap-2">
          <h3 className="section-title m-0">Ready to start</h3>
          {suggested.map((period) => (
            <div key={period.start} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 text-sm">
              <span>
                {formatDate(period.start)} to {formatDate(period.end)}, due {formatDate(period.dueDate)}
              </span>
              <button type="button" className={primaryButtonClass} disabled={busy} onClick={() => void start(period.start)}>
                Start BAS
              </button>
            </div>
          ))}
        </div>
      )}

      {returns !== null && returns.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[36rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Period</th>
                <th className="p-3 font-medium">Due</th>
                <th className="p-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {returns.map((r) => (
                <tr key={r.id} className="border-t border-[var(--border)]">
                  <td className="p-3">
                    <Link to={`/bas/${r.id}`}>
                      {formatDate(r.periodStart)} to {formatDate(r.periodEnd)}
                    </Link>
                  </td>
                  <td className={`p-3 ${r.status !== 'LODGED' && r.dueDate < today ? 'text-[var(--bad)]' : ''}`}>{formatDate(r.dueDate)}</td>
                  <td className="p-3">{STATUS_LABEL[r.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
