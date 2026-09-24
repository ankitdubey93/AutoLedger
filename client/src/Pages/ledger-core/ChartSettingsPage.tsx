import { useEffect, useMemo, useState } from 'react';
import { Folder, Landmark, ListTree } from 'lucide-react';
import {
  listAccountTree,
  updateAccount,
  type Account,
  type AccountNode,
  type AccountType,
} from '../../services/fetchServices';
import { TYPE_STYLES } from './AccountsPage';
import NewAccountForm, { ACCOUNT_TYPES } from './NewAccountForm';
import SettingsTabs from './SettingsTabs';
import PageHeader from '../../components/ui/PageHeader';

/**
 * Phase 30 — the Chart of accounts tab: an in-settings account builder.
 *
 * Zero new endpoints. This page is `AccountsPage`'s tree (`listAccountTree`)
 * and `NewAccountForm` (`createAccount`) reused, plus the one client function
 * this step adds — `updateAccount` — for inline rename and activate/retire.
 * There is no "Suggested accounts" block: `DEFAULT_CHART` is never exposed
 * over the API, only used once by `seedDefaultChart` during onboarding, and
 * duplicating it client-side would be a second source of truth that drifts.
 *
 * Grouped by the five fixed account types (rule 12 — never a sixth), in the
 * order `ACCOUNT_TYPES` already fixes for `NewAccountForm`'s type select, so
 * this page and the create form can never disagree about the list.
 *
 * An account is never deleted here (rule 6, extended by convention): rename
 * and retire are the only two verbs, both `PATCH /ledger-core/accounts/:id`,
 * which the server's zod schema restricts to `name`, `description`,
 * `isActive`, `parentId` — never `code` or `type`.
 */

function ChartRow({
  node,
  depth,
  onRenamed,
  onToggleActive,
}: {
  node: AccountNode;
  depth: number;
  onRenamed: (id: string, name: string) => Promise<void>;
  onToggleActive: (node: AccountNode) => Promise<void>;
}) {
  const Icon = node.isPostable ? Landmark : Folder;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(node.name);
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  useEffect(() => {
    setName(node.name);
  }, [node.name]);

  async function handleRenameSave() {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === node.name) {
      setEditing(false);
      setName(node.name);
      return;
    }
    setBusy(true);
    setRowError(null);
    try {
      await onRenamed(node.id, trimmed);
      setEditing(false);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Could not rename the account');
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle() {
    setBusy(true);
    setRowError(null);
    try {
      await onToggleActive(node);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Could not update the account');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <li
        className={['flex items-center gap-3 py-2 px-3', node.isPostable ? '' : 'font-semibold'].join(' ')}
        style={{ paddingLeft: `${String(depth * 1.5 + 0.75)}rem` }}
      >
        <Icon
          size={15}
          aria-hidden="true"
          className={node.isPostable ? 'text-[var(--muted)]' : 'text-[var(--text)]'}
        />
        <span className="font-mono text-sm tabular-nums text-[var(--muted)] w-12 shrink-0">
          {node.code}
        </span>

        {editing ? (
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label={`Rename ${node.code} ${node.name}`}
            disabled={busy}
            className="flex-1 min-w-0 bg-[var(--bg)] border border-[var(--border)] rounded-md px-2 py-1 text-sm text-[var(--text)]"
          />
        ) : (
          <span className="flex-1 min-w-0 text-sm">{node.name}</span>
        )}

        <span
          className={[
            'text-[11px] px-2 py-0.5 rounded-full ring-1 ring-inset shrink-0',
            TYPE_STYLES[node.type] ?? '',
          ].join(' ')}
        >
          {node.type}
        </span>

        <span
          className={[
            'text-[11px] uppercase tracking-wide shrink-0',
            node.isActive ? 'text-[var(--muted)]' : 'text-rose-400',
          ].join(' ')}
        >
          {node.isActive ? 'Active' : 'Retired'}
        </span>

        {editing ? (
          <>
            <button
              type="button"
              onClick={() => void handleRenameSave()}
              disabled={busy}
              className="btn btn--ghost text-xs shrink-0"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setName(node.name);
                setRowError(null);
              }}
              disabled={busy}
              className="btn btn--ghost text-xs shrink-0"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy}
            className="btn btn--ghost text-xs shrink-0"
          >
            Rename
          </button>
        )}

        <button
          type="button"
          onClick={() => void handleToggle()}
          disabled={busy}
          className="btn btn--ghost text-xs shrink-0"
        >
          {node.isActive ? 'Retire' : 'Activate'}
        </button>
      </li>

      {rowError !== null && (
        <li style={{ paddingLeft: `${String(depth * 1.5 + 2.25)}rem` }} className="px-3">
          <p className="status status--bad text-xs m-0 py-1">{rowError}</p>
        </li>
      )}

      {node.children.map((child) => (
        <ChartRow
          key={child.id}
          node={child}
          depth={depth + 1}
          onRenamed={onRenamed}
          onToggleActive={onToggleActive}
        />
      ))}
    </>
  );
}

export default function ChartSettingsPage() {
  const [roots, setRoots] = useState<AccountNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [addFormType, setAddFormType] = useState<AccountType | null>(null);

  useEffect(() => {
    let ignore = false;
    listAccountTree()
      .then((response) => {
        if (!ignore) setRoots(response.accounts);
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setError(err instanceof Error ? err.message : 'Could not load the chart of accounts');
        }
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

  async function handleRenamed(id: string, name: string) {
    await updateAccount(id, { name });
    setReloadToken((t) => t + 1);
  }

  async function handleToggleActive(node: AccountNode) {
    await updateAccount(node.id, { isActive: !node.isActive });
    setReloadToken((t) => t + 1);
  }

  return (
    <section className="flex flex-col gap-6">
      <PageHeader as="h2" icon={ListTree} title="Settings" />

      <SettingsTabs />

      <div>
        <h3 className="text-base font-semibold m-0">Chart of accounts</h3>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Rename an account or retire it — accounts are never deleted, so history stays intact.
        </p>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
      {roots === null && error === null && <p className="muted">Loading…</p>}

      {roots !== null &&
        ACCOUNT_TYPES.map((type) => {
          const typeRoots = roots.filter((node) => node.type === type);
          return (
            <div key={type} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <span
                  className={[
                    'text-[11px] px-2 py-0.5 rounded-full ring-1 ring-inset',
                    TYPE_STYLES[type] ?? '',
                  ].join(' ')}
                >
                  {type}
                </span>
                <button
                  type="button"
                  onClick={() => setAddFormType(addFormType === type ? null : type)}
                  className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors"
                >
                  Add account
                </button>
              </div>

              {addFormType === type && (
                <NewAccountForm
                  accounts={flatAccounts}
                  initialType={type}
                  onCreated={() => {
                    setAddFormType(null);
                    setReloadToken((t) => t + 1);
                  }}
                  onCancel={() => setAddFormType(null)}
                />
              )}

              {typeRoots.length === 0 ? (
                <p className="text-sm text-[var(--muted)] m-0">No {type.toLowerCase()} accounts yet.</p>
              ) : (
                <ul className="list-none m-0 p-0 rounded-lg border border-[var(--border)] bg-[var(--panel)] divide-y divide-[var(--border)]">
                  {typeRoots.map((node) => (
                    <ChartRow
                      key={node.id}
                      node={node}
                      depth={0}
                      onRenamed={handleRenamed}
                      onToggleActive={handleToggleActive}
                    />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
    </section>
  );
}
