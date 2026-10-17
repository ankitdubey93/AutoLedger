import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { SnapshotTrendPoint } from '../../services/fetchServices';
import { formatRatio } from '../../utils/ratio';

/**
 * Phase 47 — current ratio and debt to equity (TIMES, left axis) against debt ratio
 * (PERCENT, right axis). Debt ratio is a percentage, so it must not share the × axis.
 */
export default function RatioTrendChart({ points }: { points: SnapshotTrendPoint[] }) {
  return (
    <figure className="m-0">
      <div aria-hidden="true" style={{ width: '100%', height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="month" tick={{ fill: 'var(--muted)', fontSize: 12 }} stroke="var(--border)" />
            <YAxis
              yAxisId="times"
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
              stroke="var(--border)"
              tickFormatter={(v: number) => formatRatio('TIMES', v)}
            />
            <YAxis
              yAxisId="pct"
              orientation="right"
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
              stroke="var(--border)"
              tickFormatter={(v: number) => formatRatio('PERCENT', v)}
            />
            <Line
              yAxisId="times"
              dataKey="currentRatioBp"
              name="Current ratio"
              stroke="var(--accent)"
              dot={false}
              connectNulls
            />
            <Line
              yAxisId="times"
              dataKey="debtToEquityBp"
              name="Debt to equity"
              stroke="var(--bad)"
              dot={false}
              connectNulls
            />
            <Line
              yAxisId="pct"
              dataKey="debtRatioBp"
              name="Debt ratio"
              stroke="var(--warn)"
              dot={false}
              connectNulls
            />
            <Tooltip />
            <Legend />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <table className="visually-hidden">
        <caption>Current ratio, debt to equity and debt ratio by month</caption>
        <thead>
          <tr>
            <th>Month</th>
            <th>Current ratio</th>
            <th>Debt to equity</th>
            <th>Debt ratio</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.month}>
              <td>{point.month}</td>
              <td>{formatRatio('TIMES', point.currentRatioBp)}</td>
              <td>{formatRatio('TIMES', point.debtToEquityBp)}</td>
              <td>{formatRatio('PERCENT', point.debtRatioBp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
