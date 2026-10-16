import { Braces } from 'lucide-react';
import Menu, { type MenuItem } from '../ui/Menu';
import {
  fillPlaceholders,
  placeholdersFor,
  type PlaceholderContext,
  type PlaceholderSurface,
} from '../../utils/placeholders';

interface PlaceholderPickerProps {
  surface: PlaceholderSurface;
  onInsert: (token: string) => void;
  disabled?: boolean;
  /** Phase 46b — when given (with a real date), each entry shows what it becomes. */
  preview?: PlaceholderContext;
}

const DATE_PRESETS: { label: string; token: string }[] = [
  { label: 'Next month', token: '[Month+1]' },
  { label: 'Last month', token: '[Month-1]' },
  { label: 'Next year', token: '[Year+1]' },
];

/**
 * Phase 40 — the "Insert placeholder" dropdown: every placeholder this
 * surface offers, from the shared registry, then the common date offsets.
 * Pair it with `usePlaceholderTarget`, whose `insert` is `onInsert`.
 */
export default function PlaceholderPicker({ surface, onInsert, disabled = false, preview }: PlaceholderPickerProps) {
  // A date input mid-edit (or cleared) has no date to fill from yet.
  const context = preview !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(preview.date) ? preview : undefined;
  const shortcutFor = (token: string): string =>
    context === undefined ? token : `${token} → ${fillPlaceholders(token, surface, context, 'partial')}`;

  const items: MenuItem[] = [
    ...placeholdersFor(surface).map((def) => ({
      label: def.label,
      shortcut: shortcutFor(`[${def.label}]`),
      onSelect: () => onInsert(`[${def.label}]`),
    })),
    { type: 'separator' as const },
    ...DATE_PRESETS.map((preset) => ({
      label: preset.label,
      shortcut: shortcutFor(preset.token),
      onSelect: () => onInsert(preset.token),
    })),
  ];

  return (
    <Menu
      panelLabel="Placeholders"
      panelClassName="min-w-[16rem] max-h-80 overflow-y-auto"
      items={items}
      trigger={({ buttonProps }) => (
        <button
          {...buttonProps}
          type="button"
          disabled={disabled}
          title="Placeholders are filled in when the document is issued. Add an offset to a date: [Month+1], [Year-1]. Write [[Month]] for a literal [Month]."
          className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--muted)] cursor-pointer hover:text-[var(--text)] hover:bg-[var(--panel-2)] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Braces size={13} aria-hidden="true" /> Insert placeholder
        </button>
      )}
    />
  );
}
