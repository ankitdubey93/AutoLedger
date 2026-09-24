import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { NavLink } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../../utils/cx';

export interface TabBarItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Required for variant="links"; ignored for variant="buttons". */
  to?: string;
  /** NavLink `end` — only used for variant="links". */
  end?: boolean;
}

interface TabBarPropsCommon {
  ariaLabel: string;
  items: readonly TabBarItem[];
  className?: string;
  /** Stack full-width instead of the default inline strip (AccountTabs' layout). */
  fullWidth?: boolean;
}

interface LinksVariant extends TabBarPropsCommon {
  variant: 'links';
}

interface ButtonsVariant extends TabBarPropsCommon {
  variant: 'buttons';
  active: string;
  onChange: (id: string) => void;
}

export type TabBarProps = LinksVariant | ButtonsVariant;

const itemClass = (isActive: boolean, fullWidth?: boolean) =>
  cx(
    'relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm no-underline transition-colors',
    fullWidth && 'flex-1 justify-center',
    isActive ? 'bg-[var(--panel-2)] text-[var(--text)] font-medium' : 'text-[var(--muted)] hover:text-[var(--text)]',
  );

/**
 * Shared tab-strip styling for SettingsTabs (route links), AccountTabs and
 * StockCatalogueSettingsPage's inline tablist (both button-driven, ARIA
 * "Tabs" pattern). A thin accent indicator slides under the active tab,
 * measured against the strip's own DOM rather than hard-coded per item.
 */
export default function TabBar(props: TabBarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  const activeId = props.variant === 'buttons' ? props.active : undefined;

  useLayoutEffect(() => {
    // Only the buttons variant tracks an explicit `active` id — the links
    // variant's "active" comes from react-router's own URL match, which this
    // component does not have a synchronous read of, so it relies on the
    // background highlight in itemClass() instead of a sliding indicator.
    if (props.variant !== 'buttons') {
      setIndicator(null);
      return;
    }
    const container = containerRef.current;
    if (container === null) return;
    const activeEl = container.querySelector<HTMLElement>('[data-tab-active="true"]');
    if (activeEl === null) {
      setIndicator(null);
      return;
    }
    setIndicator({ left: activeEl.offsetLeft, width: activeEl.offsetWidth });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.variant, activeId, props.items.length]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (props.variant !== 'buttons') return;
    const ids = props.items.map((item) => item.id);
    const index = ids.indexOf(props.active);
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const next = ids[(index + delta + ids.length) % ids.length];
      if (next !== undefined) props.onChange(next);
    } else if (event.key === 'Home') {
      event.preventDefault();
      if (ids[0] !== undefined) props.onChange(ids[0]);
    } else if (event.key === 'End') {
      event.preventDefault();
      const last = ids[ids.length - 1];
      if (last !== undefined) props.onChange(last);
    }
  }

  return (
    <div
      ref={containerRef}
      role={props.variant === 'buttons' ? 'tablist' : undefined}
      aria-label={props.ariaLabel}
      onKeyDown={handleKeyDown}
      className={cx('relative flex gap-1 border-b border-[var(--border)] pb-2', props.className)}
    >
      {props.items.map((item) => {
        const Icon = item.icon;
        if (props.variant === 'links') {
          return (
            <NavLink
              key={item.id}
              to={item.to ?? '#'}
              end={item.end ?? false}
              className={({ isActive }) => itemClass(isActive, props.fullWidth)}
            >
              {Icon && <Icon size={14} aria-hidden="true" />}
              {item.label}
            </NavLink>
          );
        }
        const isActive = item.id === props.active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            data-tab-active={isActive ? 'true' : undefined}
            onClick={() => props.onChange(item.id)}
            className={itemClass(isActive, props.fullWidth)}
          >
            {Icon && <Icon size={14} aria-hidden="true" />}
            {item.label}
          </button>
        );
      })}
      {indicator !== null && (
        <span
          aria-hidden="true"
          className="absolute bottom-[-1px] h-0.5 rounded-full bg-[var(--accent)] transition-[left,width] duration-200"
          style={{ left: indicator.left, width: indicator.width, transitionTimingFunction: 'var(--ease)' }}
        />
      )}
    </div>
  );
}
