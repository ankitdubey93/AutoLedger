/**
 * Small helpers over the `.skeleton` class in index.css: a shape that holds
 * the eventual layout while data loads. Pages use them through `LoadingState`,
 * which adds the announced "Loading…" text these deliberately hide.
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
