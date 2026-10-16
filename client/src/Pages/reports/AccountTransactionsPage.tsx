import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ListTree } from 'lucide-react';
import {
  getAccountTransactions,
  listAccounts,
  type Account,
  type AccountTransactionGrouping,
  type AccountTransactionGroup,
  type AccountTransactionLine,
  type AccountTransactionMode,
  type AccountTransactionsReport,
  type AccountType,
} from '../../services/fetchServices';
import { useLedgerSettings } from '../../context/LedgerSettingsContext';
import { fiscalYearBounds } from '../accounting/fiscalYear';
import { formatCents } from '../../utils/money';
import { formatDate } from '../../utils/date';
import BackLink from '../../components/BackLink';
import LoadingState from '../../components/ui/LoadingState';
import EmptyState from '../../components/ui/EmptyState';
import TabBar from '../../components/ui/TabBar';
import ExportMenu from '../../components/ui/ExportMenu';
import { inputClass } from '../../components/ui/formClasses';

/**
 * Account transactions — every posted ledger line across one or more accounts,
 * with contact, reference and running balances, grouped and filtered by the
 * server (reportService analogue of Xero's "Account Transactions"). The page
 * holds only the controls; URL state keeps a view shareable, and the chosen
 * columns live in localStorage because they are a personal preference.
 */

const COLUMN_STORAGE_KEY = 'autoledger.accountTransactions.columns';

interface ColumnDef {
  key: string;
  label: string;
  align: 'left' | 'right';
}

/** Mirrors server ACCOUNT_TRANSACTION_COLUMNS and the labels of the export adapter. */
const COLUMNS: readonly ColumnDef[] = [
  { key: 'date', label: 'Date', align: 'left' },
  { key: 'source', label: 'Source', align: 'left' },
  { key: 'reference', label: 'Reference', align: 'left' },
  { key: 'contact', label: 'Contact', align: 'left' },
  { key: 'description', label: 'Description', align: 'left' },
  { key: 'account', label: 'Account', align: 'left' },
  { key: 'debit', label: 'Debit', align: 'right' },
  { key: 'credit', label: 'Credit', align: 'right' },
  { key: 'net', label: 'Net', align: 'right' },
  { key: 'runningBalance', label: 'Balance', align: 'right' },
  { key: 'currency', label: 'Currency', align: 'left' },
  { key: 'nativeAmount', label: 'Amount (native)', align: 'right' },
  { key: 'fxRate', label: 'FX rate', align: 'right' },
  { key: 'createdBy', label: 'Created by', align: 'left' },
];

const DEFAULT_COLUMNS: readonly string[] = [
  'date',
  'source',
  'reference',
  'contact',
  'description',
  'debit',
  'credit',
  'runningBalance',
];

const GROUPINGS: readonly { value: AccountTransactionGrouping; label: string }[] = [
  { value: 'account', label: 'Account' },
  { value: 'month', label: 'Month' },
  { value: 'sourceType', label: 'Source' },
  { value: 'contact', label: 'Contact' },
  { value: 'none', label: 'None' },
];

const TYPE_ORDER: readonly AccountType[] = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];

function loadColumns(): string[] {
  try {
    const raw = window.localStorage.getItem(COLUMN_STORAGE_KEY);
    if (raw === null) return [...DEFAULT_COLUMNS];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_COLUMNS];
    const known = COLUMNS.map((c) => c.key);
    const kept = parsed.filter((v): v is string => typeof v === 'string' && known.includes(v));
    return kept.length === 0 ? [...DEFAULT_COLUMNS] : kept;
  } catch {
    return [...DEFAULT_COLUMNS];
  }
}

function saveColumns(columns: string[]): void {
  try {
    window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(columns));
  } catch {
    // A full or blocked store only loses the preference.
  }
}

// ---- UTC calendar helpers (never `new Date('YYYY-MM-DD')` in local time) ----

const iso = (d: Date) => d.toISOString().slice(0, 10);
const todayIso = () => iso(new Date());

function monthBounds(year: number, monthIndex: number): { from: string; to: string } {
  return { from: iso(new Date(Date.UTC(year, monthIndex, 1))), to: iso(new Date(Date.UTC(year, monthIndex + 1, 0))) };
}

