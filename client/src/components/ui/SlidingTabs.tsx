import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Measures the active item inside a `.tab-track` so one pill can slide between
 * items of different widths. Watching the DOM rather than taking an active id
 * lets the same hook serve route tabs, where NavLink owns `aria-current` and the
 * parent may not re-render. The ResizeObserver catches the web font arriving,
 * which changes every width after the first measurement. jsdom has no
 * ResizeObserver, and reports every offset as 0.
 */
export function useSlidingThumb(trackRef: RefObject<HTMLElement | null>): { left: number; width: number } | null {
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (track === null) return;

    function measure() {
      const active = track?.querySelector<HTMLElement>('[aria-current="page"], [aria-selected="true"]') ?? null;
      setThumb((previous) => {
        if (active === null) return null;
        const next = { left: active.offsetLeft, width: active.offsetWidth };
        return previous?.left === next.left && previous.width === next.width ? previous : next;
      });
    }

    measure();
    const mutations = new MutationObserver(measure);
    mutations.observe(track, { subtree: true, attributes: true, attributeFilter: ['aria-current', 'aria-selected'] });
    const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    resizes?.observe(track);
    return () => {
      mutations.disconnect();
      resizes?.disconnect();
    };
  }, [trackRef]);

  return thumb;
}

export function TabThumb({ thumb }: { thumb: { left: number; width: number } | null }) {
  if (thumb === null) return null;
  return <span aria-hidden="true" className="tab-track__thumb" style={{ width: thumb.width, transform: `translateX(${String(thumb.left)}px)` }} />;
}

/** A list page's status filter: a row of buttons with one pill sliding behind them. */
export default function SlidingTabs<T extends { key: string; label: string }>({
  ariaLabel,
  tabs,
  isActive,
  onSelect,
}: {
  ariaLabel: string;
  tabs: readonly T[];
  isActive: (tab: T) => boolean;
  onSelect: (tab: T) => void;
}) {
  const trackRef = useRef<HTMLElement>(null);
  const thumb = useSlidingThumb(trackRef);

  return (
    <nav ref={trackRef} aria-label={ariaLabel} className="tab-track">
      <TabThumb thumb={thumb} />
      {tabs.map((tab) => (
        <button key={tab.key} type="button" onClick={() => onSelect(tab)} aria-current={isActive(tab) ? 'page' : undefined} className="tab-track__item">
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
