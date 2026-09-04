import { Link } from 'react-router-dom';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * The reports index. All three reports are live as of Phase 4 — trial
 * balance, profit & loss, and the balance sheet — each aggregated from raw
 * ledger_lines on every request, with no summary table behind any of them.
 */

const REPORTS = [
  {
    name: 'Trial balance',
    description: 'Per-account debit and credit totals, proving the books balance.',
    path: 'trial-balance',
  },
  {
    name: 'Profit & loss',
    description: 'Revenue − Expenses, with gross profit split out via the 5xxx range.',
    path: 'reports/profit-and-loss',
  },
  {
    name: 'Balance sheet',
    description: 'Assets = Liabilities + Equity, as at a chosen date.',
    path: 'reports/balance-sheet',
  },
];

export default function ReportsPage() {
  const base = useAppBasePath();
  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold m-0">Reports</h2>
      </header>

      <div className="app-grid">
        {REPORTS.map((report) => (
          <Link key={report.name} to={`${base}/${report.path}`} className="card app-card">
            <div className="app-card__head">
              <h3 className="app-card__name">{report.name}</h3>
            </div>
            <p className="muted">{report.description}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