function shiftYear(isoDate: string, years: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return iso(new Date(Date.UTC((y ?? 0) + years, (m ?? 1) - 1, d ?? 1)));
}

function cellValue(key: string, line: AccountTransactionLine): React.ReactNode {
  switch (key) {
    case 'date':
      return (
        <Link to={`/journals/${line.entryId}`} className="text-[var(--text)] hover:underline">
          {formatDate(line.entryDate)}
        </Link>
      );
    case 'source':
      return line.sourceLabel;
    case 'reference':
      return line.reference ?? '';
    case 'contact':
      return line.contactName ?? '';
    case 'description':
      return line.description ?? '';
    case 'account':
      return `${line.accountCode} ${line.accountName}`;
    case 'debit':
      return line.debitCents === 0 ? '' : formatCents(line.debitCents);
    case 'credit':
      return line.creditCents === 0 ? '' : formatCents(line.creditCents);
    case 'net':
      return formatCents(line.netCents);
    case 'runningBalance':
      return line.runningBalanceCents === null ? '' : formatCents(line.runningBalanceCents);
    case 'currency':
      return line.currencyCode;
    case 'nativeAmount':
      return formatCents(line.nativeDebitCents - line.nativeCreditCents);
    case 'fxRate':
      return line.fxRate;
    case 'createdBy':
      return line.createdByName ?? '';
    default:
      return '';
  }
}

/** A group-level figure for the same column key (opening, subtotal and summary rows). */
function groupValue(key: string, group: AccountTransactionGroup, row: 'subtotal' | 'opening'): React.ReactNode {
  if (row === 'opening') {
    return key === 'runningBalance' && group.openingBalanceCents !== null ? formatCents(group.openingBalanceCents) : '';
  }
  switch (key) {
    case 'debit':
      return formatCents(group.debitCents);
    case 'credit':
      return formatCents(group.creditCents);
    case 'net':
      return formatCents(group.netCents);
    case 'runningBalance':
      return group.closingBalanceCents === null ? '' : formatCents(group.closingBalanceCents);
    default:
      return '';
  }
}

