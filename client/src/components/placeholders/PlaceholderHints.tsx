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
  /** When given, a "Preview:" line per field with placeholders shows it filled. */
  preview?: PlaceholderContext;
  /** Parallel to `text`: the name each field's preview is prefixed with. */
  labels?: readonly string[];
}

const MAX_PREVIEWS = 5;

/**
 * Phase 40 — what a field's placeholders will become, and non-blocking hints
 * for bracket text that looks like a mistyped placeholder. Never blocks a
 * save: unknown bracket text is ordinary prose ("[draft]") and stays as typed.
 * Phase 46b — every field with placeholders gets its own preview line.
 */
export default function PlaceholderHints({ text, surface, preview, labels }: PlaceholderHintsProps) {
  const texts = typeof text === 'string' ? [text] : text;
  const hints = [...new Set(texts.flatMap((t) => nearMisses(t, surface)))];
  // A date input mid-edit (or cleared) has no date to fill from yet.
  const context = preview !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(preview.date) ? preview : undefined;
  const filled = texts
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => containsPlaceholders(t, surface));
  if (hints.length === 0 && (context === undefined || filled.length === 0)) return null;

  const shown = context === undefined ? [] : filled.slice(0, MAX_PREVIEWS);
  const hiddenCount = context === undefined ? 0 : filled.length - shown.length;

  return (
    <div className="flex flex-col gap-0.5 text-xs" aria-live="polite">
      {context !== undefined &&
        shown.map(({ t, i }) => (
          <p key={i} className="m-0 text-[var(--muted)]" data-testid="placeholder-preview">
            {filled.length > 1 ? `${labels?.[i] ?? 'Preview'}: ` : 'Preview: '}
            <span className="text-[var(--text)]">{fillPlaceholders(t, surface, context, 'partial')}</span>
          </p>
        ))}
      {hiddenCount > 0 && <p className="m-0 text-[var(--muted)]">…and {hiddenCount} more</p>}
      {hints.map((hint) => (
        <p key={hint} className="m-0 text-[var(--warn)]">
          {hint}
        </p>
      ))}
    </div>
  );
}
