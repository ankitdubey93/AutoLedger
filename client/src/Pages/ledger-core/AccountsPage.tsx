import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Folder, Landmark, Plus } from 'lucide-react';
import {
  getAccountBalances,
  listAccountTree,
  type Account,
  type AccountBalance,
  type AccountNode,
} from '../../services/fetchServices';
import { formatCents } from './money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import NewAccountForm from './NewAccountForm';

/**
 * The chart of accounts, as a tree.
 *
 * Header accounts (`isPostable: false`) are rendered visibly differently from
 * postable leaves, because the distinction is not cosmetic: posting to a header
 * account is rejected by a database trigger, and the UI should make that legible
 * before someone tries.
 *
 * Phase 3.6 adds a balance figure per row — rolled up for a header, its own
 * for a leaf — and turns each postable row into a link into its ledger. A
 * header has no ledger of its own (its balance is a rollup of its subtree),
 * so it stays plain text.
 *
 * Phase 3.7 adds account creation. The chart is seeded at registration but is
 * not frozen — an org can add accounts, and a new one appears via a refetch
 * (`reloadToken`) rather than by splicing it into local tree state: the
 * server owns the tree's shape, and a client-side splice would have to
 * re-derive parentId nesting itself and would drift from it over time.
 */

export const TYPE_STYLES: Record<string, string> = {
  Asset: 'bg-sky-500/10 text-sky-400 ring-sky-500/20',
  Liability: 'bg-amber-500/10 text-amber-400 ring-amber-500/20',
  Equity: 'bg-violet-500/10 text-violet-400 ring-violet-500/20',
  Revenue: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20',
  Expense: 'bg-rose-500/10 text-rose-400 ring-rose-500/20',
};

function BalanceFigure({ cents }: { cents: number | undefined }) {
  if (cents === undefined || cents === 0) {
    return <span className="text-[var(--muted)]">—</span>;
  }
  return <>{formatCents(cents)}</>;
}

function AccountRow({
  node,
  depth,
  balances,
  base,
  collapsed,
  onToggle,
}: {
  node: AccountNode;
  depth: number;
  balances: Map<string, AccountBalance> | null;
  base: string;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const Icon = node.isPostable ? Landmark : Folder;
  const balance = balances?.get(node.id);
  const figureCents = node.isPostable ? balance?.ownBalanceCents : balance?.rollupBalanceCents;
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);

  const label = (
    <>
      <span className="font-mono text-sm tabular-nums text-[var(--muted)] w-12 shrink-0">
        {node.code}
      </span>
      <span className="flex-1 text-sm">{node.name}</span>
    </>
  );

  return (
    <>
      <li
        className={[
          'flex items-center gap-3 py-2 px-3 rounded-md',
          node.isPostable ? '' : 'font-semibold',
        ].join(' ')}
        style={{ paddingLeft: `${String(depth * 1.5 + 0.75)}rem` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${node.code} ${node.name}`}
            className="p-0.5 -ml-1 rounded bg-transparent border-0 cursor-pointer text-[var(--muted)] hover:text-[var(--text)]"
          >
            <ChevronDown size={14} aria-hidden="true" className={isCollapsed ? '-rotate-90' : ''} />
          </button>
        ) : (
          <span className="w-[18px] shrink-0" aria-hidden="true" />
        )}
        <Icon
          size={15}
          aria-hidden="true"
          className={node.isPostable ? 'text-[var(--muted)]' : 'text-[var(--text)]'}
        />

        {node.isPostable ? (
          <Link
            to={`${base}/accounts/${node.id}`}
            className="flex flex-1 items-center gap-3 min-w-0 text-[var(--text)] no-underline hover:underline"
          >
            {label}
          </Link>
        ) : (
          <span
            className="flex flex-1 items-center gap-3 min-w-0"
            title="Header accounts roll up their children and have no ledger of their own"
          >
            {label}
          </span>
        )}

        {!node.isPostable && (
          <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
            header
          </span>
        )}
        <span
          className={[
            'text-[11px] px-2 py-0.5 rounded-full ring-1 ring-inset shrink-0',
            TYPE_STYLES[node.type] ?? '',
          ].join(' ')}
        >
          {node.type}
        </span>
        <span className="text-sm tabular-nums w-24 text-right shrink-0">
          <BalanceFigure cents={figureCents} />
        </span>
      </li>

      {!isCollapsed &&
        node.children.map((child) => (
          <AccountRow
            key={child.id}
            node={child}
            depth={depth + 1}
            balances={balances}
            base={base}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}

export default function AccountsPage() {
  const base = useAppBasePath();
  const [roots, setRoots] = useState<AccountNode[] | null>(null);
  const [count, setCount] = useState(0);
  const [balances, setBalances] = useState<Map<string, AccountBalance> | null>(null);
  const [balancesUnavailable, setBalancesUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  function toggleCollapsed(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    // The `ignore` flag rather than AbortController — see
    // study/react/context-effects-and-data-fetching.md for why.
    let ignore = false;

    Promise.all([listAccountTree(), getAccountBalances()])
      .then(([treeRes, balancesRes]) => {
        if (ignore) return;
        setRoots(treeRes.accounts);
        setCount(treeRes.count);
        setBalances(new Map(balancesRes.balances.map((b) => [b.accountId, b])));
      })
      .catch(() => {
        if (ignore) return;
        // The chart itself must still load even if balances fail — fall back
        // to the tree alone, fetched separately.
        listAccountTree()
          .then((treeRes) => {
            if (ignore) return;
            setRoots(treeRes.accounts);
            setCount(treeRes.count);
            setBalancesUnavailable(true);
          })
          .catch((treeErr: unknown) => {
            if (!ignore) {
              setError(treeErr instanceof Error ? treeErr.message : 'Could not load accounts');
            }
          });
      });

    return () => {
      ignore = true;
    };
  }, [reloadToken]);

  const flatAccounts = useMemo(() => {
    function walk(nodes: AccountNode[]): Account[] {
      return nodes.flatMap((node) => [node, ...walk(node.children)]);
    }
    return roots === null ? [] : walk(roots);
  }, [roots]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold m-0">Chart of accounts</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Seeded for this organization at registration. Header accounts roll up for
            reporting and cannot be posted to.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {roots !== null && (
            <span className="text-sm text-[var(--muted)] tabular-nums">{count} accounts</span>
          )}
          <button
            type="button"
            onClick={() => setShowForm((open) => !open)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)]"
          >
            <Plus size={15} aria-hidden="true" /> New account
          </button>
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {roots === null && error === null && <p className="muted">Loading…</p>}
      {balancesUnavailable && <p className="muted">Balances unavailable.</p>}

      {showForm && (
        <NewAccountForm
          accounts={flatAccounts}
          onCreated={() => {
            setShowForm(false);
            setReloadToken((t) => t + 1);
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {roots !== null && roots.length === 0 && !showForm && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center flex flex-col items-center gap-3">
          <p className="text-sm text-[var(--muted)] m-0">This organization has no accounts yet.</p>
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)]"
          >
            Create the first account
          </button>
        </div>
      )}

      {roots !== null && roots.length > 0 && (
        <ul className="list-none m-0 p-0 rounded-lg border border-[var(--border)] bg-[var(--panel)] divide-y divide-[var(--border)]">
          {roots.map((node) => (
            <AccountRow
              key={node.id}
              node={node}
              depth={0}
              balances={balances}
              base={base}
              collapsed={collapsed}
              onToggle={toggleCollapsed}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
