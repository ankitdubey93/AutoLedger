import { Fragment, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AlarmClock, FileText, Scale } from 'lucide-react';
import {
  ApiRequestError,
  getCustomerLedger,
  getCustomerOpenItems,
  getVendorLedger,
  getVendorOpenItems,
  type PartyKind,
  type PartyLedger,
  type PartyLedgerEntryKind,
  type PartyLedgerRow,
  type PartyOpenItem,
  type PartyOpenItems,
} from '../../services/fetchServices';
import { useOrg } from '../../context/OrgContext';
import { formatCents } from '../../utils/money';
import BackLink from '../../components/BackLink';
import MetricTile from '../../components/ui/MetricTile';

/**
 * A customer's or vendor's account (Phase 25) — the party's subsidiary ledger
 * under the AR/AP control account. Balance due, open documents, and every
 * control-account movement with a running balance and the documents each
 * payment settled.
 *
 * There is no GL account per party: the trial balance and balance sheet show
 * only the control account, and the sum of every party's balance equals it.
 * See study/postgresql/subledger-reconciliation-and-aging.md.
 */

const PAGE_LIMIT = 50;

const KIND_LABELS: Record<PartyLedgerEntryKind, string> = {
  INVOICE: 'Invoice',
  INVOICE_VOID: 'Invoice voided',
  BILL: 'Expense',
  BILL_VOID: 'Expense voided',
  PAYMENT: 'Payment',
  PAYMENT_VOID: 'Payment voided',
  CREDIT_NOTE: 'Credit note',
  CREDIT_NOTE_VOID: 'Credit note voided',
  DEBIT_NOTE: 'Debit note',
  DEBIT_NOTE_VOID: 'Debit note voided',
};

/** Phase 26 — a note row links to its own page, not the party's invoice/expense list. */
function notePath(kind: PartyLedgerEntryKind | PartyOpenItem['documentKind']): string | null {
  if (kind === 'CREDIT_NOTE' || kind === 'CREDIT_NOTE_VOID') return 'credit-notes';
  if (kind === 'DEBIT_NOTE' || kind === 'DEBIT_NOTE_VOID') return 'debit-notes';
  return null;
}

const COPY: Record<
  PartyKind,
  { list: string; back: string; notFound: string; balanceLabel: string; documentPath: string }
> = {
  CUSTOMER: {
    list: 'customers',
    back: 'Back to customers',
    notFound: 'Customer not found',
    balanceLabel: 'Receivable',
    documentPath: 'invoices',
  },
  VENDOR: {
    list: 'vendors',
    back: 'Back to vendors',
    notFound: 'Vendor not found',
    balanceLabel: 'Payable',
    documentPath: 'expenses',
  },
};

function isPaymentKind(kind: PartyLedgerEntryKind): boolean {
  return kind === 'PAYMENT' || kind === 'PAYMENT_VOID';
}

