import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/**
 * A consistent "go back" affordance on every drill-down page (a journal
 * entry, an account ledger, the new-entry form).
 *
 * `to` is always a caller-built absolute path, never `navigate(-1)` — browser
 * history is not this app's information architecture, and a deep link opened
 * cold must still land somewhere sensible.
 */
export default function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] no-underline w-fit"
    >
      <ArrowLeft size={15} aria-hidden="true" />
      {label}
    </Link>
  );
}
