import { SkeletonRows } from './Skeleton';

/**
 * What a page shows while its data loads: skeleton rows in the shape of the
 * list to come, not a bare "Loading…" line. The text is still there,
 * visually hidden, inside `role="status"`, so a screen reader announces it
 * and a test can find it.
 */
export default function LoadingState({ rows = 4, label = 'Loading…' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-busy="true" className="py-1">
      <SkeletonRows count={rows} />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}
