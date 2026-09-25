import { Link } from 'react-router-dom';

/** A slim footer under every signed-in page. */
export default function AppFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="no-print mt-auto border-t border-[var(--border)] px-4 md:px-6 py-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted)]">
      <span>© {year} AutoLedger</span>
      <div className="flex items-center gap-3">
        <span className="hidden sm:inline">
          <kbd className="border border-[var(--border)] rounded px-1 py-0.5">⌘K</kbd> search ·{' '}
          <kbd className="border border-[var(--border)] rounded px-1 py-0.5">⌘B</kbd> sidebar
        </span>
        <Link to="/documents" className="text-[var(--muted)] hover:text-[var(--text)] transition-colors">
          Documents
        </Link>
        <Link to="/settings" className="text-[var(--muted)] hover:text-[var(--text)] transition-colors">
          Settings
        </Link>
      </div>
    </footer>
  );
}
