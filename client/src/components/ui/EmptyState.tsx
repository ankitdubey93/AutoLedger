import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  body?: string | undefined;
  action?: ReactNode | undefined;
}

/**
 * The "nothing here yet" state, used in place of a bare `<p className="muted">`
 * so an empty list reads as a deliberate state rather than a missing one.
 */
export default function EmptyState({ icon: Icon, title, body, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg bg-[var(--bg-subtle)] px-6 py-14 text-center animate-[rise_600ms_var(--ease)_both]">
      <span
        aria-hidden="true"
        className="brand-blob flex size-16 items-center justify-center !bg-[var(--accent-soft)] !text-[var(--accent)]"
      >
        <Icon size={26} />
      </span>
      <p className="m-0 text-lg font-semibold [font-family:var(--font-display)]">{title}</p>
      {body !== undefined && <p className="muted m-0">{body}</p>}
      {action !== undefined && <div className="mt-1.5">{action}</div>}
    </div>
  );
}
