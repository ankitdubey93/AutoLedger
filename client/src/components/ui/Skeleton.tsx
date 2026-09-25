/**
 * Small helpers over the `.skeleton` class in index.css, for pages that
 * currently show a bare "Loading…" string (InventoryOverview,
 * InventoryCatalogueSettingsPage, and others) rather than a shape that holds the
 * eventual layout.
 */
export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton skeleton--row" style={{ width: `${85 - index * 6}%` }} />
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div className="grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton skeleton--card" />
      ))}
    </div>
  );
}
