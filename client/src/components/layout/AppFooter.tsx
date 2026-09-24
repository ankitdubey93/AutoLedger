import { Link } from 'react-router-dom';
import type { AppSummary } from '../../services/fetchServices';

/**
 * A slim footer for the workspace shell — there was none before Phase 31.
 * `app` is null on the platform pages (chooser, account, documents,
 * integrations), which PlatformLayout renders with the same footer.
 */
export default function AppFooter({ app }: { app: AppSummary | null }) {
  const year = new Date().getFullYear();
  return (
    <footer className="no-print mt-auto border-t border-[var(--border)] px-4 md:px-6 py-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted)]">
      <span>
        © {year} AutoLedger{app !== null && <> · {app.name} — {app.domain}</>}
      </span>
      <div className="flex items-center gap-3">
        <span className="hidden sm:inline">
          <kbd className="border border-[var(--border)] rounded px-1 py-0.5">⌘K</kbd> search ·{' '}
          <kbd className="border border-[var(--border)] rounded px-1 py-0.5">⌘B</kbd> sidebar
        </span>
        <Link to="/documents" className="text-[var(--muted)] hover:text-[var(--text)] transition-colors">
          Documents
        </Link>
        <Link to="/integrations" className="text-[var(--muted)] hover:text-[var(--text)] transition-colors">
          Integrations
        </Link>
        {app !== null && <span className="chip chip--muted">{app.status}</span>}
      </div>
    </footer>
  );
}
