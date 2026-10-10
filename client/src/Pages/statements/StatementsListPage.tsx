import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, Printer, ScrollText } from 'lucide-react';
import {
  listStatementParties,
  statementQuery,
  type PartyKind,
  type StatementListRow,
} from '../../services/fetchServices';
import { useOrg } from '../../context/OrgContext';
import { useCan } from '../../context/AuthContext';
import SendStatementDialog from '../../components/statements/SendStatementDialog';
import { formatCents } from '../../utils/money';
import { formatDate } from '../../utils/date';
import { useDebouncedInput } from '../../utils/useDebouncedInput';
import PageHeader from '../../components/ui/PageHeader';
import LoadingState from '../../components/ui/LoadingState';
import EmptyState from '../../components/ui/EmptyState';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../components/ui/formClasses';
import { PATH_FOR_KIND, StatementControls, useStatementParams } from './statementParams';

/**
 * Customer / vendor statements (Phase 39a): every party's outstanding and
 * overdue balance on the chosen date, with selection for bulk print (and, in
 * 39b, bulk email). For an activity statement the balances are as at the end
 * of the range.
 */

const COPY: Record<PartyKind, { title: string; subtitle: string; party: string }> = {
  CUSTOMER: {
    title: 'Customer statements',
    subtitle: 'What each customer owes, and everything they did, on a date or over a period.',
    party: 'Customer',
  },
  VENDOR: {
    title: 'Vendor statements',
    subtitle: 'What you owe each vendor, and every bill and payment, on a date or over a period.',
    party: 'Vendor',
  },
};

export default function StatementsListPage({ kind }: { kind: PartyKind }) {
  const path = PATH_FOR_KIND[kind];
  const copy = COPY[kind];
  const { organization } = useOrg();
  const currency = organization?.baseCurrency ?? '';
  const navigate = useNavigate();
  const state = useStatementParams();
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const includeZero = params.get('zero') === '1';
  const [qDraft, setQDraft] = useDebouncedInput(q, (value) => state.setParam('q', value));

  const [rows, setRows] = useState<StatementListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [emailing, setEmailing] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const can = useCan();

  useEffect(() => {
    const controller = new AbortController();
    setRows(null);
    setError(null);
    listStatementParties(path, { asOf: state.balanceDate, q, includeZero }, controller.signal)
      .then((res) => {
        setRows(res.parties);
        setSelected((current) => new Set([...current].filter((id) => res.parties.some((p) => p.partyId === id))));
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load statements');
      });
    return () => controller.abort();
  }, [path, state.balanceDate, q, includeZero, reloadToken]);

  const totals = useMemo(
    () =>
      (rows ?? []).reduce(
        (acc, r) => ({ outstanding: acc.outstanding + r.outstandingCents, overdue: acc.overdue + r.overdueCents }),
        { outstanding: 0, overdue: 0 },
      ),
    [rows],
  );

  const query = statementQuery(state.request);
  const allSelected = rows !== null && rows.length > 0 && rows.every((r) => selected.has(r.partyId));

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected || rows === null ? new Set() : new Set(rows.map((r) => r.partyId)));
  }

  function printSelected() {
    const ids = [...selected].join(',');
    navigate(`/statements/${path}/print?${query}&ids=${encodeURIComponent(ids)}`);
  }

  return (
    <section className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        icon={ScrollText}
        title={copy.title}
        subtitle={copy.subtitle}
        actions={
          <>
            <button type="button" className={secondaryButtonClass} disabled={selected.size === 0} onClick={printSelected}>
              <span className="inline-flex items-center gap-1.5">
                <Printer size={15} aria-hidden="true" /> Print{selected.size > 0 ? ` (${String(selected.size)})` : ''}
              </span>
            </button>
            {can('statements.send') && (
              <button
                type="button"
                className={primaryButtonClass}
                disabled={selected.size === 0}
                onClick={() => setEmailing(true)}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Mail size={15} aria-hidden="true" /> Email{selected.size > 0 ? ` (${String(selected.size)})` : ''}
                </span>
              </button>
            )}
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <StatementControls state={state} />
        <label className="flex flex-col gap-1 text-sm w-56">
          <span className="text-[var(--muted)]">Search</span>
          <input type="text" value={qDraft} onChange={(e) => setQDraft(e.target.value)} className={inputClass} />
        </label>
        <label className="flex items-center gap-2 text-sm pb-1.5">
          <input
            type="checkbox"
            checked={includeZero}
            onChange={(e) => state.setParam('zero', e.target.checked ? '1' : '')}
          />
          Show zero balances
        </label>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
      {rows === null && error === null && <LoadingState />}

      {rows !== null && rows.length === 0 && (
        <EmptyState
          icon={ScrollText}
          title="Nothing to show"
          body={`No ${copy.party.toLowerCase()} has a balance on ${formatDate(state.balanceDate)}.`}
        />
      )}

      {rows !== null && rows.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[44rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 w-8">
                  <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={toggleAll} />
                </th>
                <th className="p-3 font-medium">{copy.party}</th>
                <th className="p-3 font-medium">Email</th>
                <th className="p-3 font-medium text-right">Outstanding</th>
                <th className="p-3 font-medium text-right">Overdue</th>
                <th className="p-3 font-medium">Last sent</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.partyId} className="border-t border-[var(--border)]">
                  <td className="p-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.name}`}
                      checked={selected.has(row.partyId)}
                      onChange={() => toggle(row.partyId)}
                    />
                  </td>
                  <td className="p-3">
                    <Link to={`/statements/${path}/${row.partyId}?${query}`}>{row.name}</Link>
                    {!row.isActive && <span className="ml-2 text-[11px] uppercase text-[var(--muted)]">Inactive</span>}
                  </td>
                  <td className="p-3">{row.email ?? <span className="text-[var(--muted)]">No email</span>}</td>
                  <td className="p-3 text-right tabular-nums">{formatCents(row.outstandingCents)}</td>
                  <td className={`p-3 text-right tabular-nums ${row.overdueCents > 0 ? 'text-[var(--bad)] font-medium' : ''}`}>
                    {formatCents(row.overdueCents)}
                  </td>
                  <td className="p-3 text-[var(--muted)]">{row.lastSentAt === null ? '—' : formatDate(row.lastSentAt.slice(0, 10))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-[var(--border)] font-semibold">
                <td className="p-3" colSpan={3}>
                  Total ({currency})
                </td>
                <td className="p-3 text-right tabular-nums">{formatCents(totals.outstanding)}</td>
                <td className="p-3 text-right tabular-nums">{formatCents(totals.overdue)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {emailing && rows !== null && (
        <SendStatementDialog
          kind={kind}
          path={path}
          recipients={rows
            .filter((r) => selected.has(r.partyId))
            .map((r) => ({ partyId: r.partyId, name: r.name, email: r.email }))}
          request={state.request}
          onClose={() => setEmailing(false)}
          onSent={() => setReloadToken((t) => t + 1)}
        />
      )}
    </section>
  );
}
