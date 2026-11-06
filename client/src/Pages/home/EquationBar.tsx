import { formatCents } from '../../utils/money';

/**
 * A two-track stacked bar showing Assets against Liabilities + Equity +
 * current earnings, scaled to a shared denominator so the two sides are
 * visually comparable. Plain divs, no SVG, no charting library (rule 14).
 *
 * Deliberately renders no `role="status"` — the dashboard's integrity
 * banner is the page's only status region; this is a supporting visual for
 * the `equationHolds` warning already shown above it, not a second alert.
 */

const ASSETS_COLOR = 'var(--accent)';
const LIABILITIES_COLOR = 'var(--coral)';
const EQUITY_COLOR = 'var(--violet)';
const EARNINGS_COLOR = 'var(--good-bright)';

export default function EquationBar({
  assetsCents,
  liabilitiesCents,
  equityCents,
  currentEarningsCents,
  currency,
  holds,
}: {
  assetsCents: number;
  liabilitiesCents: number;
  equityCents: number;
  currentEarningsCents: number;
  currency: string;
  holds: boolean;
}) {
  const rightTotal = liabilitiesCents + equityCents + currentEarningsCents;
  const scale = Math.max(1, Math.abs(assetsCents), Math.abs(rightTotal));

  const rightSegments = [
    { label: 'Liabilities', valueCents: liabilitiesCents, color: LIABILITIES_COLOR },
    { label: 'Equity', valueCents: equityCents, color: EQUITY_COLOR },
    { label: 'Earnings', valueCents: currentEarningsCents, color: EARNINGS_COLOR },
  ];

  const body = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-[var(--muted)] m-0">Assets</p>
        <div className="flow-bar">
          <span
            className="flow-bar__segment"
            title={`Assets: ${formatCents(assetsCents)} ${currency}`}
            style={{ width: `${String((Math.abs(assetsCents) / scale) * 100)}%`, background: ASSETS_COLOR }}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm text-[var(--muted)] m-0">Liabilities + Equity + Earnings</p>
        <div className="flow-bar">
          {rightSegments.map((s) => (
            <span
              key={s.label}
              className="flow-bar__segment"
              title={`${s.label}: ${formatCents(s.valueCents)} ${currency}`}
              style={{ width: `${String((Math.abs(s.valueCents) / scale) * 100)}%`, background: s.color }}
            />
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm text-[var(--muted)]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: ASSETS_COLOR }} />
          Assets
        </span>
        {rightSegments.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );

  if (!holds) {
    return <div className="ring-1 ring-inset ring-rose-500/40 rounded-lg p-3">{body}</div>;
  }

  return body;
}
