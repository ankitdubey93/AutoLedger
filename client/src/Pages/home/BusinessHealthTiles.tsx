import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Landmark, Percent, Scale, Wallet } from 'lucide-react';
import { getBusinessSnapshot, type BusinessSnapshot, type SnapshotRatioValue } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { formatRatio } from '../../utils/ratio';
import { formatDate } from '../../utils/date';
import StatTile from '../../components/ui/StatTile';

/**
 * Phase 47 — four headline tiles on the dashboard, from the business snapshot
 * (year to date by default). A failed snapshot must not take the dashboard
 * down, so this component shows its own one-line error instead.
 */

const NO_VALUE: SnapshotRatioValue = { valueBp: null, reason: null };

export default function BusinessHealthTiles() {
  const [report, setReport] = useState<BusinessSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    getBusinessSnapshot()
      .then((res) => {
        if (!ignore) setReport(res);
      })
      .catch(() => {
        if (!ignore) setError('Business health is unavailable right now.');
      });
    return () => {
      ignore = true;
    };
  }, []);

  if (error !== null) {
    return <p className="text-sm text-[var(--muted)]">{error}</p>;
  }

  if (report === null) {
    return null;
  }

  const ratioValue = (key: 'GROSS_MARGIN' | 'CURRENT_RATIO' | 'DEBT_TO_EQUITY'): SnapshotRatioValue =>
    report.ratios.find((ratio) => ratio.key === key)?.current ?? NO_VALUE;

  return (
    <section aria-labelledby="business-health-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 id="business-health-heading" className="m-0 text-[1.1875rem] font-semibold">
          Business health
        </h3>
        <Link to="/reports/business-snapshot" className="text-sm font-semibold text-[var(--accent)]">
          View business snapshot →
        </Link>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Gross margin (YTD)"
          icon={Percent}
          value={formatRatio('PERCENT', ratioValue('GROSS_MARGIN').valueBp)}
          to="/reports/business-snapshot"
        />
        <StatTile
          label="Current ratio"
          icon={Scale}
          value={formatRatio('TIMES', ratioValue('CURRENT_RATIO').valueBp)}
          to="/reports/business-snapshot"
        />
        <StatTile
          label="Debt to equity"
          icon={Landmark}
          value={formatRatio('TIMES', ratioValue('DEBT_TO_EQUITY').valueBp)}
          to="/reports/business-snapshot"
        />
        <StatTile
          label="Working capital"
          icon={Wallet}
          value={formatCents(report.position.current.workingCapitalCents)}
          hint={`As at ${formatDate(report.period.to)}`}
          to="/reports/business-snapshot"
        />
      </div>
    </section>
  );
}
