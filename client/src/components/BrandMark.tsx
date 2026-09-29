import { Layers } from 'lucide-react';

/**
 * The product's mark: the Layers glyph on the accent gradient, optionally
 * followed by the wordmark. One component so the top bar, the sign-in pages
 * and `public/favicon.svg` (the same glyph, drawn by hand) never drift apart.
 */
export default function BrandMark({ size = 'sm', showName = true, nameClassName = '' }: { size?: 'sm' | 'lg'; showName?: boolean; nameClassName?: string }) {
  const box = size === 'lg' ? 'size-9 rounded-lg' : 'size-6 rounded-md';
  const glyph = size === 'lg' ? 20 : 13;
  return (
    <span className="flex items-center gap-2">
      <span className={`flex ${box} items-center justify-center bg-gradient-to-br from-[var(--accent)] to-[var(--accent-hover)] text-white shrink-0`}>
        <Layers size={glyph} aria-hidden="true" />
      </span>
      {showName && (
        <span className={`font-semibold tracking-wide ${size === 'lg' ? 'text-lg' : 'text-sm'} ${nameClassName}`}>AutoLedger</span>
      )}
    </span>
  );
}
