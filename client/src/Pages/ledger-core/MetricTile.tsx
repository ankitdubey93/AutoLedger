import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { formatCents } from './money';

/**
 * A dashboard position tile. Renders as a link when `to` is given — the
 * dashboard's Assets/Liabilities/Equity/Cash tiles drill into the trial
 * balance filtered by account type (see TrialBalancePage's `?type=`) — and as
 * a plain card otherwise.
 *
 * Value and currency stay in separate text nodes: `formatCents` never gets a
 * currency symbol appended, matching the rule money.ts documents.
 */

export interface MetricTileProps {
  label: string;
  /** `null` renders the em-dash placeholder instead of an amount. */
  valueCents: number | null;
  /** Base currency code, e.g. "USD". Rendered as its own muted <span>. */
  currency: string;
  icon: LucideIcon;
  tone: 'neutral' | 'good' | 'bad';
  /** Absolute path. `null` renders a non-interactive <div> instead of a <Link>. */
  to: string | null;
  /** Small caption under the value. `null` renders nothing. */
  hint: string | null;
}

const TONE_ICON: Record<MetricTileProps['tone'], string> = {
  neutral: 'text-[var(--muted)]',
  good: 'text-[var(--good)]',
  bad: 'text-[var(--bad)]',
};

export default function MetricTile({ label, valueCents, currency, icon: Icon, tone, to, hint }: MetricTileProps) {
  const content = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">{label}</p>
        <Icon size={16} aria-hidden="true" className={TONE_ICON[tone]} />
      </div>
      {valueCents === null ? (
        <p className="text-2xl font-semibold m-0 mt-2">—</p>
      ) : (
        <p className="text-2xl font-semibold m-0 mt-2 tabular-nums">
          <span>{formatCents(valueCents)}</span>{' '}
          <span className="text-xs font-normal text-[var(--muted)]">{currency}</span>
        </p>
      )}
      {hint !== null && <p className="text-xs text-[var(--muted)] m-0 mt-1.5">{hint}</p>}
    </>
  );

  if (to !== null) {
    return (
      <Link
        to={to}
        className="card no-underline text-inherit block transition-colors hover:border-[var(--good)] focus-visible:border-[var(--good)]"
      >
        {content}
      </Link>
    );
  }

  return <div className="card">{content}</div>;
}
