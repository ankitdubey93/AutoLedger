import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../../utils/cx';

export interface StatTileProps {
  label: string;
  icon: LucideIcon;
  tone?: 'neutral' | 'good' | 'bad' | 'accent' | 'coral' | 'violet';
  value: ReactNode;
  hint?: ReactNode;
  /** Absolute path. Omit for a non-interactive tile. */
  to?: string;
}

const TONE_CLASS: Record<NonNullable<StatTileProps['tone']>, string> = {
  neutral: 'tone-plain',
  good: 'tone-good',
  bad: 'tone-bad',
  accent: 'tone-accent',
  coral: 'tone-coral',
  violet: 'tone-violet',
};

/**
 * A generic dashboard tile: a tone-tinted icon chip, a label, a value and an
 * optional hint. `MetricTile` (Accounting's money-formatting tile) and
 * Inventory's dashboard tiles both wrap this rather than each styling
 * their own card.
 */
export default function StatTile({ label, icon: Icon, tone = 'neutral', value, hint, to }: StatTileProps) {
  const content = (
    <>
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className={cx('nav-icon', TONE_CLASS[tone])}>
          <Icon size={16} />
        </span>
        <p className="text-sm font-medium text-[var(--muted)] m-0">{label}</p>
      </div>
      <div className="display-figure mt-4 text-[1.75rem]">{value}</div>
      {hint !== undefined && <p className="text-sm text-[var(--muted)] m-0 mt-2">{hint}</p>}
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
