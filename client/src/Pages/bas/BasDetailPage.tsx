import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import {
  addBasAdjustment,
  deleteBas,
  finaliseBas,
  getBas,
  listAccounts,
  listBasEvents,
  lodgeBas,
  removeBasAdjustment,
  reopenBas,
  updateBas,
  type Account,
  type BasDetail,
  type BasEventRow,
  type BasReconciliationSide,
} from '../../services/fetchServices';
import { useCan } from '../../context/AuthContext';
import { formatDate, orgToday } from '../../utils/date';
import { formatCents, parseCentsInput } from '../../utils/money';
import BackLink from '../../components/BackLink';
import ConfirmDialog from '../../components/ConfirmDialog';
import ExportMenu from '../../components/ui/ExportMenu';
import LoadingState from '../../components/ui/LoadingState';
import PageHeader from '../../components/ui/PageHeader';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../components/ui/formClasses';

const LABEL_TEXT: Record<string, string> = {
  G1: 'Total sales',
  G2: 'Export sales',
  G3: 'Other GST-free sales',
  G4: 'Input-taxed sales',
  G5: 'G2 + G3 + G4',
  G6: 'Sales subject to GST (G1 − G5)',
  G7: 'Adjustments',
  G8: 'After adjustments (G6 + G7)',
  G9: 'GST on sales (G8 ÷ 11)',
  G10: 'Capital purchases',
  G11: 'Non-capital purchases',
  G12: 'G10 + G11',
  G13: 'Purchases for input-taxed sales',
  G14: 'Purchases without GST in the price',
  G15: 'Private use or non-deductible',
  G16: 'G13 + G14 + G15',
  G17: 'Purchases subject to GST (G12 − G16)',
  G18: 'Adjustments',
  G19: 'After adjustments (G17 + G18)',
  G20: 'GST on purchases (G19 ÷ 11)',
  '1A': 'GST on sales',
  '1B': 'GST on purchases',
};

const WORKSHEET = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13', 'G14', 'G15', 'G16', 'G17', 'G18', 'G19', 'G20'];

const RECONCILIATION_ROWS: readonly { label: string; key: keyof BasReconciliationSide }[] = [
  { label: 'Movement in the ledger', key: 'glCents' },
  { label: 'Reported on this BAS', key: 'reportedCents' },
  { label: 'GST on documents not yet paid', key: 'unpaidMovementCents' },
  { label: 'Unexplained', key: 'differenceCents' },
];

/** Reported amounts: whole dollars with cents dropped, as the ATO asks for them. */
function dollars(cents: number): string {
  return `$${Math.trunc(cents / 100).toLocaleString('en-AU')}`;
}

function sourceLink(event: BasEventRow): string | null {
  switch (event.sourceKind) {
    case 'INVOICE':
      return `/invoices/${event.sourceId}`;
    case 'BILL':
      return `/expenses/${event.sourceId}`;
    case 'CREDIT_NOTE':
      return `/credit-notes/${event.sourceId}`;
    case 'DEBIT_NOTE':
      return `/debit-notes/${event.sourceId}`;
    default:
      return null;
  }
}

