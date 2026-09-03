import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * The single entry point for "start something new" across LedgerCore — an
 * invoice, a journal entry, a customer, an account — rather than a scattered
 * button per page.
 */
export default function CreateMenu() {
  const base = useAppBasePath();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const items = [
    { label: 'Invoice', to: `${base}/invoices/new` },
    { label: 'Journal entry', to: `${base}/journals/new` },
    { label: 'Customer', to: `${base}/customers?new=1` },
    { label: 'Account', to: `${base}/accounts?new=1` },
  ];

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)]"
      >
        <Plus size={15} aria-hidden="true" /> Create
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 right-0 mt-1 rounded-md border border-[var(--border)] bg-[var(--panel)] shadow-lg overflow-hidden z-20"
        >
          {items.map((item) => (
            <Link
              key={item.label}
              role="menuitem"
              to={item.to}
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-sm no-underline text-[var(--text)] hover:bg-[var(--bg)]"
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
