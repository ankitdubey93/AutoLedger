import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AgingBucketAmount, SnapshotAging } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';

/** Phase 47 — receivables and payables stacked by age bucket. */
const BUCKET_FILLS: Record<AgingBucketAmount['bucket'], string> = {
  CURRENT: 'var(--good)',
  D1_30: 'var(--accent)',
  D31_60: 'var(--warn)',
  D61_90: 'var(--bad)',
  D90_PLUS: 'var(--bad)',
};

function rowFor(name: string, aging: SnapshotAging): Record<string, string | number> {
  const row: Record<string, string | number> = { name };
  for (const bucket of aging.buckets) {
    row[bucket.bucket] = bucket.amountCents;
  }
  return row;
}

export default function AgingStackChart({
  receivables,
  payables,
}: {
  receivables: SnapshotAging;
  payables: SnapshotAging;
}) {
  const data = [rowFor('Receivables', receivables), rowFor('Payables', payables)];
  const labels = receivables.buckets.map((bucket) => bucket.label);

  return (
    <figure className="m-0">
      <div aria-hidden="true" style={{ width: '100%', height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical">
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
              stroke="var(--border)"
              tickFormatter={(v: number) => formatCents(v)}
            />
            <YAxis type="category" dataKey="name" tick={{ fill: 'var(--muted)', fontSize: 12 }} stroke="var(--border)" />
            {receivables.buckets.map((bucket) => (
              <Bar
                key={bucket.bucket}
                stackId="a"
                dataKey={bucket.bucket}
                name={bucket.label}
                fill={BUCKET_FILLS[bucket.bucket]}
              />
            ))}
            <Tooltip />
            <Legend />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <table className="visually-hidden">
        <caption>Receivables and payables by age</caption>
        <thead>
          <tr>
            <th>Age</th>
            <th>Receivables</th>
            <th>Payables</th>
          </tr>
        </thead>
        <tbody>
          {labels.map((label, index) => (
            <tr key={label}>
              <td>{label}</td>
              <td>{formatCents(receivables.buckets[index]?.amountCents ?? 0)}</td>
              <td>{formatCents(payables.buckets[index]?.amountCents ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