function LabelEvents({ basId, label }: { basId: string; label: string }) {
  const [events, setEvents] = useState<BasEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    listBasEvents(basId, label)
      .then((res) => {
        if (!ignore) setEvents(res.events);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the transactions');
      });
    return () => {
      ignore = true;
    };
  }, [basId, label]);

  if (error !== null) return <p className="status status--bad">{error}</p>;
  if (events === null) return <LoadingState />;
  if (events.length === 0) return <p className="text-sm text-[var(--muted)] m-0">No transactions at this label.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm min-w-[40rem]">
        <thead>
          <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
            <th className="p-2 font-medium">Date</th>
            <th className="p-2 font-medium">Reference</th>
            <th className="p-2 font-medium">Contact</th>
            <th className="p-2 font-medium">GST code</th>
            <th className="p-2 font-medium text-right">Gross</th>
            <th className="p-2 font-medium text-right">GST</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e, i) => {
            const to = sourceLink(e);
            const reference = e.documentNumber ?? e.sourceKind.toLowerCase();
            return (
              <tr key={`${e.sourceId}-${String(i)}`} className="border-t border-[var(--border)]">
                <td className="p-2">{formatDate(e.eventDate)}</td>
                <td className="p-2">{to === null ? reference : <Link to={to}>{reference}</Link>}</td>
                <td className="p-2">{e.partyName ?? '—'}</td>
                <td className="p-2">{e.taxLabel}</td>
                <td className="p-2 text-right tabular-nums">{formatCents(e.grossCents)}</td>
                <td className="p-2 text-right tabular-nums">{formatCents(e.taxCents)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LabelRow({
  basId,
  label,
  amount,
  open,
  onToggle,
  context = '',
}: {
  context?: string;
  basId: string;
  label: string;
  amount: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-t border-[var(--border)]">
        <td className="p-3 font-medium w-16">{label}</td>
        <td className="p-3">{LABEL_TEXT[label] ?? label}</td>
        <td className="p-3 text-right tabular-nums">
          <button
            type="button"
            className="bg-transparent border-0 p-0 cursor-pointer underline text-[var(--text)] tabular-nums"
            aria-expanded={open}
            aria-label={`${context}Transactions at ${label}`}
            onClick={onToggle}
          >
            {amount}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={3} className="p-3 bg-[var(--panel-2)]">
            <LabelEvents basId={basId} label={label} />
          </td>
        </tr>
      )}
    </>
  );
}

export default function BasDetailPage() {
  const { basId = '' } = useParams<{ basId: string }>();
  const navigate = useNavigate();
  const can = useCan();
  const [bas, setBas] = useState<BasDetail | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openLabel, setOpenLabel] = useState<string | null>(null);

  const [w1, setW1] = useState('');
  const [w2, setW2] = useState('');
  const [instalment, setInstalment] = useState('');

  const [adjustLabel, setAdjustLabel] = useState<'G7' | 'G18'>('G7');
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustAccount, setAdjustAccount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');

  const [lodgedOn, setLodgedOn] = useState(orgToday());
  const [atoReference, setAtoReference] = useState('');
  const [confirm, setConfirm] = useState<'finalise' | 'reopen' | 'lodge' | 'delete' | null>(null);

  function adopt(next: BasDetail) {
    setBas(next);
    setW1(next.w1Cents === 0 ? '' : formatCents(next.w1Cents));
    setW2(next.w2Cents === 0 ? '' : formatCents(next.w2Cents));
    setInstalment(next.instalmentCents === 0 ? '' : formatCents(next.instalmentCents));
  }

  useEffect(() => {
    let ignore = false;
    Promise.all([getBas(basId), listAccounts()])
      .then(([res, accountRes]) => {
        if (ignore) return;
        adopt(res.bas);
        setAccounts(accountRes.accounts.filter((a) => a.isPostable && a.isActive));
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load this BAS');
      });
    return () => {
      ignore = true;
    };
  }, [basId]);

  async function run(action: () => Promise<{ bas: BasDetail }>) {
    setBusy(true);
    setError(null);
    setConfirm(null);
    try {
      adopt((await action()).bas);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'That action failed');
    } finally {
      setBusy(false);
    }
  }

  if (bas === null) {
    return error === null ? <LoadingState /> : <p className="status status--bad">{error}</p>;
  }

  const isDraft = bas.status === 'DRAFT';
  const canPrepare = can('bas.prepare') && isDraft;
  const canFinalise = can('bas.finalise');
  const paygParsed = { w1: parseCentsInput(w1), w2: parseCentsInput(w2), instalment: parseCentsInput(instalment) };
  const paygValid = paygParsed.w1 !== null && paygParsed.w2 !== null && paygParsed.instalment !== null;
  const adjustCents = adjustAmount.trim() === '' ? null : parseCentsInput(adjustAmount.replace('-', ''));
  const adjustSigned = adjustCents === null ? null : adjustAmount.trim().startsWith('-') ? -adjustCents : adjustCents;
  const unreconciled =
    bas.reconciliation !== null && (bas.reconciliation.sales.differenceCents !== 0 || bas.reconciliation.purchases.differenceCents !== 0);

  return (
    <section className="flex flex-col gap-6">
      <BackLink to="/bas" label="Business activity statements" />
      <PageHeader
        as="h2"
        icon={CalendarClock}
        title={`BAS ${formatDate(bas.periodStart)} to ${formatDate(bas.periodEnd)}`}
        subtitle={`${bas.basis === 'CASH' ? 'Cash' : 'Accruals'} basis · ${bas.method === 'SIMPLER' ? 'Simpler BAS' : 'Full reporting'} · Due ${formatDate(bas.dueDate)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ExportMenu path={`/bas/${bas.id}`} params={{}} />
          </div>
        }
      />

      <p className="text-sm text-[var(--muted)] m-0">
        AutoLedger prepares this statement. It does not lodge it with the ATO, and it is not tax advice: have your BAS agent
        review it if you're unsure.
      </p>

      {error !== null && <p className="status status--bad">{error}</p>}
      {bas.warnings.map((w) => (
        <p key={w.code} className="status status--warn">
          {w.message}
        </p>
      ))}
      {unreconciled && (
        <p className="status status--bad">
          This BAS doesn't match the GST accounts in your ledger. A journal posted directly to a GST account is the usual cause.
        </p>
      )}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="text-left p-3 font-medium">To report</caption>
          <tbody>
            {bas.reportedLabels.map((label) => (
              <LabelRow
                key={label}
                basId={bas.id}
                label={label}
                amount={dollars(bas.labels[label] ?? 0)}
                open={openLabel === label}
                onToggle={() => setOpenLabel(openLabel === label ? null : label)}
              />
            ))}
            <tr className="border-t border-[var(--border)]">
              <td className="p-3 font-medium">W1</td>
              <td className="p-3">Total salary, wages and other payments</td>
              <td className="p-3 text-right tabular-nums">{dollars(bas.w1Cents)}</td>
            </tr>
            <tr className="border-t border-[var(--border)]">
              <td className="p-3 font-medium">W2</td>
              <td className="p-3">Amount withheld</td>
              <td className="p-3 text-right tabular-nums">{dollars(bas.w2Cents)}</td>
            </tr>
            <tr className="border-t border-[var(--border)]">
              <td className="p-3 font-medium">T7</td>
              <td className="p-3">PAYG instalment</td>
              <td className="p-3 text-right tabular-nums">{dollars(bas.instalmentCents)}</td>
            </tr>
            <tr className="border-t-2 border-[var(--border-strong)] font-medium">
              <td className="p-3" colSpan={2}>
                {bas.summary.netPayable >= 0 ? 'Payable to the ATO' : 'Refund from the ATO'}
              </td>
              <td className="p-3 text-right tabular-nums">${Math.abs(bas.summary.netPayable).toLocaleString('en-AU')}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {canPrepare && (
        <div className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
          <h3 className="section-title m-0">PAYG</h3>
          <p className="text-sm text-[var(--muted)] m-0">
            AutoLedger doesn't run payroll. Enter these from your payroll software.
            {bas.paygSuggestion !== null && bas.paygSuggestion.w1Cents + bas.paygSuggestion.w2Cents > 0 && (
              <>
                {' '}
                Your ledger shows wages of {formatCents(bas.paygSuggestion.w1Cents)} and tax withheld of{' '}
                {formatCents(bas.paygSuggestion.w2Cents)} this period.
              </>
            )}
          </p>
          <div className="flex flex-wrap gap-3">
            {[
              { label: 'W1 Wages', value: w1, set: setW1 },
              { label: 'W2 Withheld', value: w2, set: setW2 },
              { label: 'T7 PAYG instalment', value: instalment, set: setInstalment },
            ].map((field) => (
              <label key={field.label} className="flex flex-col gap-1 text-sm">
                <span className="text-[var(--muted)]">{field.label}</span>
                <input inputMode="decimal" value={field.value} onChange={(e) => field.set(e.target.value)} className={inputClass} />
              </label>
            ))}
          </div>
          <div>
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={busy || !paygValid}
              onClick={() =>
                void run(() =>
                  updateBas(bas.id, {
                    w1Cents: paygParsed.w1 ?? 0,
                    w2Cents: paygParsed.w2 ?? 0,
                    instalmentCents: paygParsed.instalment ?? 0,
                  }),
                )
              }
            >
              Save PAYG
            </button>
          </div>
        </div>
      )}

      {(bas.adjustments.length > 0 || canPrepare) && (
        <div className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
          <h3 className="section-title m-0">Adjustments</h3>
          {bas.adjustments.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                {a.label}: {formatCents(a.grossCents)} (GST {formatCents(a.taxCents)}), {a.accountCode} {a.accountName}. {a.reason}
              </span>
              {canPrepare && (
                <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void run(() => removeBasAdjustment(bas.id, a.id))}>
                  Remove
                </button>
              )}
            </div>
          ))}
          {canPrepare && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-[var(--muted)]">Label</span>
                <select value={adjustLabel} onChange={(e) => setAdjustLabel(e.target.value === 'G18' ? 'G18' : 'G7')} className={inputClass}>
                  <option value="G7">G7 Sales</option>
                  <option value="G18">G18 Purchases</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-[var(--muted)]">Amount incl. GST (negative reduces)</span>
                <input inputMode="decimal" value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-[var(--muted)]">Other side of the GST</span>
                <select value={adjustAccount} onChange={(e) => setAdjustAccount(e.target.value)} className={inputClass}>
                  <option value="">Select an account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
                <span className="text-[var(--muted)]">Reason</span>
                <input value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} maxLength={500} className={inputClass} />
              </label>
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={busy || adjustSigned === null || adjustSigned === 0 || adjustAccount === '' || adjustReason.trim() === ''}
                onClick={() =>
                  void run(async () => {
                    const res = await addBasAdjustment(bas.id, {
                      label: adjustLabel,
                      grossCents: adjustSigned ?? 0,
                      accountId: adjustAccount,
                      reason: adjustReason.trim(),
                    });
                    setAdjustAmount('');
                    setAdjustReason('');
                    return res;
                  })
                }
              >
                Add adjustment
              </button>
            </div>
          )}
        </div>
      )}

      <details className="rounded-lg border border-[var(--border)] bg-[var(--panel)]">
        <summary className="p-3 cursor-pointer font-medium text-sm">GST calculation worksheet</summary>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <tbody>
              {WORKSHEET.map((label) => (
                <LabelRow
                  key={label}
                  basId={bas.id}
                  label={label}
                  amount={formatCents(bas.labels[label] ?? 0)}
                  context="Worksheet: "
                  open={openLabel === `w-${label}`}
                  onToggle={() => setOpenLabel(openLabel === `w-${label}` ? null : `w-${label}`)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {bas.reconciliation !== null && (
        <details className="rounded-lg border border-[var(--border)] bg-[var(--panel)]">
          <summary className="p-3 cursor-pointer font-medium text-sm">Reconciliation to your GST accounts</summary>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[32rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium" />
                  <th className="p-3 font-medium text-right">GST on sales</th>
                  <th className="p-3 font-medium text-right">GST on purchases</th>
                </tr>
              </thead>
              <tbody>
                {RECONCILIATION_ROWS.map((row) => (
                  <tr key={row.key} className="border-t border-[var(--border)]">
                    <td className="p-3">{row.label}</td>
                    <td className="p-3 text-right tabular-nums">
                      {formatCents(bas.reconciliation?.sales[row.key] ?? 0)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {formatCents(bas.reconciliation?.purchases[row.key] ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <ExportMenu path={`/bas/${bas.id}/events`} params={{}} />
        <span className="text-sm text-[var(--muted)]">GST audit report: every transaction behind this BAS.</span>
      </div>

      {canFinalise && isDraft && (
        <div className="flex flex-wrap gap-3">
          <button type="button" className={primaryButtonClass} disabled={busy} onClick={() => setConfirm('finalise')}>
            Finalise
          </button>
          <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => setConfirm('delete')}>
            Delete draft
          </button>
        </div>
      )}

      {canFinalise && bas.status === 'FINALISED' && (
        <div className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
          <h3 className="section-title m-0">Record lodgment</h3>
          <p className="text-sm text-[var(--muted)] m-0">
            Enter the figures above in ATO Online or send them to your agent. Once lodged, record it here. This moves the
            balances to what you owe the ATO, in account 2150 ATO Clearing.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Date lodged</span>
              <input type="date" value={lodgedOn} onChange={(e) => setLodgedOn(e.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">ATO receipt number (optional)</span>
              <input value={atoReference} onChange={(e) => setAtoReference(e.target.value)} maxLength={100} className={inputClass} />
            </label>
            <button type="button" className={primaryButtonClass} disabled={busy || lodgedOn === ''} onClick={() => setConfirm('lodge')}>
              Record lodgment
            </button>
            <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => setConfirm('reopen')}>
              Reopen
            </button>
          </div>
        </div>
      )}

      {bas.status === 'LODGED' && (
        <p className="status status--good">
          Lodged {formatDate(bas.lodgedOn)}
          {bas.atoReference === null ? '' : `, receipt ${bas.atoReference}`}. A lodged BAS can't change: correct any error on a later one.
        </p>
      )}

      {confirm === 'finalise' && (
        <ConfirmDialog
          title="Finalise this BAS?"
          body="The figures are stored, and the months in this period close so nothing can be posted into them. You can reopen it until it is lodged."
          confirmLabel="Finalise"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void run(() => finaliseBas(bas.id))}
        />
      )}
      {confirm === 'reopen' && (
        <ConfirmDialog
          title="Reopen this BAS?"
          body="The stored figures are discarded, and the months in this period open again."
          confirmLabel="Reopen"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void run(() => reopenBas(bas.id))}
        />
      )}
      {confirm === 'lodge' && (
        <ConfirmDialog
          title="Record this BAS as lodged?"
          body="Only do this once it has really been lodged with the ATO. It posts a journal, and it can't be undone."
          confirmLabel="Record lodgment"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void run(() => lodgeBas(bas.id, { lodgedOn, atoReference: atoReference.trim() === '' ? null : atoReference.trim() }))}
        />
      )}
      {confirm === 'delete' && (
        <ConfirmDialog
          title="Delete this draft?"
          body="The PAYG figures and adjustments you entered on it are lost. Your transactions aren't affected."
          confirmLabel="Delete"
          tone="danger"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setBusy(true);
            deleteBas(bas.id)
              .then(() => navigate('/bas'))
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : 'Could not delete this draft');
                setBusy(false);
                setConfirm(null);
              });
          }}
        />
      )}
    </section>
  );
}
