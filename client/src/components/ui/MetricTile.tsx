import type { LucideIcon } from 'lucide-react';
import { formatCents } from '../../utils/money';
import StatTile from './StatTile';

/**
 * A dashboard position tile. Renders as a link when `to` is given — the
 * dashboard's Assets/Liabilities/Equity/Cash tiles drill into the trial
 * balance filtered by account type (see TrialBalancePage's `?type=`) — and as
 * a plain card otherwise.
 *
 * Value and currency stay in separate text nodes: `formatCents` never gets a
 * currency symbol appended, matching the rule money.ts documents.
 *
 * Phase 31: a thin wrapper over the shared `StatTile` (its money formatting
 * and Link-vs-div behaviour are the only things specific to Accounting).
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

export default function MetricTile({ label, valueCents, currency, icon, tone, to, hint }: MetricTileProps) {
  const value =
    valueCents === null ? (
      '—'
    ) : (
      <>
        <span>{formatCents(valueCents)}</span> <span className="text-xs font-normal text-[var(--muted)]">{currency}</span>
      </>
    );

  return (
    <StatTile
      label={label}
      icon={icon}
      tone={tone}
      value={value}
      {...(hint !== null ? { hint } : {})}
      {...(to !== null ? { to } : {})}
    />
  );
}
