import { useRef, type KeyboardEvent } from 'react';
import { NavLink } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../../utils/cx';
import { TabThumb, useSlidingThumb } from './SlidingTabs';

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

const itemClass = (fullWidth?: boolean) => cx('tab-track__item', fullWidth && 'flex-1');

/**
 * Shared tab-strip styling for SettingsTabs (route links), AccountTabs and
 * InventoryCatalogueSettingsPage's inline tablist (both button-driven, ARIA
 * "Tabs" pattern). One pill slides behind the active tab, measured from the DOM
 * rather than hard-coded per item.
 */
export default function TabBar(props: TabBarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const thumb = useSlidingThumb(containerRef);

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
      className={cx('tab-track', props.fullWidth && 'w-full', props.className)}
    >
      <TabThumb thumb={thumb} />
      {props.items.map((item) => {
        const Icon = item.icon;
        if (props.variant === 'links') {
          return (
            <NavLink
              key={item.id}
              to={item.to ?? '#'}
              end={item.end ?? false}
              className={itemClass(props.fullWidth)}
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
            onClick={() => props.onChange(item.id)}
            className={itemClass(props.fullWidth)}
          >
            {Icon && <Icon size={14} aria-hidden="true" />}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
