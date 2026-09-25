import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface PageHeaderProps {
  icon?: LucideIcon;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Which heading element to render — callers keep their existing h1/h2 semantics. */
  as?: 'h1' | 'h2';
}

/**
 * A shared page-header layout: an optional icon chip, a title, a subtitle
 * and a right-aligned actions slot. It does not own heading level (`as`
 * defaults to 'h1' but every Accounting list/detail page currently uses
 * `h2`), so adopting it never changes a page's outline for assistive tech.
 */
export default function PageHeader({ icon: Icon, title, subtitle, actions, as = 'h1' }: PageHeaderProps) {
  const Heading = as;
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        {Icon && (
          <span
            aria-hidden="true"
            className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--accent-soft)] text-[var(--accent)]"
          >
            <Icon size={18} />
          </span>
        )}
        <div>
          <Heading>{title}</Heading>
          {subtitle !== undefined && <p className="subtitle">{subtitle}</p>}
        </div>
      </div>
      {actions !== undefined && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
