import { Lock } from 'lucide-react';
import type { SystemRoleRef } from '../../services/fetchServices';

/**
 * Phase 46a — marks an account the system posts to or reasons about. The badge
 * is informational: it says the account can be renamed but not retired, which
 * is what the server enforces. Renders nothing for an ordinary account.
 */
export default function SystemAccountBadge({ roles }: { roles: SystemRoleRef[] }) {
  if (roles.length === 0) return null;

  const labels = roles.map((role) => role.label).join(' and ');

  return (
    <span
      title={`System account: ${labels}. It can be renamed but not retired.`}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-[var(--panel-2)] text-[var(--muted)]"
    >
      <Lock size={11} aria-hidden="true" />
      System
    </span>
  );
}
