import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, UserCog } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useShell } from './ShellContext';
import { NAV_GROUPS } from './nav';
import { cx } from '../../utils/cx';

interface Command {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  to: string;
}

/**
 * Every sidebar entry, labelled with its sidebar group, plus the pages that
 * live outside the sidebar. Built once at module load: the nav is static data.
 */
const COMMANDS: Command[] = [
  ...NAV_GROUPS.flatMap((group) =>
    group.items.map((item) => ({
      id: item.to,
      label: item.label,
      group: group.heading,
      icon: item.icon,
      to: item.to,
    })),
  ),
  { id: '/account', label: 'Account', group: 'Workspace', icon: UserCog, to: '/account' },
];

/** Simple case-insensitive substring match — no dependency, rule 14. */
function matches(query: string, label: string): boolean {
  return label.toLowerCase().includes(query.trim().toLowerCase());
}

/**
 * ⌘K / Ctrl+K navigation, opened from ShellContext (the top bar's search
 * trigger sets the same state). Navigation only: it makes no server call and
 * searches the same `NAV_GROUPS` the sidebar renders.
 */
export default function CommandPalette() {
  const { paletteOpen, closePalette } = useShell();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = query.trim() === '' ? COMMANDS : COMMANDS.filter((c) => matches(query, c.label) || matches(query, c.group));

  useEffect(() => {
    if (paletteOpen) {
      setQuery('');
      setActiveIndex(0);
      // A passive effect runs after the DOM has committed, so the input
      // already exists — no need to defer to a rAF/timeout to focus it.
      inputRef.current?.focus();
    }
  }, [paletteOpen]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!paletteOpen) return null;

  function go(command: Command) {
    closePalette();
    navigate(command.to);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4">
      <button
        type="button"
        aria-label="Close"
        onClick={closePalette}
        className="animate-fade-in absolute inset-0 bg-black/50 border-0 p-0 cursor-pointer"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="animate-pop-in relative w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow-lg)] overflow-hidden"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closePalette();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const command = filtered[activeIndex];
            if (command !== undefined) go(command);
          }
        }}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border)]">
          <Search size={16} aria-hidden="true" className="text-[var(--muted)] shrink-0" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-label="Search or jump to…"
            placeholder="Search or jump to…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="flex-1 bg-transparent border-0 outline-none text-sm text-[var(--text)] placeholder:text-[var(--muted)]"
          />
          <kbd className="text-[10px] text-[var(--muted)] border border-[var(--border)] rounded px-1.5 py-0.5">
            Esc
          </kbd>
        </div>
        <div ref={listRef} id="command-palette-list" role="listbox" className="max-h-80 overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="muted text-center py-6">No matches.</p>
          ) : (
            filtered.map((command, index) => {
              const Icon = command.icon;
              const active = index === activeIndex;
              return (
                <button
                  key={command.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-active={active ? 'true' : undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => go(command)}
                  className={cx(
                    'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-left transition-colors',
                    active ? 'bg-[var(--accent-soft)] text-[var(--text)]' : 'text-[var(--text)]',
                  )}
                >
                  <Icon size={15} aria-hidden="true" className="shrink-0 text-[var(--muted)]" />
                  <span className="flex-1 truncate">{command.label}</span>
                  <span className="text-xs text-[var(--muted)]">{command.group}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
