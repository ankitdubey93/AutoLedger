/**
 * A confidence score badge, banded to mirror the server's
 * `server/src/utils/matchScore.ts` thresholds — `AUTO_MATCH_THRESHOLD = 85`
 * is the source of truth; this constant is kept in sync with it by hand,
 * the same way every client-side mirror of a server enum in this codebase is.
 */

const AUTO_MATCH_THRESHOLD = 85;
const MID_CONFIDENCE_THRESHOLD = 65;

export default function MatchScoreBadge({ score }: { score: number }) {
  const band =
    score >= AUTO_MATCH_THRESHOLD ? 'auto' : score >= MID_CONFIDENCE_THRESHOLD ? 'mid' : 'low';

  const classesByBand: Record<typeof band, string> = {
    auto: 'bg-[var(--good)]/10 text-[var(--good)] ring-1 ring-inset ring-[var(--good)]/30',
    mid: 'bg-amber-500/10 text-amber-500 ring-1 ring-inset ring-amber-500/30',
    low: 'bg-[var(--muted)]/10 text-[var(--muted)] ring-1 ring-inset ring-[var(--muted)]/30',
  };

  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full tabular-nums ${classesByBand[band]}`}
    >
      {score}
      {band === 'auto' && <span className="uppercase tracking-wide">· auto</span>}
    </span>
  );
}
