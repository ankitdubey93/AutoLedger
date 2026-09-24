import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  body?: string;
  action?: ReactNode;
}

/**
 * The "nothing here yet" state, used in place of a bare `<p className="muted">`
 * so an empty list reads as a deliberate state rather than a missing one.
 */
export default function EmptyState({ icon: Icon, title, body, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--border)] px-6 py-10 text-center">
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-full bg-[var(--panel-2)] text-[var(--muted)]"
      >
        <Icon size={20} />
      </span>
      <p className="m-0 text-sm font-medium">{title}</p>
      {body !== undefined && <p className="muted m-0">{body}</p>}
      {action !== undefined && <div className="mt-1.5">{action}</div>}
    </div>
  );
}
