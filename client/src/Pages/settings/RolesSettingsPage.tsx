import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import LoadingState from '../../components/ui/LoadingState';
import ConfirmDialog from '../../components/ConfirmDialog';
import { useOrg } from '../../context/OrgContext';
import {
  ApiRequestError,
  createRole,
  deleteRole,
  listRoles,
  updateRole,
  type CustomRole,
  type PermissionDefinition,
  type RolesOverview,
} from '../../services/fetchServices';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../components/ui/formClasses';

/** Every key `key` requires, transitively (mirrors the server's `withRequiredPermissions`). */
function requiredClosure(keys: Iterable<string>, byKey: Map<string, PermissionDefinition>): Set<string> {
  const out = new Set<string>();
  const stack = [...keys];
  while (stack.length > 0) {
    const key = stack.pop();
    if (key === undefined || out.has(key) || !byKey.has(key)) continue;
    out.add(key);
    for (const req of byKey.get(key)?.requires ?? []) stack.push(req);
  }
  return out;
}

interface Draft {
  id: string | null;
  name: string;
  description: string;
  permissions: Set<string>;
}

/**
 * Organization settings → Roles (Phase 38c). The four built-in roles are
 * fixed (their permissions are defined in code); custom roles are any set of
 * the catalogue's permissions except owner-only ones.
 *
 * The matrix keeps a role usable: ticking a permission ticks what it needs
 * (issuing invoices needs seeing them), and unticking one unticks what
 * depends on it. Permissions you do not hold yourself are disabled — the
 * server refuses them anyway (no privilege escalation).
 */
