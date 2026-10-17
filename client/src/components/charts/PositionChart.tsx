import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { SnapshotPosition } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';

/** Phase 47 — assets against liabilities and net worth, as at the period end. */
export default function PositionChart({ position }: { position: SnapshotPosition }) {
  const data = [
    {
      name: 'Assets',
      current: position.currentAssetsCents,
      nonCurrent: position.nonCurrentAssetsCents,
      netWorth: 0,
    },
    {
      name: 'Liabilities & net worth',
      current: position.currentLiabilitiesCents,
      nonCurrent: position.nonCurrentLiabilitiesCents,
      netWorth: Math.max(position.netWorthCents, 0),
    },
  ];

  return (
    <figure className="m-0">
      <div aria-hidden="true" style={{ width: '100%', height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" tick={{ fill: 'var(--muted)', fontSize: 12 }} stroke="var(--border)" />
            <YAxis
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
              stroke="var(--border)"
              tickFormatter={(v: number) => formatCents(v)}
            />
            <Bar stackId="a" dataKey="current" name="Current" fill="var(--accent)" />
            <Bar stackId="a" dataKey="nonCurrent" name="Non-current" fill="var(--accent-soft)" />
            <Bar stackId="a" dataKey="netWorth" name="Net worth" fill="var(--good)" />
            <Tooltip />
            <Legend />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <table className="visually-hidden">
        <caption>Assets against liabilities and net worth</caption>
        <thead>
          <tr>
            <th>Item</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>As at</td>
            <td>{position.asOf}</td>
          </tr>
          <tr>
            <td>Current assets</td>
            <td>{formatCents(position.currentAssetsCents)}</td>
          </tr>
          <tr>
            <td>Non-current assets</td>
            <td>{formatCents(position.nonCurrentAssetsCents)}</td>
          </tr>
          <tr>
            <td>Total assets</td>
            <td>{formatCents(position.totalAssetsCents)}</td>
          </tr>
          <tr>
            <td>Current liabilities</td>
            <td>{formatCents(position.currentLiabilitiesCents)}</td>
          </tr>
          <tr>
            <td>Non-current liabilities</td>
            <td>{formatCents(position.nonCurrentLiabilitiesCents)}</td>
          </tr>
          <tr>
            <td>Total liabilities</td>
            <td>{formatCents(position.totalLiabilitiesCents)}</td>
          </tr>
          <tr>
            <td>Net worth</td>
            <td>{formatCents(position.netWorthCents)}</td>
          </tr>
          <tr>
            <td>Working capital</td>
            <td>{formatCents(position.workingCapitalCents)}</td>
          </tr>
        </tbody>
      </table>
    </figure>
  );
}
