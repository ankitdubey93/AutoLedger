import { formatCents } from '../../utils/money';

/**
 * A horizontal stacked proportion bar — plain divs, no SVG and no charting
 * library (rule 14), used to show revenue vs. expenses at a glance inside a
 * performance card.
 *
 * `aria-hidden="true"` on the bar is deliberate: every number it encodes is
 * already present in the `<dl>` beside it, so exposing the bar to a screen
 * reader would duplicate that content rather than add to it.
 */

export interface ProportionBarSegment {
  label: string;
  valueCents: number;
  /** A CSS colour, e.g. 'var(--good)'. */
  color: string;
}

export default function ProportionBar({
  segments,
  currency,
}: {
  segments: ProportionBarSegment[];
  currency: string;
}) {
  const total = segments.reduce((sum, s) => sum + Math.abs(s.valueCents), 0);

  return (
    <div className="flex flex-col gap-1.5">
      {total === 0 ? (
        <div className="h-2 rounded-full bg-[var(--border)]" />
      ) : (
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--border)]" aria-hidden="true">
          {segments.map((s) => (
            <div
              key={s.label}
              title={`${s.label}: ${formatCents(s.valueCents)} ${currency}`}
              style={{ width: `${String((Math.abs(s.valueCents) / total) * 100)}%`, background: s.color }}
            />
          ))}
        </div>
      )}
      <div className="flex items-center gap-4 text-xs text-[var(--muted)]">
        {segments.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
