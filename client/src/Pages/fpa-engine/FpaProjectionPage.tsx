import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, XCircle } from 'lucide-react';
import { getFpaProjection, type FpaProjectedMonth, type FpaProjectionResponse } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import BackLink from '../../components/BackLink';
import TrendChart from '../../components/TrendChart';

/**
 * A scenario's linked 3-statement projection.
 *
 * `balances` is rendered as a visible badge, never hidden and never silently
 * corrected — mirroring the trial balance's `isBalanced` badge and AP-Flow's
 * `arithmeticOk: false` panel. Trailing months are LedgerCore's own posted
 * actuals and are captioned as exactly that; the projection is a forecast,
 * never presented as a fact.
 */

interface StatementRowSpec {
  label: string;
  read: (month: FpaProjectedMonth) => number;
  emphasis?: boolean;
}

function StatementTable({ months, rows }: { months: FpaProjectedMonth[]; rows: StatementRowSpec[] }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
            <th className="p-3 font-medium sticky left-0 bg-[var(--panel)]">&nbsp;</th>
            {months.map((m) => (
              <th key={m.month} className="p-3 font-medium text-right whitespace-nowrap">
                {m.month.slice(0, 7)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.label}
              className={['border-t border-[var(--border)]', row.emphasis ? 'font-medium bg-[var(--bg)]' : ''].join(
                ' ',
              )}
            >
              <td className="p-3 sticky left-0 bg-inherit whitespace-nowrap">{row.label}</td>
              {months.map((m) => (
                <td key={m.month} className="p-3 text-right tabular-nums whitespace-nowrap">
                  {formatCents(row.read(m))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function FpaProjectionPage() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const base = useAppBasePath();
  const [data, setData] = useState<FpaProjectionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (scenarioId === undefined) return;
    let ignore = false;
    getFpaProjection(scenarioId)
      .then((res) => {
        if (!ignore) setData(res);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the projection');
      });
    return () => {
      ignore = true;
    };
  }, [scenarioId]);

  if (scenarioId === undefined) return null;

  if (data === null) {
    return (
      <section className="flex flex-col gap-4">
        <BackLink to={base} label="Back to models" />
        {error !== null ? <p className="status status--bad">{error}</p> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  const { projection } = data;
  const trendPoints = [
    ...data.actuals.map((a) => ({ month: a.month.slice(0, 7), revenueCents: a.revenueCents, expenseCents: a.revenueCents - a.netIncomeCents })),
    ...projection.months.map((m) => ({
      month: m.month.slice(0, 7),
      revenueCents: m.incomeStatement.revenueCents,
      expenseCents: m.incomeStatement.costOfSalesCents + m.incomeStatement.operatingExpensesCents,
    })),
  ];

  return (
    <section className="flex flex-col gap-6">
      <BackLink to={`${base}/${data.modelId}`} label="Back to model" />

      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">
            {data.modelName} — {data.scenarioName}
          </h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Base currency {data.baseCurrency}. Actuals posted through {data.actualsThrough}; everything after is a
            forecast, not a fact.
          </p>
        </div>
      </header>

      <div
        className={[
          'flex items-center gap-2.5 rounded-lg px-4 py-3 text-sm ring-1 ring-inset',
          projection.balances
            ? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
            : 'bg-rose-500/10 text-rose-400 ring-rose-500/20',
        ].join(' ')}
        role="status"
      >
        {projection.balances ? (
          <CheckCircle2 size={17} aria-hidden="true" />
        ) : (
          <XCircle size={17} aria-hidden="true" />
        )}
        <span>
          {projection.balances
            ? 'Every projected month balances — assets equal liabilities plus equity.'
            : 'This projection does not balance. Do not trust these figures — this points to a bug or an imbalance in the underlying books.'}
        </span>
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-wrap gap-6">
        <div>
          <p className="text-xs text-[var(--muted)] m-0 uppercase tracking-wide">Cash runway</p>
          <p className="text-lg font-semibold m-0 mt-1">
            {projection.runwayMonths === null
              ? 'No cash-out within the horizon'
              : `${String(projection.runwayMonths)} month${projection.runwayMonths === 1 ? '' : 's'}`}
          </p>
        </div>
        {projection.cashOutMonth !== null && (
          <div>
            <p className="text-xs text-[var(--muted)] m-0 uppercase tracking-wide">Cash-out month</p>
            <p className="text-lg font-semibold m-0 mt-1">{projection.cashOutMonth.slice(0, 7)}</p>
          </div>
        )}
        <div>
          <p className="text-xs text-[var(--muted)] m-0 uppercase tracking-wide">Avg. monthly burn (first 3 mo)</p>
          <p className="text-lg font-semibold m-0 mt-1">{formatCents(projection.averageMonthlyBurnCents)}</p>
        </div>
      </div>

      {trendPoints.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold m-0 mb-2">Revenue vs. expense — actuals then forecast</h3>
          <TrendChart points={trendPoints} />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold m-0">Income statement</h3>
        <StatementTable
          months={projection.months}
          rows={[
            { label: 'Revenue', read: (m) => m.incomeStatement.revenueCents },
            { label: 'Cost of sales', read: (m) => m.incomeStatement.costOfSalesCents },
            { label: 'Gross profit', read: (m) => m.incomeStatement.grossProfitCents, emphasis: true },
            { label: 'Operating expenses', read: (m) => m.incomeStatement.operatingExpensesCents },
            { label: 'Operating income', read: (m) => m.incomeStatement.operatingIncomeCents },
            { label: 'Tax', read: (m) => m.incomeStatement.taxCents },
            { label: 'Net income', read: (m) => m.incomeStatement.netIncomeCents, emphasis: true },
          ]}
        />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold m-0">Cash flow</h3>
        <StatementTable
          months={projection.months}
          rows={[
            { label: 'Net income', read: (m) => m.cashFlow.netIncomeCents },
            { label: 'Change in receivables', read: (m) => -m.cashFlow.changeInReceivablesCents },
            { label: 'Change in payables', read: (m) => m.cashFlow.changeInPayablesCents },
            { label: 'Net cash flow', read: (m) => m.cashFlow.netCashFlowCents, emphasis: true },
            { label: 'Opening cash', read: (m) => m.cashFlow.openingCashCents },
            { label: 'Closing cash', read: (m) => m.cashFlow.closingCashCents, emphasis: true },
          ]}
        />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold m-0">Balance sheet</h3>
        <StatementTable
          months={projection.months}
          rows={[
            { label: 'Cash', read: (m) => m.balanceSheet.cashCents },
            { label: 'Receivables', read: (m) => m.balanceSheet.receivablesCents },
            { label: 'Other assets', read: (m) => m.balanceSheet.otherAssetsCents },
            { label: 'Total assets', read: (m) => m.balanceSheet.totalAssetsCents, emphasis: true },
            { label: 'Payables', read: (m) => m.balanceSheet.payablesCents },
            { label: 'Other liabilities', read: (m) => m.balanceSheet.otherLiabilitiesCents },
            { label: 'Equity', read: (m) => m.balanceSheet.equityCents },
            { label: 'Retained earnings', read: (m) => m.balanceSheet.retainedEarningsCents },
            {
              label: 'Total liabilities & equity',
              read: (m) => m.balanceSheet.totalLiabilitiesAndEquityCents,
              emphasis: true,
            },
          ]}
        />
      </div>
    </section>
  );
}
