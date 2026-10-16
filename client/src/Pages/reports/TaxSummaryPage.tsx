import { useEffect, useState } from 'react';
import { getTaxSummary, type TaxSummary, type TaxSummaryDirection } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import BackLink from '../../components/BackLink';
import LoadingState from '../../components/ui/LoadingState';
import ExportMenu from '../../components/ui/ExportMenu';

/**
 * Tax summary — GST/VAT collected on sales (output) and paid on purchases
 * (input) across a date range, grouped by rate. Each direction is checked
 * against its tax control account in the general ledger: the box turns red
 * when the two disagree.
 */

/** Basis points as a percentage: 1000 → "10%", 750 → "7.5%". Display only. */
function rateLabel(rateBp: number): string {
  return `${rateBp / 100}%`;
}

/** The first and last day of the current month, UTC, like the P&L shortcuts. */
function currentMonthRange(): { from: string; to: string } {
  const today = new Date();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    from: iso(new Date(Date.UTC(year, month, 1))),
    to: iso(new Date(Date.UTC(year, month + 1, 0))),
  };
}

function ReconciliationBox({ label, glCents, differenceCents }: {
  label: string;
  glCents: number;
  differenceCents: number;
}) {
  return (
    <div
      role="status"
      aria-label={`${label} reconciliation`}
      className={differenceCents !== 0 ? 'status status--bad' : 'status status--good'}
    >
      <span className="mr-4">Ledger {formatCents(glCents)}</span>
      <span>Difference {formatCents(differenceCents)}</span>
    </div>
  );
}

function DirectionSection({ title, direction, reconcile, checkLabel }: {
  title: string;
  direction: TaxSummaryDirection;
  reconcile: { glCents: number; differenceCents: number; accountLabel: string };
  checkLabel: string;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-base font-semibold m-0">{title}</h3>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm min-w-[30rem]">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className="p-3 font-medium">Rate</th>
              <th className="p-3 font-medium text-right">Documents</th>
              <th className="p-3 font-medium text-right">Net</th>
              <th className="p-3 font-medium text-right">Tax</th>
            </tr>
          </thead>
          <tbody>
            {direction.rows.map((row) => (
              <tr key={row.rateBp} className="border-t border-[var(--border)]">
                <td className="p-3">{rateLabel(row.rateBp)}</td>
                <td className="p-3 text-right tabular-nums">{row.documentCount}</td>
                <td className="p-3 text-right tabular-nums">{formatCents(row.netCents)}</td>
                <td className="p-3 text-right tabular-nums">{formatCents(row.taxCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[var(--border)] font-semibold">
              <td className="p-3" colSpan={2}>
                Total
              </td>
              <td className="p-3 text-right tabular-nums">{formatCents(direction.netCents)}</td>
              <td className="p-3 text-right tabular-nums">{formatCents(direction.taxCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-[var(--muted)]">{checkLabel}</span>
        <ReconciliationBox
          label={title}
          glCents={reconcile.glCents}
          differenceCents={reconcile.differenceCents}
        />
        <span className="text-xs text-[var(--muted)]">{reconcile.accountLabel}</span>
      </div>
    </section>
  );
}

function accountLabel(check: TaxSummary['outputCheck']): string {
  return check.account === null
    ? 'No tax control account is set up'
    : `Control account ${check.account.code} ${check.account.name}`;
}

export default function TaxSummaryPage() {
  const initial = currentMonthRange();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [report, setReport] = useState<TaxSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    setError(null);

    if (from === '' || to === '') return;
    getTaxSummary(from, to)
      .then((res) => {
        if (!ignore) setReport(res);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the tax summary');
      });

    return () => {
      ignore = true;
    };
  }, [from, to]);

  return (
    <section className="flex flex-col gap-4">
      <BackLink to="/reports" label="Back to reports" />

      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Tax summary</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Tax collected on sales and paid on purchases, by rate, for the period.
          </p>
        </div>

        <div className="flex items-end gap-4 flex-wrap">
          <ExportMenu path="/reports/tax-summary" params={{ from: from || null, to: to || null }} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">To</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]"
            />
          </label>
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {report === null && error === null && <LoadingState />}

      {report !== null && (
        <>
          <DirectionSection
            title="Output (sales)"
            direction={report.output}
            checkLabel="Reconciles to the general ledger"
            reconcile={{
              glCents: report.outputCheck.glCents,
              differenceCents: report.outputCheck.differenceCents,
              accountLabel: accountLabel(report.outputCheck),
            }}
          />

          <DirectionSection
            title="Input (purchases)"
            direction={report.input}
            checkLabel="Reconciles to the general ledger"
            reconcile={{
              glCents: report.inputCheck.glCents,
              differenceCents: report.inputCheck.differenceCents,
              accountLabel: accountLabel(report.inputCheck),
            }}
          />

          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex items-center justify-between text-sm font-semibold">
            <span>Net tax payable</span>
            <span className="tabular-nums">{formatCents(report.netTaxPayableCents)}</span>
          </div>
        </>
      )}
    </section>
  );
}
