import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getApAging,
  getArAging,
  type AgingBucket,
  type AgingCounterpartyRow,
  type AgingReport,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { todayIso } from '../statements/statementParams';
import BackLink from '../../components/BackLink';
import LoadingState from '../../components/ui/LoadingState';
import ExportMenu from '../../components/ui/ExportMenu';

/**
 * Aged receivables / aged payables — outstanding balances per counterparty,
 * bucketed by how far past due they are at the chosen "as at" date. Computed
 * from the subledger on every request; the badge says whether the total
 * agrees with the control account in the general ledger.
 */

const BUCKET_COLUMNS: { bucket: AgingBucket; label: string }[] = [
  { bucket: 'CURRENT', label: 'Current' },
  { bucket: 'D1_30', label: '1–30' },
  { bucket: 'D31_60', label: '31–60' },
  { bucket: 'D61_90', label: '61–90' },
  { bucket: 'D90_PLUS', label: '90+' },
];

function bucketCents(row: AgingCounterpartyRow, bucket: AgingBucket): number {
  switch (bucket) {
    case 'CURRENT':
      return row.currentCents;
    case 'D1_30':
      return row.d1to30Cents;
    case 'D31_60':
      return row.d31to60Cents;
    case 'D61_90':
      return row.d61to90Cents;
    case 'D90_PLUS':
      return row.d90PlusCents;
  }
}

function totalBucketCents(report: AgingReport, bucket: AgingBucket): number {
  return report.buckets.find((b) => b.bucket === bucket)?.amountCents ?? 0;
}

export default function AgingReportPage({ kind }: { kind: 'AR' | 'AP' }) {
  const [asOf, setAsOf] = useState(todayIso());
  const [report, setReport] = useState<AgingReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const title = kind === 'AR' ? 'Aged receivables' : 'Aged payables';
  const partyPathPrefix = kind === 'AR' ? '/customers' : '/vendors';

  useEffect(() => {
    let ignore = false;
    setError(null);

    const load = kind === 'AR' ? getArAging : getApAging;
    load(asOf === '' ? null : asOf)
      .then((res) => {
        if (!ignore) setReport(res);
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setError(err instanceof Error ? err.message : `Could not load ${title.toLowerCase()}`);
        }
      });

    return () => {
      ignore = true;
    };
  }, [asOf, kind, title]);

  return (
    <section className="flex flex-col gap-4">
      <BackLink to="/reports" label="Back to reports" />

      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">{title}</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Outstanding balances per {kind === 'AR' ? 'customer' : 'vendor'}, bucketed by days past due.
          </p>
        </div>

        <div className="flex items-end gap-4">
          <ExportMenu
            path={kind === 'AR' ? '/reports/ar-aging' : '/reports/ap-aging'}
            params={{ asOf: asOf || null }}
          />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">As at</span>
            <input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]"
            />
          </label>
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {report === null && error === null && <LoadingState />}

      {report !== null && (
        <>
          {report.controlAccount !== null && report.reconciles !== null && (
            <p className={report.reconciles ? 'status status--good' : 'status status--bad'}>
              {report.reconciles
                ? `Agrees with ${report.controlAccount.code} ${report.controlAccount.name}`
                : 'Does not agree with the control account'}
            </p>
          )}

          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[40rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium">{kind === 'AR' ? 'Customer' : 'Vendor'}</th>
                  {BUCKET_COLUMNS.map((col) => (
                    <th key={col.bucket} className="p-3 font-medium text-right">
                      {col.label}
                    </th>
                  ))}
                  <th className="p-3 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.counterpartyId} className="border-t border-[var(--border)]">
                    <td className="p-3">
                      <Link
                        to={`${partyPathPrefix}/${row.counterpartyId}`}
                        className="text-[var(--text)] no-underline hover:underline"
                      >
                        {row.counterpartyName}
                      </Link>
                    </td>
                    {BUCKET_COLUMNS.map((col) => (
                      <td key={col.bucket} className="p-3 text-right tabular-nums">
                        {formatCents(bucketCents(row, col.bucket))}
                      </td>
                    ))}
                    <td className="p-3 text-right tabular-nums">{formatCents(row.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[var(--border)] font-semibold">
                  <td className="p-3">Total</td>
                  {BUCKET_COLUMNS.map((col) => (
                    <td key={col.bucket} className="p-3 text-right tabular-nums">
                      {formatCents(totalBucketCents(report, col.bucket))}
                    </td>
                  ))}
                  <td className="p-3 text-right tabular-nums">{formatCents(report.totalOutstandingCents)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
