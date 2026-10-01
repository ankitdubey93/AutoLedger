import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ApiRequestError,
  createInvitation,
  listInvitations,
  listMembers,
  removeMember,
  revokeInvitation,
  updateMemberRole,
  type Invitation,
  type OrganizationMember,
  type Role,
} from '../services/fetchServices';
import { useAuth } from '../context/AuthContext';
import { useOrg } from '../context/OrgContext';
import LoadingState from '../components/ui/LoadingState';
import ConfirmDialog from '../components/ConfirmDialog';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../components/ui/formClasses';

const ROLES: Role[] = ['OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'];

/**
 * Account → Members. Everyone in the active organization, plus (Phase 37)
 * inviting people, changing roles and removing members.
 *
 * Visible to OWNER and ADMIN only — the server answers 403 to anyone else,
 * shown as RBAC working rather than as an error. The OWNER role can only be
 * granted, changed or removed by an OWNER, and the last OWNER cannot be
 * demoted or removed; the selects below offer only what the server allows,
 * and the server enforces it regardless.
 *
 * There is no mail transport, so an invitation's link is shown once, here,
 * for the inviter to copy and send themselves.
 */
export default function MembersPanel() {
  const auth = useAuth();
  const { role } = useOrg();
  const myId = auth.status === 'authenticated' ? auth.user.id : null;

  const [members, setMembers] = useState<OrganizationMember[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<OrganizationMember | null>(null);
  const [busy, setBusy] = useState(false);

  // Members and invitations load independently: a failed invitations request
  // must not hide the member list (Promise.all would reject both).
  const reload = useCallback(async () => {
    const [m, i] = await Promise.allSettled([listMembers(), listInvitations()]);
    if (m.status === 'rejected') {
      // A 403 is not a failure — it is RBAC working, and worth showing as such.
      if (m.reason instanceof ApiRequestError && m.reason.status === 403) {
        setDenied(true);
        return;
      }
      setError(m.reason instanceof Error ? m.reason.message : 'Could not load members');
      return;
    }
    setMembers(m.value.members);
    if (i.status === 'fulfilled') {
      setInvitations(i.value.invitations);
    } else {
      setError(i.reason instanceof Error ? i.reason.message : 'Could not load invitations');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const isOwner = role === 'OWNER';
  const ownerCount = members?.filter((m) => m.role === 'OWNER').length ?? 0;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (denied) {
    return (
      <section className="card">
        <h2>Members</h2>
        <p className="muted">
          Visible to <code>OWNER</code> and <code>ADMIN</code> only. Your role is <code>{role ?? 'unknown'}</code>.
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="card">
        <h2>Members</h2>

        {error !== null && (
          <p className="status status--bad" role="alert">
            {error}
          </p>
        )}

        {members === null && error === null && <LoadingState />}

        {members !== null && (
          <div className="table-scroll">
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Joined</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => {
                    const isMe = m.userId === myId;
                    // Only an owner touches an owner; the last owner stays an owner.
                    const locked = (m.role === 'OWNER' && (!isOwner || ownerCount <= 1)) || busy;
                    return (
                      <tr key={m.userId}>
                        <td>
                          {m.name ?? '—'}
                          {isMe && <span className="muted"> (you)</span>}
                        </td>
                        <td>{m.email}</td>
                        <td>
                          <select
                            aria-label={`Role for ${m.email}`}
                            className={inputClass}
                            value={m.role}
                            disabled={locked}
                            onChange={(e) => void run(() => updateMemberRole(m.userId, e.target.value as Role))}
                          >
                            {ROLES.filter((r) => isOwner || r !== 'OWNER' || r === m.role).map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>{new Date(m.joinedAt).toLocaleDateString()}</td>
                        <td className="text-right">
                          {!isMe && (
                            <button
                              type="button"
                              className={secondaryButtonClass}
                              disabled={locked}
                              onClick={() => setConfirmRemove(m)}
                            >
                              Remove
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {members !== null && (
        <InvitationsCard
          invitations={invitations}
          canInviteOwner={isOwner}
          onChanged={() => void reload()}
          onRevoke={(id) => void run(() => revokeInvitation(id))}
          busy={busy}
        />
      )}

      {confirmRemove !== null && (
        <ConfirmDialog
          title={`Remove ${confirmRemove.name ?? confirmRemove.email}?`}
          body="They lose access to this organization's books. Their own organizations are not affected."
          confirmLabel="Remove member"
          tone="danger"
          busy={busy}
          onConfirm={() => {
            const target = confirmRemove;
            setConfirmRemove(null);
            void run(() => removeMember(target.userId));
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </>
  );
}

function InvitationsCard({
  invitations,
  canInviteOwner,
  onChanged,
  onRevoke,
  busy,
}: {
  invitations: Invitation[];
  canInviteOwner: boolean;
  onChanged: () => void;
  onRevoke: (id: string) => void;
  busy: boolean;
}) {
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('ACCOUNTANT');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setError(null);
    setCopied(false);
    try {
      const res = await createInvitation({ email: email.trim(), role: inviteRole });
      setLink({ email: res.invitation.email, url: res.acceptUrl });
      setEmail('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the invitation');
    } finally {
      setSending(false);
    }
  }

  async function copy() {
    if (link === null) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (insecure origin, permissions); the
      // link is still on screen to select by hand.
    }
  }

  return (
    <section className="card">
      <h2>Invite someone</h2>
      <p className="muted">
        They join this organization with the role you choose. Invitations last 7 days; the link is shown once — copy
        it and send it to them.
      </p>

      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => void onSubmit(e)}>
        <label className="flex flex-col gap-1 text-sm grow min-w-[14rem]">
          Email
          <input
            type="email"
            required
            className={inputClass}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Role
          <select className={inputClass} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
            {ROLES.filter((r) => canInviteOwner || r !== 'OWNER').map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={primaryButtonClass} disabled={sending || email.trim() === ''}>
          {sending ? 'Inviting…' : 'Create invitation'}
        </button>
      </form>

      {error !== null && (
        <p className="status status--bad" role="alert">
          {error}
        </p>
      )}

      {link !== null && (
        <div className="mt-3 flex flex-col gap-2" role="status">
          <p className="m-0 text-sm">
            Invitation link for <strong>{link.email}</strong> — this is the only time it is shown:
          </p>
          <div className="flex gap-2">
            <input readOnly aria-label="Invitation link" className={inputClass} value={link.url} onFocus={(e) => e.target.select()} />
            <button type="button" className={secondaryButtonClass} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {invitations.length > 0 && (
        <div className="table-scroll mt-4">
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Pending invitation</th>
                  <th>Role</th>
                  <th>Invited by</th>
                  <th>Expires</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {invitations.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>
                      <span className="chip">{i.role}</span>
                    </td>
                    <td>{i.invitedByName ?? '—'}</td>
                    <td>
                      {i.status === 'EXPIRED' ? (
                        <span className="status--bad">Expired</span>
                      ) : (
                        new Date(i.expiresAt).toLocaleDateString()
                      )}
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        className={secondaryButtonClass}
                        disabled={busy}
                        onClick={() => onRevoke(i.id)}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
