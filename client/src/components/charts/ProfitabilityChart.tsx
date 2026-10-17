import { Bar, Legend, Line, ComposedChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { SnapshotTrendPoint } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { formatRatio } from '../../utils/ratio';

/** Phase 47 — revenue, cost of sales and gross margin by month. Recharts; numbers stay integer cents until formatCents. */
export default function ProfitabilityChart({ points }: { points: SnapshotTrendPoint[] }) {
  return (
    <figure className="m-0">
      <div aria-hidden="true" style={{ width: '100%', height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="month" tick={{ fill: 'var(--muted)', fontSize: 12 }} stroke="var(--border)" />
            <YAxis
              yAxisId="money"
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
              stroke="var(--border)"
              tickFormatter={(v: number) => formatCents(v)}
            />
            <YAxis
              yAxisId="pct"
              orientation="right"
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
              stroke="var(--border)"
              tickFormatter={(v: number) => formatRatio('PERCENT', v)}
            />
            <Bar yAxisId="money" dataKey="revenueCents" name="Revenue" fill="var(--accent)" />
            <Bar yAxisId="money" dataKey="costOfSalesCents" name="Cost of sales" fill="var(--warn)" />
            <Line
              yAxisId="pct"
              dataKey="grossMarginBp"
              name="Gross margin"
              stroke="var(--good)"
              dot={false}
              connectNulls
            />
            <Tooltip />
            <Legend />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <table className="visually-hidden">
        <caption>Revenue, cost of sales and gross margin by month</caption>
        <thead>
          <tr>
            <th>Month</th>
            <th>Revenue</th>
            <th>Cost of sales</th>
            <th>Gross profit</th>
            <th>Gross margin</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.month}>
              <td>{point.month}</td>
              <td>{formatCents(point.revenueCents)}</td>
              <td>{formatCents(point.costOfSalesCents)}</td>
              <td>{formatCents(point.grossProfitCents)}</td>
              <td>{formatRatio('PERCENT', point.grossMarginBp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
