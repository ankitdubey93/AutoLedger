import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiRequestError, listMemberActivity, type MemberActivity } from '../../services/fetchServices';
import LoadingState from '../../components/ui/LoadingState';

/**
 * Phase 46d — per-member activity for managers: when each member last signed
 * in to THIS organization, failed sign-ins and changes in the last 30 days.
 * Each row links to the audit trail filtered to that member.
 *
 * The server gates this on audit.view (OWNER and ADMIN); a 403 renders inline
 * rather than being anticipated client-side (the Phase 3.7 ruling).
 */
export default function UserActivityPage() {
  const [members, setMembers] = useState<MemberActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    listMemberActivity(controller.signal)
      .then((res) => setMembers(res.members))
      .catch((err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 403) {
          setForbidden(true);
          return;
        }
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Could not load member activity');
      });
    return () => controller.abort();
  }, []);

  if (forbidden) {
    return (
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold m-0">User activity</h2>
        <p className="status status--bad">Only an owner or admin can view member activity.</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold m-0">User activity</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          When each member last signed in to this organization, and what they changed.
        </p>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {members === null && error === null && <LoadingState />}

      {members !== null && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[40rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Member</th>
                <th className="p-3 font-medium">Role</th>
                <th className="p-3 font-medium">Last sign-in</th>
                <th className="p-3 font-medium">Failed sign-ins (30 days)</th>
                <th className="p-3 font-medium">Changes (30 days)</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId} className="border-t border-[var(--border)]">
                  <td className="p-3">
                    <Link to={`/settings/audit?actor=${encodeURIComponent(m.userId)}`} className="font-medium">
                      {m.name ?? m.email}
                    </Link>
                    {m.name !== null && <div className="text-xs text-[var(--muted)]">{m.email}</div>}
                  </td>
                  <td className="p-3">{m.role}</td>
                  <td className="p-3 whitespace-nowrap">
                    {m.lastSignInAt === null ? 'Never' : new Date(m.lastSignInAt).toLocaleString()}
                  </td>
                  <td className="p-3">{m.failedSignInsLast30Days}</td>
                  <td className="p-3">{m.changesLast30Days}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
