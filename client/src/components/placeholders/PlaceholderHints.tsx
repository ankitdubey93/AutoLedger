import {
  containsPlaceholders,
  fillPlaceholders,
  nearMisses,
  type PlaceholderContext,
  type PlaceholderSurface,
} from '../../utils/placeholders';

interface PlaceholderHintsProps {
  /** The text being edited — one field, or several (notes + every line). */
  text: string | readonly string[];
  surface: PlaceholderSurface;
  /** When given, a "Preview:" line shows the first field with placeholders filled. */
  preview?: PlaceholderContext;
}

/**
 * Phase 40 — what a field's placeholders will become, and non-blocking hints
 * for bracket text that looks like a mistyped placeholder. Never blocks a
 * save: unknown bracket text is ordinary prose ("[draft]") and stays as typed.
 */
export default function PlaceholderHints({ text, surface, preview }: PlaceholderHintsProps) {
  const texts = typeof text === 'string' ? [text] : text;
  const hints = [...new Set(texts.flatMap((t) => nearMisses(t, surface)))];
  const first = texts.find((t) => containsPlaceholders(t, surface));
  // A date input mid-edit (or cleared) has no date to fill from yet.
  const context = preview !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(preview.date) ? preview : undefined;
  if (hints.length === 0 && (context === undefined || first === undefined)) return null;

  return (
    <div className="flex flex-col gap-0.5 text-xs" aria-live="polite">
      {context !== undefined && first !== undefined && (
        <p className="m-0 text-[var(--muted)]" data-testid="placeholder-preview">
          Preview: <span className="text-[var(--text)]">{fillPlaceholders(first, surface, context, 'partial')}</span>
        </p>
      )}
      {hints.map((hint) => (
        <p key={hint} className="m-0 text-[var(--warn)]">
          {hint}
        </p>
      ))}
    </div>
  );
}
