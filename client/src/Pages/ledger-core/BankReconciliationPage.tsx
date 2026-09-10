import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { listAccounts, getBankReconciliation, type Account, type BankReconciliationReport } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import MetricTile from './MetricTile';
import BackLink from '../../components/BackLink';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * Reconciles one bank account's GL balance against its imported statement.
 *
 * `reconciles` is a completeness claim — every GL cash movement also
 * arrived as an imported bank line, and vice versa — not a correctness
 * claim about the books. An organization that has only imported one
 * month's statement against a year of GL activity will correctly see
 * "does not reconcile" here; the footnote below says so explicitly, not
 * just the API doc.
 */

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

export default function BankReconciliationPage() {
  const base = useAppBasePath();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [asOf, setAsOf] = useState(today);
  const [report, setReport] = useState<BankReconciliationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let ignore = false;
    listAccounts()
      .then((res) => {
        if (ignore) return;
        const assetAccounts = res.accounts.filter((a) => a.isPostable && a.type === 'Asset' && a.isActive);
        setAccounts(assetAccounts);
        if (accountId === '' && assetAccounts.length > 0) {
          setAccountId(assetAccounts[0]?.id ?? '');
        }
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load accounts');
      });
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (accountId === '') return;
    let ignore = false;
    setLoaded(false);
    setError(null);

    getBankReconciliation(accountId, asOf)
      .then((res) => {
        if (ignore) return;
        setReport(res);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the reconciliation');
      });

    return () => {
      ignore = true;
    };
  }, [accountId, asOf]);

  return (
    <section className="flex flex-col gap-4">
      <BackLink to={`${base}/bank`} label="Back to bank lines" />

      <header>
        <h2 className="text-lg font-semibold m-0">Bank reconciliation</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Compares the ledger's cash balance against every imported statement line.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Account</span>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputClass}>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} · {account.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">As of</span>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={inputClass} />
        </label>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
      {!loaded && error === null && <p className="muted">Loading…</p>}

      {loaded && report !== null && (
        <>
          <div
            className={[
              'rounded-lg border p-4 flex items-center gap-3',
              report.reconciles
                ? 'border-[var(--good)]/30 bg-[var(--good)]/10'
                : 'border-amber-500/30 bg-amber-500/10',
            ].join(' ')}
          >
            {report.reconciles ? (
              <CheckCircle2 size={20} className="text-[var(--good)]" aria-hidden="true" />
            ) : (
              <XCircle size={20} className="text-amber-500" aria-hidden="true" />
            )}
            <div>
              <p className="text-sm font-medium m-0">
                {report.reconciles
                  ? 'The bank and the books agree'
                  : `Difference of ${formatCents(Math.abs(report.differenceCents))}`}
              </p>
              <p className="text-xs text-[var(--muted)] m-0 mt-1">
                This compares the imported statement against the ledger — it is a completeness check,
                not a correctness proof. A gap means a cash movement was never imported, or a statement
                period is missing, not necessarily that the books are wrong.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricTile
              label="GL balance"
              valueCents={report.glBalanceCents}
              currency=""
              icon={CheckCircle2}
              tone="neutral"
              to={null}
              hint={null}
            />
            <MetricTile
              label="Statement balance"
              valueCents={report.statementBalanceCents}
              currency=""
              icon={CheckCircle2}
              tone="neutral"
              to={null}
              hint={null}
            />
            <MetricTile
              label="Difference"
              valueCents={report.differenceCents}
              currency=""
              icon={report.reconciles ? CheckCircle2 : XCircle}
              tone={report.reconciles ? 'good' : 'bad'}
              to={null}
              hint={null}
            />
            <MetricTile
              label="Unmatched lines"
              valueCents={null}
              currency=""
              icon={XCircle}
              tone={report.unmatchedCount > 0 ? 'bad' : 'good'}
              to={`${base}/bank?status=UNMATCHED`}
              hint={`${String(report.unmatchedCount)} line(s), ${formatCents(report.unmatchedCents)}`}
            />
          </div>

          {report.statedClosingBalanceCents !== null && (
            <div className="card">
              <p className="text-sm m-0">
                Statement's own closing balance as of {report.statedClosingBalanceOn}:{' '}
                <span className="tabular-nums">{formatCents(report.statedClosingBalanceCents)}</span>
              </p>
              <p className="text-sm m-0 mt-1">
                Difference from imported lines:{' '}
                <span className="tabular-nums">
                  {formatCents(report.statedClosingDifferenceCents ?? 0)}
                </span>
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
