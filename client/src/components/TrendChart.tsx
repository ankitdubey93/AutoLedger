import { useState } from 'react';
import type { TrendPoint } from '../services/fetchServices';
import { formatCents } from '../utils/money';

/**
 * Revenue vs. expense over the trailing 6 months, as grouped bars.
 *
 * Hand-rolled inline SVG rather than a charting library — rule 14 forbids a
 * dependency before the phase that needs one, and six bar pairs need nothing
 * a library would add. The `<table className="visually-hidden">` beside it
 * carries the same numbers for screen readers, matching the pattern
 * `TrialBalancePage`'s `role="status"` banner uses for its own state.
 *
 * A transparent hit rect per month drives a hover readout below the chart.
 * The interaction is hover-only and adds nothing focusable — the `<svg>`
 * stays `aria-hidden` and the `visually-hidden` table already carries every
 * value, so a screen-reader user loses nothing.
 */

const VIEW_WIDTH = 320;
const VIEW_HEIGHT = 160;
const CHART_TOP = 8;
const CHART_BOTTOM = 132;
const CHART_HEIGHT = CHART_BOTTOM - CHART_TOP;

function monthLabel(month: string): string {
  const [, m] = month.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const index = Number(m) - 1;
  return names[index] ?? month;
}

export default function TrendChart({ points }: { points: TrendPoint[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const maxCents = Math.max(1, ...points.flatMap((p) => [p.revenueCents, p.expenseCents]));
  const groupWidth = VIEW_WIDTH / Math.max(points.length, 1);
  const barWidth = groupWidth / 2 - 4;
  const shown = points[hovered ?? points.length - 1];

  return (
    <div className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
        role="img"
        aria-hidden="true"
        className="w-full h-40"
      >
        <title>Revenue and expenses for the last 6 months</title>
        {points.map((point, index) => {
          const x = index * groupWidth;
          const revenueHeight = (point.revenueCents / maxCents) * CHART_HEIGHT;
          const expenseHeight = (point.expenseCents / maxCents) * CHART_HEIGHT;

          return (
            <g key={point.month}>
              <rect
                data-bar
                x={x + 2}
                y={CHART_BOTTOM - revenueHeight}
                width={barWidth}
                height={revenueHeight}
                fill="var(--good)"
                rx={2}
              />
              <rect
                data-bar
                x={x + 2 + barWidth + 4}
                y={CHART_BOTTOM - expenseHeight}
                width={barWidth}
                height={expenseHeight}
                fill="var(--bad)"
                rx={2}
              />
              <text
                x={x + groupWidth / 2}
                y={CHART_BOTTOM + 16}
                textAnchor="middle"
                fontSize={10}
                fill="var(--muted)"
              >
                {monthLabel(point.month)}
              </text>
              <rect
                data-hit
                x={x}
                y={CHART_TOP}
                width={groupWidth}
                height={CHART_HEIGHT}
                fill="transparent"
                onMouseEnter={() => {
                  setHovered(index);
                }}
                onMouseLeave={() => {
                  setHovered(null);
                }}
              />
            </g>
          );
        })}
        <line
          x1={0}
          y1={CHART_BOTTOM}
          x2={VIEW_WIDTH}
          y2={CHART_BOTTOM}
          stroke="var(--border)"
          strokeWidth={1}
        />
      </svg>

      {shown !== undefined && (
        <p className="text-xs text-[var(--muted)] m-0 tabular-nums">
          {monthLabel(shown.month)} · Revenue {formatCents(shown.revenueCents)} · Expenses{' '}
          {formatCents(shown.expenseCents)} · Net {formatCents(shown.revenueCents - shown.expenseCents)}
        </p>
      )}

      <div className="flex items-center gap-4 text-xs text-[var(--muted)]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--good)' }} />
          Revenue
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--bad)' }} />
          Expenses
        </span>
      </div>

      <table className="visually-hidden">
        <caption>Revenue and expenses for the last 6 months</caption>
        <thead>
          <tr>
            <th>Month</th>
            <th>Revenue</th>
            <th>Expenses</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.month}>
              <td>{point.month}</td>
              <td>{formatCents(point.revenueCents)}</td>
              <td>{formatCents(point.expenseCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
