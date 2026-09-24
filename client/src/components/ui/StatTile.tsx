import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../../utils/cx';

export interface StatTileProps {
  label: string;
  icon: LucideIcon;
  tone?: 'neutral' | 'good' | 'bad';
  value: ReactNode;
  hint?: ReactNode;
  /** Absolute path. Omit for a non-interactive tile. */
  to?: string;
}

const TONE_CLASS: Record<NonNullable<StatTileProps['tone']>, string> = {
  neutral: 'text-[var(--muted)] bg-[var(--panel-2)]',
  good: 'text-[var(--good)] bg-[var(--good-soft)]',
  bad: 'text-[var(--bad)] bg-[var(--bad-soft)]',
};

/**
 * A generic dashboard tile: a tone-tinted icon chip, a label, a value and an
 * optional hint. `MetricTile` (LedgerCore's money-formatting tile) and
 * StockLedger's dashboard tiles both wrap this rather than each styling
 * their own card.
 */
export default function StatTile({ label, icon: Icon, tone = 'neutral', value, hint, to }: StatTileProps) {
  const content = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">{label}</p>
        <span aria-hidden="true" className={cx('flex size-7 items-center justify-center rounded-md', TONE_CLASS[tone])}>
          <Icon size={15} />
        </span>
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {hint !== undefined && <p className="text-xs text-[var(--muted)] m-0 mt-1.5">{hint}</p>}
    </>
  );

  if (to !== undefined) {
    return (
      <Link to={to} className="card card--interactive no-underline text-inherit block">
        {content}
      </Link>
    );
  }

  return <div className="card">{content}</div>;
}
