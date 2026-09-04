import { formatCents } from './money';

/**
 * A small, generic bar chart — hand-rolled inline SVG, no library (rule 14).
 * Used by the dashboard's AR/AP aging panels; unrelated to `TrendChart`,
 * which is a line-over-time chart with its own hover state and should not be
 * generalised to cover this shape too.
 *
 * A zero-value bar still renders (at zero height) with its label, rather
 * than being omitted — the same "gap-filled, never a gap" rule
 * `dashboardService.loadTrend` applies server-side. The `<svg>` carries
 * `role="img"` and a `<title>`; the same figures are repeated in a
 * `visually-hidden` table so a screen-reader user loses nothing, matching
 * `TrendChart`'s accessibility pattern.
 */

export interface BarChartDatum {
  label: string;
  amountCents: number;
  emphasis?: boolean;
}

const VIEW_WIDTH = 320;
const VIEW_HEIGHT = 120;
const CHART_TOP = 8;
const CHART_BOTTOM = 92;
const CHART_HEIGHT = CHART_BOTTOM - CHART_TOP;

export default function BarChart({
  data,
  accessibleTitle,
}: {
  data: BarChartDatum[];
  accessibleTitle: string;
}) {
  const maxCents = Math.max(1, ...data.map((d) => d.amountCents));
  const groupWidth = VIEW_WIDTH / Math.max(data.length, 1);
  const barWidth = Math.max(4, groupWidth - 10);

  return (
    <div className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
        role="img"
        className="w-full h-28"
      >
        <title>{accessibleTitle}</title>
        {data.map((datum, index) => {
          const x = index * groupWidth;
          const height = (datum.amountCents / maxCents) * CHART_HEIGHT;
          return (
            <g key={datum.label}>
              <rect
                x={x + (groupWidth - barWidth) / 2}
                y={CHART_BOTTOM - height}
                width={barWidth}
                height={height}
                fill={datum.emphasis === true ? 'var(--bad)' : 'var(--good)'}
                rx={2}
              />
              <text
                x={x + groupWidth / 2}
                y={CHART_BOTTOM + 14}
                textAnchor="middle"
                fontSize={9}
                fill="var(--muted)"
              >
                {datum.label}
              </text>
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

      <table className="visually-hidden">
        <caption>{accessibleTitle}</caption>
        <thead>
          <tr>
            <th>Bucket</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {data.map((datum) => (
            <tr key={datum.label}>
              <td>{datum.label}</td>
              <td>{formatCents(datum.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
