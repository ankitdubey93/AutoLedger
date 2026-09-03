import { Link } from 'react-router-dom';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * The reports index. Trial balance is real and links out; P&L and the
 * balance sheet are Phase 4 and are shown disabled rather than as links to a
 * stub — being honest about what does not exist yet is the point of this
 * page (CLAUDE.md's "keeping docs honest"). Mirrors AppChooserPage's
 * `app-card--disabled` + `aria-disabled` idiom for a planned app.
 */

const PLANNED_REPORTS = [
  { name: 'Profit & loss', description: 'Revenue − Expenses, with gross profit split via the 5xxx range.' },
  { name: 'Balance sheet', description: 'Assets = Liabilities + Equity, as at a chosen date.' },
];

export default function ReportsPage() {
  const base = useAppBasePath();
  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold m-0">Reports</h2>
      </header>

      <div className="app-grid">
        <Link to={`${base}/trial-balance`} className="card app-card">
          <div className="app-card__head">
            <h3 className="app-card__name">Trial balance</h3>
          </div>
          <p className="muted">Per-account debit and credit totals, proving the books balance.</p>
        </Link>

        {PLANNED_REPORTS.map((report) => (
          <div key={report.name} className="card app-card app-card--disabled" aria-disabled="true">
            <div className="app-card__head">
              <h3 className="app-card__name">{report.name}</h3>
              <span className="chip chip--muted">Phase 4</span>
            </div>
            <p className="muted">{report.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