export default function RolesSettingsPage() {
  const { can, role } = useOrg();
  const [overview, setOverview] = useState<RolesOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<CustomRole | null>(null);

  const reload = useCallback(async () => {
    try {
      setOverview(await listRoles());
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 403) setDenied(true);
      else setError(err instanceof Error ? err.message : 'Could not load roles');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const byKey = useMemo(() => new Map((overview?.catalogue ?? []).map((p) => [p.key, p])), [overview]);
  const areas = useMemo(() => {
    const groups = new Map<string, PermissionDefinition[]>();
    for (const p of overview?.catalogue ?? []) groups.set(p.area, [...(groups.get(p.area) ?? []), p]);
    return [...groups.entries()];
  }, [overview]);

  const canManage = can('roles.manage');
  const isOwner = role === 'OWNER';

  function toggle(key: string, on: boolean) {
    if (draft === null) return;
    const next = new Set(draft.permissions);
    if (on) {
      for (const k of requiredClosure([key], byKey)) next.add(k);
    } else {
      next.delete(key);
      // Drop anything that can no longer stand without it.
      let changed = true;
      while (changed) {
        changed = false;
        for (const k of next) {
          if ((byKey.get(k)?.requires ?? []).some((r) => !next.has(r))) {
            next.delete(k);
            changed = true;
          }
        }
      }
    }
    setDraft({ ...draft, permissions: next });
  }

  function startFrom(preset: string) {
    if (draft === null || overview === null) return;
    const source = overview.builtin.find((b) => b.role === preset);
    const keys = (source?.permissions ?? []).filter((k) => byKey.get(k)?.tier !== 'O' && (isOwner || can(k)));
    setDraft({ ...draft, permissions: requiredClosure(keys, byKey) });
  }

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft === null) return;
    setSaving(true);
    setError(null);
    const input = {
      name: draft.name.trim(),
      description: draft.description.trim() === '' ? null : draft.description.trim(),
      permissions: [...draft.permissions],
    };
    try {
      if (draft.id === null) await createRole(input);
      else await updateRole(draft.id, input);
      setDraft(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the role');
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(target: CustomRole) {
    setConfirmDelete(null);
    setError(null);
    try {
      await deleteRole(target.id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the role');
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        as="h2"
        icon={ShieldCheck}
        title="Roles & permissions"
        subtitle="What each member can see and do. Changes apply on their next click — no need to sign out."
        actions={
          canManage && overview !== null && draft === null ? (
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => setDraft({ id: null, name: '', description: '', permissions: new Set() })}
            >
              New role
            </button>
          ) : undefined
        }
      />

      {denied && <p className="muted">Your role does not include viewing roles.</p>}
      {error !== null && (
        <p className="status status--bad" role="alert">
          {error}
        </p>
      )}
      {!denied && overview === null && error === null && <LoadingState />}

      {overview !== null && draft !== null && (
        <form className="card flex flex-col gap-4" onSubmit={(e) => void onSave(e)} aria-label="Role editor">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              Role name
              <input
                className={inputClass}
                required
                maxLength={60}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Start from
              <select className={inputClass} defaultValue="" onChange={(e) => e.target.value !== '' && startFrom(e.target.value)}>
                <option value="">— keep current selection —</option>
                <option value="VIEWER">Viewer (read only)</option>
                <option value="ACCOUNTANT">Accountant</option>
                <option value="ADMIN">Admin</option>
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            Description <span className="muted">(optional)</span>
            <input
              className={inputClass}
              maxLength={300}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>

          <div className="grid gap-4 md:grid-cols-2">
            {areas.map(([area, perms]) => (
              <fieldset key={area} className="border border-[var(--border)] rounded-md p-3 m-0">
                <legend className="text-sm font-semibold px-1">{area}</legend>
                <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
                  {perms.map((p) => {
                    const ownerOnly = p.tier === 'O';
                    const beyondMe = !isOwner && !can(p.key);
                    const disabled = ownerOnly || beyondMe;
                    return (
                      <li key={p.key}>
                        <label className={`flex items-start gap-2 text-sm ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={draft.permissions.has(p.key)}
                            disabled={disabled}
                            onChange={(e) => toggle(p.key, e.target.checked)}
                          />
                          <span>
                            {p.label}
                            {ownerOnly && <span className="muted"> — owner only</span>}
                            {!ownerOnly && beyondMe && <span className="muted"> — you don't have this</span>}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className={primaryButtonClass} disabled={saving || draft.permissions.size === 0 || draft.name.trim() === ''}>
              {saving ? 'Saving…' : draft.id === null ? 'Create role' : 'Save role'}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setDraft(null)}>
              Cancel
            </button>
            <span className="muted text-sm">{draft.permissions.size} permissions selected</span>
          </div>
        </form>
      )}

      {overview !== null && (
        <section className="card">
          <h3 className="m-0 mb-2 text-sm font-semibold">Custom roles</h3>
          {overview.custom.length === 0 ? (
            <p className="muted m-0">
              No custom roles yet. Create one to give someone exactly the access they need — for example, an invoice clerk
              who can only see and issue invoices.
            </p>
          ) : (
            <div className="table-scroll">
              <div className="overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Permissions</th>
                      <th>Members</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {overview.custom.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <div className="font-medium">{r.name}</div>
                          {r.description !== null && <div className="muted text-sm">{r.description}</div>}
                        </td>
                        <td>{r.permissions.length}</td>
                        <td>{r.memberCount}</td>
                        <td className="text-right whitespace-nowrap">
                          {canManage && (
                            <>
                              <button
                                type="button"
                                className={secondaryButtonClass}
                                onClick={() =>
                                  setDraft({
                                    id: r.id,
                                    name: r.name,
                                    description: r.description ?? '',
                                    permissions: new Set(r.permissions),
                                  })
                                }
                              >
                                Edit
                              </button>{' '}
                              <button
                                type="button"
                                className={secondaryButtonClass}
                                disabled={r.memberCount > 0}
                                title={r.memberCount > 0 ? 'Give its members another role first' : undefined}
                                onClick={() => setConfirmDelete(r)}
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {overview !== null && (
        <section className="card">
          <h3 className="m-0 mb-2 text-sm font-semibold">Built-in roles</h3>
          <p className="muted text-sm mt-0">Fixed for every organization. Use them as a starting point for a custom role.</p>
          <ul className="m-0 p-0 list-none flex flex-col gap-1 text-sm">
            {overview.builtin.map((b) => (
              <li key={b.role}>
                <span className="chip">{b.role}</span> {b.permissions.length} permissions
                {b.role === 'OWNER' && ' — everything, including permanently locking periods and webhook secrets'}
              </li>
            ))}
          </ul>
        </section>
      )}

      {confirmDelete !== null && (
        <ConfirmDialog
          title={`Delete the role "${confirmDelete.name}"?`}
          body="Open invitations into this role are withdrawn as well."
          confirmLabel="Delete role"
          tone="danger"
          onConfirm={() => void onDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
