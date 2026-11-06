import { Layers } from 'lucide-react';

/**
 * The product's mark: the Layers glyph on a slowly morphing blob, optionally
 * followed by the wordmark. One component so the top bar, the sign-in pages and
 * `public/favicon.svg` (the same glyph, drawn by hand) never drift apart.
 * `inverse` is for the magenta hero, where the accent blob would disappear.
 */
export default function BrandMark({
  size = 'sm',
  showName = true,
  nameClassName = '',
  inverse = false,
}: {
  size?: 'sm' | 'lg';
  showName?: boolean;
  nameClassName?: string;
  inverse?: boolean;
}) {
  const box = size === 'lg' ? 'size-10' : 'size-8';
  const glyph = size === 'lg' ? 22 : 17;
  return (
    <span className="flex items-center gap-2.5">
      <span className={`flex ${box} items-center justify-center shrink-0 brand-blob ${inverse ? 'brand-blob--inverse' : ''}`}>
        <Layers size={glyph} aria-hidden="true" />
      </span>
      {showName && (
        <span className={`font-bold tracking-tight [font-family:var(--font-display)] ${size === 'lg' ? 'text-xl' : 'text-lg'} ${nameClassName}`}>AutoLedger</span>
      )}
    </span>
  );
}
