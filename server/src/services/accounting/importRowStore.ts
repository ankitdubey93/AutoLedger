import type { PoolClient } from 'pg';
import type { MigrationCommitPreview } from '../../types/accounting.js';
import { DATE_FORMATS, isDateFormat, type DateFormat } from '../../utils/dateParse.js';

/**
 * Row-store helpers shared by the storage:'data' import kinds (Phase 36b).
 * Every statement carries an org_id predicate (rule 1) and runs on the
 * caller's transaction client (rule 5).
 */

/** What the three typed-storage services return; the registry wrapper adds `summary`/`warnings`. */
export type LegacyCommitPreview = Omit<MigrationCommitPreview, 'summary' | 'warnings'>;

export interface DataRow {
  id: string;
  rowNumber: number;
  values: Record<string, string | number | null>;
  raw: Record<string, string>;
}

/** Non-EXCLUDED rows of the import, ordered by row_number. */
export async function loadDataRowsOnClient(client: PoolClient, orgId: string, importId: string): Promise<DataRow[]> {
  const { rows } = await client.query<{
    id: string;
    row_number: number;
    data: Record<string, string | number | null> | null;
    raw: Record<string, string>;
  }>(
    `SELECT id, row_number, data, raw FROM migration_import_rows
      WHERE org_id = $1 AND import_id = $2 AND status <> 'EXCLUDED'
      ORDER BY row_number ASC`,
    [orgId, importId],
  );
  return rows.map((r) => ({ id: r.id, rowNumber: r.row_number, values: r.data ?? {}, raw: r.raw }));
}

export async function markCommittedOnClient(client: PoolClient, orgId: string, importId: string): Promise<void> {
  await client.query(
    "UPDATE migration_imports SET status = 'COMMITTED', committed_at = now() WHERE id = $1 AND org_id = $2",
    [importId, orgId],
  );
}

/** The import's date format; 'ISO' when absent or not one of DATE_FORMATS. */
export async function importDateFormatOnClient(client: PoolClient, orgId: string, importId: string): Promise<DateFormat> {
  const { rows } = await client.query<{ date_format: string | null }>(
    "SELECT options->>'dateFormat' AS date_format FROM migration_imports WHERE id = $1 AND org_id = $2",
    [importId, orgId],
  );
  const value = rows[0]?.date_format;
  return value !== undefined && value !== null && (DATE_FORMATS as readonly string[]).includes(value) && isDateFormat(value)
    ? value
    : 'ISO';
}

/** The date format of the import a row belongs to (for validators that are handed rows, not an import id). */
export async function importDateFormatForRowOnClient(client: PoolClient, orgId: string, rowId: string): Promise<DateFormat> {
  const { rows } = await client.query<{ date_format: string | null }>(
    `SELECT i.options->>'dateFormat' AS date_format
       FROM migration_import_rows r
       JOIN migration_imports i ON i.id = r.import_id AND i.org_id = r.org_id
      WHERE r.id = $1 AND r.org_id = $2`,
    [rowId, orgId],
  );
  const value = rows[0]?.date_format;
  return value !== undefined && value !== null && isDateFormat(value) ? value : 'ISO';
}
