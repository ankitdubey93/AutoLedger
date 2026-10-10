import type { PoolClient } from 'pg';
import type { PlaceholderContext } from '../../utils/placeholders.js';
import { fillField, fillOptionalField, LINE_DESCRIPTION_MAX, NOTES_MAX } from '../../utils/placeholderFields.js';

/**
 * Phase 40 — filling a credit or debit note's user-authored text (its notes
 * and each line's description) as the note is issued, so no placeholder
 * reaches an issued note. Shared by creditNoteService and debitNoteService,
 * whose tables differ only in name.
 *
 * ORDER MATTERS, as for invoices: the lines are updated here, while the note
 * is still DRAFT (migration 063's line trigger reads the parent's status);
 * the caller writes the returned notes in its own status-flip UPDATE, which
 * the header trigger allows because OLD.status is still DRAFT.
 *
 * Notes never recur, so unlike invoices and bills there is no `*_template`
 * column to keep the text as written.
 */

type NoteKind = 'CREDIT_NOTE' | 'DEBIT_NOTE';

/** Identifiers come only from this constant table, never from input (rule 4). */
const TABLES: Record<NoteKind, { header: string; lines: string; parentColumn: string }> = {
  CREDIT_NOTE: { header: 'credit_notes', lines: 'credit_note_lines', parentColumn: 'credit_note_id' },
  DEBIT_NOTE: { header: 'debit_notes', lines: 'debit_note_lines', parentColumn: 'debit_note_id' },
};

/**
 * Updates the note's line descriptions in place and returns its filled notes
 * for the caller's status-flip UPDATE. Runs on the caller's transaction
 * client (rule 5); the note row must already be locked FOR UPDATE.
 */
export async function fillNoteTextOnClient(
  client: PoolClient,
  orgId: string,
  kind: NoteKind,
  noteId: string,
  ctx: Omit<PlaceholderContext, 'organisationName'>,
): Promise<string | null> {
  const t = TABLES[kind];
  const { rows: headerRows } = await client.query<{ notes: string | null; organisation_name: string }>(
    `SELECT n.notes, o.name AS organisation_name
       FROM ${t.header} n
       JOIN organizations o ON o.id = n.org_id
      WHERE n.id = $1 AND n.org_id = $2`,
    [noteId, orgId],
  );
  const header = headerRows[0];
  if (header === undefined) return null;

  const fullCtx: PlaceholderContext = { ...ctx, organisationName: header.organisation_name };
  const notes = fillOptionalField(header.notes, kind, fullCtx, 'final', { label: 'Notes', max: NOTES_MAX });

  const { rows: lineRows } = await client.query<{ id: string; line_number: number; description: string }>(
    `SELECT id, line_number, description FROM ${t.lines}
      WHERE ${t.parentColumn} = $1 AND org_id = $2 ORDER BY line_number`,
    [noteId, orgId],
  );
  const changed = lineRows.flatMap((line) => {
    const filled = fillField(line.description, kind, fullCtx, 'final', {
      label: `Line ${String(line.line_number)}'s description`,
      max: LINE_DESCRIPTION_MAX,
      required: true,
    });
    return filled.template === null ? [] : [{ id: line.id, text: filled.text }];
  });
  if (changed.length > 0) {
    await client.query(
      `UPDATE ${t.lines} l
          SET description = v.description
         FROM unnest($3::uuid[], $4::text[]) AS v(id, description)
        WHERE l.id = v.id AND l.org_id = $1 AND l.${t.parentColumn} = $2`,
      [orgId, noteId, changed.map((c) => c.id), changed.map((c) => c.text)],
    );
  }

  return notes.text;
}
