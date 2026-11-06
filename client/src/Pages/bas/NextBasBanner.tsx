import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listBas } from '../../services/fetchServices';
import { useCan } from '../../context/AuthContext';
import { useRegion } from '../../context/LedgerSettingsContext';
import { formatDate, orgToday } from '../../utils/date';

/** Phase 49d — the next BAS deadline on the dashboard, for an Australian organization. */
export default function NextBasBanner() {
  const region = useRegion();
  const can = useCan();
  const visible = region === 'AU' && can('bas.view');
  const [next, setNext] = useState<{ dueDate: string; to: string } | null>(null);

  useEffect(() => {
    if (!visible) return;
    let ignore = false;
    listBas()
      .then((res) => {
        if (ignore) return;
        const today = orgToday();
        const open = res.returns.filter((r) => r.status !== 'LODGED').map((r) => ({ dueDate: r.dueDate, to: `/bas/${r.id}` }));
        // A period still running has nothing to lodge yet, so it isn't a deadline.
        const unstarted = res.suggested.filter((p) => p.end < today).map((p) => ({ dueDate: p.dueDate, to: '/bas' }));
        const [first] = [...open, ...unstarted].sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
        setNext(first ?? null);
      })
      .catch(() => {
        // The dashboard stands on its own; the BAS page reports its own errors.
      });
    return () => {
      ignore = true;
    };
  }, [visible]);

  if (!visible || next === null) return null;
  const overdue = next.dueDate < orgToday();
  return (
    <p className={`status ${overdue ? 'status--bad' : 'status--warn'} m-0`}>
      {overdue ? 'A BAS is overdue' : 'Your next BAS is due'}: {formatDate(next.dueDate)}. <Link to={next.to}>Open BAS</Link>
    </p>
  );
}
