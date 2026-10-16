import { Link } from 'react-router-dom';

/**
 * The reports index, grouped into sections. Every report is aggregated from
 * raw ledger_lines or document events on every request, with no summary table
 * behind any of them.
 */

interface ReportLink {
  name: string;
  description: string;
  path: string;
}

interface ReportSection {
  heading: string;
  reports: ReportLink[];
}

const SECTIONS: ReportSection[] = [
  {
    heading: 'Financial statements',
    reports: [
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
      {
        name: 'Cash flow statement',
        description: 'Operating, investing and financing cash movements, reconciled to the change in cash accounts.',
        path: 'reports/cash-flow',
      },
      {
        name: 'Trial balance',
        description: 'Per-account debit and credit totals, proving the books balance.',
        path: 'trial-balance',
      },
    ],
  },
  {
    heading: 'Receivables & payables',
    reports: [
      {
        name: 'Aged receivables',
        description: 'Open customer invoices grouped by how long they have been overdue.',
        path: 'reports/aged-receivables',
      },
      {
        name: 'Aged payables',
        description: 'Open vendor bills grouped by how long they have been overdue.',
        path: 'reports/aged-payables',
      },
    ],
  },
  {
    heading: 'Sales & purchases',
    reports: [
      {
        name: 'Sales by customer',
        description: 'Sales by customer over a period, optionally compared with a prior period.',
        path: 'reports/sales-by-customer',
      },
      {
        name: 'Sales by item',
        description: 'Sales by product or service over a period, optionally compared with a prior period.',
        path: 'reports/sales-by-item',
      },
      {
        name: 'Purchases by vendor',
        description: 'Purchases by vendor over a period, optionally compared with a prior period.',
        path: 'reports/purchases-by-vendor',
      },
      {
        name: 'Purchases by item',
        description: 'Purchases by product or service over a period, optionally compared with a prior period.',
        path: 'reports/purchases-by-item',
      },
    ],
  },
  {
    heading: 'Tax',
    reports: [
      {
        name: 'Tax summary',
        description: 'Output and input tax by rate, reconciled to the GL tax accounts.',
        path: 'reports/tax-summary',
      },
    ],
  },
  {
    heading: 'Ledger',
    reports: [
      {
        name: 'Account transactions',
        description: 'Grouped lines for chosen accounts, with contact, reference and running balances.',
        path: 'reports/account-transactions',
      },
      {
        name: 'General journal',
        description: 'Every posting in date order, from every source.',
        path: 'reports/general-journal',
      },
    ],
  },
  {
    heading: 'Audit',
    reports: [
      {
        name: 'Ledger exceptions',
        description: 'Flags for unusual amounts, unexpected sides, non-default tax and possible duplicates, each reviewable.',
        path: 'reports/exceptions',
      },
    ],
  },
];

export default function ReportsPage() {
  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold m-0">Reports</h2>
      </header>

      {SECTIONS.map((section) => (
        <div key={section.heading} className="flex flex-col gap-3">
          <h3 className="text-base font-semibold m-0">{section.heading}</h3>
          <div className="app-grid">
            {section.reports.map((report) => (
              <Link key={report.name} to={`/${report.path}`} className="card app-card">
                <div className="app-card__head">
                  <h4 className="app-card__name">{report.name}</h4>
                </div>
                <p className="muted">{report.description}</p>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