export default function AccountTransactionsPage() {
  const [params, setParams] = useSearchParams();
  const ledgerSettings = useLedgerSettings();

  const now = useMemo(() => {
    const d = new Date();
    return monthBounds(d.getUTCFullYear(), d.getUTCMonth());
  }, []);

  const accountIds = (params.get('accountIds') ?? '').split(',').filter((v) => v !== '');
  const from = params.get('from') ?? now.from;
  const to = params.get('to') ?? now.to;
  const rawGroup = params.get('groupBy');
  const groupBy: AccountTransactionGrouping = GROUPINGS.some((g) => g.value === rawGroup)
    ? (rawGroup as AccountTransactionGrouping)
    : 'account';
  const mode: AccountTransactionMode = params.get('mode') === 'summary' ? 'summary' : 'detail';

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [columns, setColumns] = useState<string[]>(loadColumns);
  const [report, setReport] = useState<AccountTransactionsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let ignore = false;
    listAccounts()
      .then((res) => {
        if (!ignore) setAccounts(res.accounts.filter((a) => a.isPostable && a.isActive));
      })
      .catch(() => {
        // The picker is optional: an empty selection already means "All accounts".
      });
    return () => {
      ignore = true;
    };
  }, []);

  const accountKey = accountIds.join(',');
  useEffect(() => {
    let ignore = false;
    setError(null);
    setReport(null);
    getAccountTransactions({ accountIds: accountKey === '' ? [] : accountKey.split(','), from, to, groupBy, mode, sourceTypes: [] })
      .then((res) => {
        if (!ignore) setReport(res);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load account transactions');
      });
    return () => {
      ignore = true;
    };
  }, [accountKey, from, to, groupBy, mode]);

  function setParam(updates: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  }

  function toggleAccount(id: string) {
    const next = accountIds.includes(id) ? accountIds.filter((a) => a !== id) : [...accountIds, id];
    setParam({ accountIds: next.join(',') });
  }

  function toggleColumn(key: string) {
    const has = columns.includes(key);
    if (has && columns.length === 1) return;
    const next = COLUMNS.map((c) => c.key).filter((k) => (k === key ? !has : columns.includes(k)));
    setColumns(next);
    saveColumns(next);
  }

  function toggleCollapsed(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function applyPreset(preset: 'thisMonth' | 'lastMonth' | 'thisQuarter' | 'thisFy' | 'lastFy') {
    const today = new Date();
    const y = today.getUTCFullYear();
    const m = today.getUTCMonth();
    let range: { from: string; to: string };
    if (preset === 'thisMonth') range = monthBounds(y, m);
    else if (preset === 'lastMonth') range = monthBounds(y, m - 1);
    else if (preset === 'thisQuarter') {
      const q = Math.floor(m / 3) * 3;
      range = { from: monthBounds(y, q).from, to: monthBounds(y, q + 2).to };
    } else {
      const settings = ledgerSettings.status === 'ready' ? ledgerSettings.settings : null;
      const startMonth = settings?.fiscalYearStartMonth ?? 1;
      const startDay = settings?.fiscalYearStartDay ?? 1;
      const bounds = fiscalYearBounds(startMonth, startDay, todayIso());
      if (preset === 'thisFy') range = { from: bounds.startDate, to: bounds.endDate };
      else {
        const prior = fiscalYearBounds(startMonth, startDay, shiftYear(bounds.startDate, -1));
        range = { from: prior.startDate, to: prior.endDate };
      }
    }
    setParam({ from: range.from, to: range.to });
  }

  const shownColumns = COLUMNS.filter((c) => columns.includes(c.key));
  const selectedColumnKeys = shownColumns.map((c) => c.key).join(',');
  const accountsByType = TYPE_ORDER.map((type) => ({ type, items: accounts.filter((a) => a.type === type) })).filter(
    (g) => g.items.length > 0,
  );

  const presets: { id: Parameters<typeof applyPreset>[0]; label: string }[] = [
    { id: 'thisMonth', label: 'This month' },
    { id: 'lastMonth', label: 'Last month' },
    { id: 'thisQuarter', label: 'This quarter' },
    { id: 'thisFy', label: 'This financial year' },
    { id: 'lastFy', label: 'Last financial year' },
  ];

  const colSpan = shownColumns.length;

  return (
    <section className="flex flex-col gap-4">
      <BackLink to="/reports" label="Back to reports" />

      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Account transactions</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Every posted line, with contact and reference, grouped and filtered on the server.
          </p>
        </div>
        <ExportMenu
          path="/reports/account-transactions"
          params={{
            accountIds: accountKey === '' ? null : accountKey,
            from,
            to,
            groupBy,
            mode,
            columns: selectedColumnKeys,
          }}
        />
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <details className="relative">
          <summary className="cursor-pointer rounded-md border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-sm">
            {accountIds.length === 0 ? 'All accounts' : `${accountIds.length} selected`}
          </summary>
          <div className="absolute z-10 mt-1 max-h-80 w-72 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--panel)] p-3 shadow-lg">
            <button type="button" className="btn btn--ghost mb-2" onClick={() => setParam({ accountIds: null })}>
              Clear
            </button>
            {accountsByType.map((group) => (
              <fieldset key={group.type} className="m-0 mb-2 border-0 p-0">
                <legend className="text-xs uppercase tracking-wide text-[var(--muted)]">{group.type}</legend>
                {group.items.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 py-0.5 text-sm">
                    <input type="checkbox" checked={accountIds.includes(a.id)} onChange={() => toggleAccount(a.id)} />
                    <span>
                      {a.code} {a.name}
                    </span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
        </details>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">From</span>
          <input type="date" value={from} onChange={(e) => setParam({ from: e.target.value })} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">To</span>
          <input type="date" value={to} onChange={(e) => setParam({ to: e.target.value })} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Group by</span>
          <select value={groupBy} onChange={(e) => setParam({ groupBy: e.target.value })} className={inputClass}>
            {GROUPINGS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <TabBar
          variant="buttons"
          ariaLabel="Report mode"
          active={mode}
          onChange={(id) => setParam({ mode: id === 'summary' ? 'summary' : null })}
          items={[
            { id: 'detail', label: 'Detail' },
            { id: 'summary', label: 'Summary' },
          ]}
        />
        <details className="relative">
          <summary className="cursor-pointer rounded-md border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-sm">
            Columns
          </summary>
          <div className="absolute z-10 mt-1 w-56 rounded-md border border-[var(--border)] bg-[var(--panel)] p-3 shadow-lg">
            {COLUMNS.map((c) => (
              <label key={c.key} className="flex items-center gap-2 py-0.5 text-sm">
                <input type="checkbox" checked={columns.includes(c.key)} onChange={() => toggleColumn(c.key)} />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
        </details>
      </div>

      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <button key={p.id} type="button" className="btn btn--ghost" onClick={() => applyPreset(p.id)}>
            {p.label}
          </button>
        ))}
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
      {report === null && error === null && <LoadingState />}
      {report !== null && report.groups.length === 0 && (
        <EmptyState icon={ListTree} title="No transactions in this range" />
      )}

      {report !== null && report.groups.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[40rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                {shownColumns.map((c) => (
                  <th key={c.key} className={`p-3 font-medium ${c.align === 'right' ? 'text-right' : ''}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.groups.map((group) => {
                const isCollapsed = collapsed.has(group.key);
                if (report.mode === 'summary') {
                  return (
                    <tr key={group.key} className="border-t border-[var(--border)]">
                      {shownColumns.map((c, i) => (
                        <td key={c.key} className={`p-3 tabular-nums ${c.align === 'right' ? 'text-right' : ''}`}>
                          {i === 0 ? group.label : groupValue(c.key, group, 'subtotal')}
                        </td>
                      ))}
                    </tr>
                  );
                }
                return (
                  <GroupRows
                    key={group.key}
                    group={group}
                    columns={shownColumns}
                    colSpan={colSpan}
                    collapsed={isCollapsed}
                    onToggle={() => toggleCollapsed(group.key)}
                  />
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[var(--border)] font-semibold">
                {shownColumns.map((c, i) => (
                  <td key={c.key} className={`p-3 tabular-nums ${c.align === 'right' ? 'text-right' : ''}`}>
                    {i === 0
                      ? 'Total'
                      : c.key === 'debit'
                        ? formatCents(report.totalDebitCents)
                        : c.key === 'credit'
                          ? formatCents(report.totalCreditCents)
                          : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function GroupRows({
  group,
  columns,
  colSpan,
  collapsed,
  onToggle,
}: {
  group: AccountTransactionGroup;
  columns: readonly ColumnDef[];
  colSpan: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-t border-[var(--border)] bg-[var(--bg)]">
        <td className="p-3 font-semibold" colSpan={colSpan}>
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={onToggle}
            className="border-0 bg-transparent p-0 text-left font-semibold text-[var(--text)] cursor-pointer"
          >
            <span aria-hidden="true">{collapsed ? '▸ ' : '▾ '}</span>
            {group.label}
          </button>
        </td>
      </tr>
      {!collapsed && group.openingBalanceCents !== null && (
        <tr className="border-t border-[var(--border)] text-[var(--muted)]">
          {columns.map((c, i) => (
            <td key={c.key} className={`p-3 tabular-nums ${c.align === 'right' ? 'text-right' : ''}`}>
              {i === 0 ? 'Opening balance' : groupValue(c.key, group, 'opening')}
            </td>
          ))}
        </tr>
      )}
      {!collapsed &&
        group.lines.map((line) => (
          <tr key={line.lineId} className="border-t border-[var(--border)]">
            {columns.map((c) => (
              <td key={c.key} className={`p-3 tabular-nums ${c.align === 'right' ? 'text-right' : ''}`}>
                {cellValue(c.key, line)}
              </td>
            ))}
          </tr>
        ))}
      <tr className="border-t border-[var(--border)] bg-[var(--bg)] font-medium">
        {columns.map((c, i) => (
          <td key={c.key} className={`p-3 tabular-nums ${c.align === 'right' ? 'text-right' : ''}`}>
            {i === 0 ? `Total ${group.label}` : groupValue(c.key, group, 'subtotal')}
          </td>
        ))}
      </tr>
    </>
  );
}
