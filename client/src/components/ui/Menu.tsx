import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../../utils/cx';

export interface MenuItem {
  type?: 'item' | 'separator';
  label?: string;
  icon?: LucideIcon;
  /** Renders as a <Link> when given, a <button> otherwise. */
  to?: string;
  onSelect?: () => void;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuRenderProps {
  open: boolean;
  buttonProps: {
    ref: RefObject<HTMLButtonElement | null>;
    onClick: () => void;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
  };
}

export interface MenuProps {
  trigger: (props: MenuRenderProps) => ReactNode;
  items: MenuItem[];
  align?: 'left' | 'right';
  /** Accessible name for the menu panel itself (role="menu"). */
  panelLabel: string;
  panelClassName?: string;
}

/**
 * An accessible menu button following the WAI-ARIA APG "Menu Button" pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/), used everywhere a
 * dropdown is needed: the app switcher, the theme toggle, the user menu, and
 * (from Phase 31 on) CreateMenu. Replaces four near-duplicate outside-click
 * effects with one.
 *
 * Behaviour: opening moves focus to the first item; ArrowUp/ArrowDown/Home/End
 * move within the menu; Escape and an outside click/Tab close it and return
 * focus to the trigger; selecting an item both runs its action and closes.
 */
export default function Menu({ trigger, items, align = 'left', panelLabel, panelClassName }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);

  const selectableIndexes = items
    .map((item, index) => (item.type === 'separator' || item.disabled ? -1 : index))
    .filter((index) => index >= 0);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function toggle() {
    setOpen((wasOpen) => !wasOpen);
  }

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectableIndexes[0] ?? 0);

    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        close(false);
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  function moveTo(direction: 1 | -1) {
    const position = selectableIndexes.indexOf(activeIndex);
    const nextPosition = (position + direction + selectableIndexes.length) % selectableIndexes.length;
    setActiveIndex(selectableIndexes[nextPosition] ?? 0);
  }

  function handlePanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveTo(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveTo(-1);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(selectableIndexes[0] ?? 0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(selectableIndexes[selectableIndexes.length - 1] ?? 0);
        break;
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        // Let focus leave naturally; just stop treating this as an open menu.
        close(false);
        break;
      default:
        break;
    }
  }

  return (
    <div ref={containerRef} className="relative inline-block">
      {trigger({
        open,
        buttonProps: {
          ref: triggerRef,
          onClick: toggle,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
        },
      })}
      {open && (
        <div
          role="menu"
          aria-label={panelLabel}
          onKeyDown={handlePanelKeyDown}
          className={cx(
            'animate-pop-in absolute z-30 mt-1.5 min-w-[12rem] rounded-lg border border-[var(--border)] bg-[var(--panel)] p-1 shadow-[var(--shadow-lg)]',
            align === 'right' ? 'right-0' : 'left-0',
            panelClassName,
          )}
        >
          {items.map((item, index) => {
            if (item.type === 'separator') {
              return <div key={`sep-${index}`} role="separator" className="my-1 h-px bg-[var(--border)]" />;
            }
            const Icon = item.icon;
            const content = (
              <>
                {Icon && <Icon size={15} aria-hidden="true" className="shrink-0 text-[var(--muted)]" />}
                <span className="flex-1 truncate text-left">{item.label}</span>
                {item.shortcut && <span className="text-xs text-[var(--muted)]">{item.shortcut}</span>}
              </>
            );
            const itemClassName = cx(
              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors',
              item.disabled
                ? 'cursor-not-allowed opacity-50'
                : item.danger
                  ? 'text-[var(--bad)] hover:bg-[var(--bad-soft)]'
                  : 'text-[var(--text)] hover:bg-[var(--panel-2)]',
            );
            // `key` is passed directly on each element below, not through this
            // spread — React 19 warns ("a props object containing a key prop
            // is being spread into JSX") if key rides inside `{...commonProps}`,
            // because key has to be read before props are even assembled.
            const commonProps = {
              role: 'menuitem' as const,
              ref: (node: HTMLElement | null) => {
                itemRefs.current[index] = node;
              },
              tabIndex: -1,
              className: itemClassName,
              'aria-disabled': item.disabled || undefined,
            };
            if (item.to !== undefined && !item.disabled) {
              return (
                <Link
                  key={item.label}
                  {...commonProps}
                  to={item.to}
                  onClick={() => {
                    item.onSelect?.();
                    close(false);
                  }}
                >
                  {content}
                </Link>
              );
            }
            return (
              <button
                key={item.label}
                {...commonProps}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  item.onSelect?.();
                  close(true);
                }}
              >
                {content}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
