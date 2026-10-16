import type { Bill, Invoice, JournalEntry, ManualJournal, RecurringSchedule } from '../../services/fetchServices';
import type { PlaceholderContext, PlaceholderSurface } from '../../utils/placeholders';

/**
 * Phase 46b — what a recurring schedule's next run will read. The source is the
 * document the schedule was made from; its `*Template` text is the text as
 * written, so the preview shows the placeholders the next run will fill.
 */
export type RecurringSource =
  | { kind: 'INVOICE'; invoice: Invoice }
  | { kind: 'BILL'; bill: Bill }
  | { kind: 'MANUAL_JOURNAL'; journal: ManualJournal }
  | { kind: 'JOURNAL'; entry: JournalEntry };

export interface TemplatePreview {
  surface: PlaceholderSurface;
  labels: string[];
  texts: string[];
  context: PlaceholderContext | null;
}

/**
 * The text fields a recurring run will fill, with the context a run on the
 * schedule's next date would use. The run's `[Occurrence]` is
 * `next_occurrence_index + 1` (recurringService.ts), so the preview adds one.
 */
export function templateTextsFor(
  schedule: RecurringSchedule,
  source: RecurringSource,
  organisationName: string | null,
): TemplatePreview {
  const occurrence = schedule.nextOccurrenceIndex + 1;
  const context = (extra: Partial<PlaceholderContext>): PlaceholderContext | null =>
    schedule.nextRunDate === null
      ? null
      : { date: schedule.nextRunDate, organisationName, occurrence, ...extra };

  switch (source.kind) {
    case 'INVOICE': {
      const inv = source.invoice;
      return {
        surface: 'INVOICE',
        labels: ['Notes', ...inv.lines.map((_, i) => `Line ${i + 1}`)],
        texts: [inv.notesTemplate ?? inv.notes ?? '', ...inv.lines.map((l) => l.descriptionTemplate ?? l.description)],
        context: context({ contactName: inv.customerNameSnapshot }),
      };
    }
    case 'BILL': {
      const bill = source.bill;
      return {
        surface: 'BILL',
        labels: ['Reference', 'Notes', ...bill.lines.map((_, i) => `Line ${i + 1}`)],
        texts: [
          bill.vendorReferenceTemplate ?? bill.vendorReference,
          bill.notesTemplate ?? bill.notes ?? '',
          ...bill.lines.map((l) => l.descriptionTemplate ?? l.description),
        ],
        context: context({ contactName: bill.vendorNameSnapshot }),
      };
    }
    case 'MANUAL_JOURNAL':
      return {
        surface: 'JOURNAL',
        labels: ['Narration'],
        texts: [source.journal.narrationTemplate ?? source.journal.narration],
        context: context({}),
      };
    case 'JOURNAL':
      return {
        surface: 'JOURNAL',
        labels: ['Narration'],
        texts: [source.entry.descriptionTemplate ?? source.entry.description ?? ''],
        context: context({}),
      };
  }
}