export default function PartyAccountPage({ kind }: { kind: PartyKind }) {
  const { partyId } = useParams<{ partyId: string }>();
  const { organization } = useOrg();
  const currency = organization?.baseCurrency ?? '';
  const copy = COPY[kind];
  const [params, setParams] = useSearchParams();

  const [ledger, setLedger] = useState<PartyLedger | null>(null);
  const [openItems, setOpenItems] = useState<PartyOpenItems | null>(null);
  const [totalPages, setTotalPages] = useState(1);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const page = Number(params.get('page') ?? '1');

  useEffect(() => {
    if (partyId === undefined) return;
    let ignore = false;
    setError(null);
    setNotFound(false);

    const filters: { from?: string; to?: string; page: number; limit: number } = {
      page,
      limit: PAGE_LIMIT,
    };
    if (from !== '') filters.from = from;
    if (to !== '') filters.to = to;

    const loadLedger = kind === 'CUSTOMER' ? getCustomerLedger : getVendorLedger;
    const loadOpenItems = kind === 'CUSTOMER' ? getCustomerOpenItems : getVendorOpenItems;

    Promise.all([loadLedger(partyId, filters), loadOpenItems(partyId)])
      .then(([ledgerRes, openRes]) => {
        if (ignore) return;
        setLedger(ledgerRes);
        setTotalPages(ledgerRes.totalPages);
        setOpenItems(openRes);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setNotFound(true);
        } else {
          setError(err instanceof Error ? err.message : 'Could not load the account');
        }
      });

    return () => {
      ignore = true;
    };
  }, [kind, partyId, from, to, page]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    next.delete('page');
    setParams(next);
  }

  function goToPage(next: number) {
    const nextParams = new URLSearchParams(params);
    if (next <= 1) nextParams.delete('page');
    else nextParams.set('page', String(next));
    setParams(nextParams);
  }

  function documentLink(documentId: string, label: string | null, path: string | null = null) {
    return (
      <Link to={`/${path ?? copy.documentPath}/${documentId}`}>{label ?? documentId.slice(0, 8)}</Link>
    );
  }

  function referenceCell(row: PartyLedgerRow) {
    if (!isPaymentKind(row.kind)) return documentLink(row.documentId, row.documentNumber, notePath(row.kind));
    return (
      <span>
        {row.documentNumber ?? '—'}
        {row.allocations.length > 0 && (
          <span className="text-[var(--muted)]">
            {' '}
            applied to{' '}
            {row.allocations.map((allocation, index) => (
              <Fragment key={allocation.documentId}>
                {index > 0 && ', '}
                {documentLink(allocation.documentId, allocation.documentNumber)} (
                {formatCents(allocation.baseAmountCents)})
              </Fragment>
            ))}
          </span>
        )}
      </span>
    );
  }

  const backLink = <BackLink to={`/${copy.list}`} label={copy.back} />;

  if (notFound) {
    return (
      <section className="flex flex-col gap-3">
        {backLink}
        <p className="status status--bad">{copy.notFound}.</p>
      </section>
    );
  }

  if (error !== null) {
    return (
      <section className="flex flex-col gap-3">
        {backLink}
        <p className="status status--bad">{error}</p>
      </section>
    );
  }

  if (ledger === null || openItems === null) {
    return (
      <div className="shell" aria-busy="true">
        <div className="skeleton skeleton--title" />
        <span className="visually-hidden">Loading account…</span>
      </div>
    );
  }

  const inputClass =
    'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

  return (
    <section className="flex flex-col gap-4">
      {backLink}

      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold m-0 mt-1">{ledger.party.name}</h2>
        <p className="text-sm text-[var(--muted)] m-0">
          {kind === 'CUSTOMER' ? 'Customer account' : 'Vendor account'}
          {ledger.controlAccount !== null &&
            ` · under ${ledger.controlAccount.code} ${ledger.controlAccount.name}`}
        </p>
      </header>

      <div className="grid">
        <MetricTile
          label={copy.balanceLabel}
          valueCents={openItems.outstandingCents}
          currency={currency}
          icon={Scale}
          tone="neutral"
          to={null}
          hint="Balance due"
        />
        <MetricTile
          label="Overdue"
          valueCents={openItems.overdueCents}
          currency={currency}
          icon={AlarmClock}
          tone={openItems.overdueCents > 0 ? 'bad' : 'good'}
          to={null}
          hint={null}
        />
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 flex flex-col gap-1">
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0 flex items-center gap-1.5">
            <FileText size={14} aria-hidden="true" /> Open documents
          </p>
          <p className="text-lg font-semibold tabular-nums m-0">{openItems.items.length}</p>
        </div>
      </div>

      <h3 className="text-base font-semibold m-0 mt-2">Open items</h3>
      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm min-w-[40rem]">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className="p-3 font-medium">Number</th>
              <th className="p-3 font-medium">Date</th>
              <th className="p-3 font-medium">Due</th>
              <th className="p-3 font-medium text-right">Days overdue</th>
              <th className="p-3 font-medium text-right">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {openItems.items.map((item) => (
              <tr key={item.documentId} className="border-t border-[var(--border)]">
                <td className="p-3 font-mono text-xs">
                  {documentLink(item.documentId, item.documentNumber, notePath(item.documentKind))}
                </td>
                <td className="p-3 tabular-nums whitespace-nowrap">{item.documentDate}</td>
                <td className="p-3 tabular-nums whitespace-nowrap">{item.dueDate}</td>
                <td className="p-3 text-right tabular-nums">
                  {item.daysOverdue > 0 ? item.daysOverdue : '—'}
                </td>
                <td className="p-3 text-right tabular-nums">{formatCents(item.baseOutstandingCents)}</td>
              </tr>
            ))}
            {openItems.items.length === 0 && (
              <tr className="border-t border-[var(--border)]">
                <td colSpan={5} className="p-4 text-center text-[var(--muted)]">
                  Nothing outstanding.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 className="text-base font-semibold m-0 mt-2">Account ledger</h3>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFilter('from', e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setFilter('to', e.target.value)}
            className={inputClass}
          />
        </label>
        {(from !== '' || to !== '') && (
          <button type="button" onClick={() => setParams({})} className="btn btn--ghost">
            Clear
          </button>
        )}
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm min-w-[48rem]">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className="p-3 font-medium">Date</th>
              <th className="p-3 font-medium">Type</th>
              <th className="p-3 font-medium">Reference</th>
              <th className="p-3 font-medium text-right">Debit</th>
              <th className="p-3 font-medium text-right">Credit</th>
              <th className="p-3 font-medium text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-[var(--border)] italic text-[var(--muted)]">
              <td className="p-3" colSpan={5}>
                Opening balance
              </td>
              <td className="p-3 text-right tabular-nums">{formatCents(ledger.openingBalanceCents)}</td>
            </tr>
            {ledger.rows.map((row) => (
              <tr key={`${row.journalEntryId}-${row.documentId}`} className="border-t border-[var(--border)]">
                <td className="p-3 tabular-nums whitespace-nowrap">
                  <Link to={`/journals/${row.journalEntryId}`}>{row.entryDate}</Link>
                </td>
                <td className="p-3">{KIND_LABELS[row.kind]}</td>
                <td className="p-3 text-xs">{referenceCell(row)}</td>
                <td className="p-3 text-right tabular-nums">
                  {row.debitCents > 0 ? formatCents(row.debitCents) : ''}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {row.creditCents > 0 ? formatCents(row.creditCents) : ''}
                </td>
                <td className="p-3 text-right tabular-nums font-medium">
                  {formatCents(row.runningBalanceCents)}
                </td>
              </tr>
            ))}
            {ledger.rows.length === 0 && (
              <tr className="border-t border-[var(--border)]">
                <td colSpan={6} className="p-4 text-center text-[var(--muted)]">
                  No activity in this period.
                </td>
              </tr>
            )}
            <tr className="border-t border-[var(--border)] font-medium">
              <td className="p-3" colSpan={5}>
                Closing balance
              </td>
              <td className="p-3 text-right tabular-nums">{formatCents(ledger.closingBalanceCents)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {ledger.totalCount > PAGE_LIMIT && (
        <div className="flex items-center justify-between gap-4 text-sm text-[var(--muted)]">
          <span>
            Showing {ledger.rows.length} of {ledger.totalCount}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={page <= 1}
              onClick={() => goToPage(page - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={page >= totalPages}
              onClick={() => goToPage(page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {ledger.controlAccount !== null && (
        <p className="text-sm m-0">
          <Link to={`/accounts/${ledger.controlAccount.id}`}>
            View {ledger.controlAccount.code} {ledger.controlAccount.name} in the general ledger
          </Link>
        </p>
      )}
    </section>
  );
}
