import { z } from 'zod';
import { MAX_CSV_CHARS, MAX_IMPORT_ROWS } from '../../config/constants.js';
import { DATE_FORMATS } from '../../utils/dateParse.js';
import { ACCOUNT_TYPES, MIGRATION_IMPORT_KINDS } from '../../types/accounting.js';

/**
 * Request schemas for Accounting's staged migration importers (Phase 9b, 36a).
 *
 * `columnMap` is supplied on create (Phase 36) to override automatic header
 * matching. `dateFormat` (Phase 36b) says how date cells are written. Every column key is validated
 * server-side against the kind's registry.
 */

export const createMigrationImportSchema = z.object({
  kind: z.enum(MIGRATION_IMPORT_KINDS),
  fileName: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(MAX_CSV_CHARS),
  columnMap: z.record(z.string().min(1).max(64), z.string().trim().min(1).max(200).nullable()).nullable().default(null),
  dateFormat: z.enum(DATE_FORMATS).default('ISO'),
  conversionMode: z.boolean().default(false),
});

/** POST /migration-imports/:id/commit — options for kinds with commit modes (36d). */
export const commitMigrationImportSchema = z.object({
  mode: z.enum(['DRAFT', 'POST']).optional(),
  postingDate: z.iso.date().nullable().optional(),
});

export const inspectMigrationImportSchema = z.object({
  kind: z.enum(MIGRATION_IMPORT_KINDS),
  content: z.string().min(1).max(MAX_CSV_CHARS),
});

/**
 * A per-row fix. Every field is optional; only what is sent is changed.
 * `accountCode` and `accountType` ARE editable here — unlike
 * `updateAccountSchema`, which refuses `code` and `type` — because this is
 * staging data that has not created an account yet. Once committed, the
 * account's own rules take over.
 */
export const patchMigrationRowSchema = z
  .object({
    accountCode: z.string().trim().min(1).max(20).optional(),
    accountName: z.string().trim().min(1).max(120).optional(),
    accountType: z.enum(ACCOUNT_TYPES).optional(),
    parentCode: z.string().trim().max(20).nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
    debitCents: z.int().min(0).max(1_000_000_000_000).optional(),
    creditCents: z.int().min(0).max(1_000_000_000_000).optional(),
    // CUSTOMERS / VENDORS only (Phase 24). Limits mirror partyImportService's
    // own truncation in parseCustomerRow.
    partyName: z.string().trim().min(1).max(200).optional(),
    partyEmail: z.string().trim().max(254).nullable().optional(),
    partyPhone: z.string().trim().max(40).nullable().optional(),
    partyAddress: z.string().trim().max(500).nullable().optional(),
    partyTaxNumber: z.string().trim().max(64).nullable().optional(),
    partyPaymentTerms: z.string().trim().max(500).nullable().optional(),
    partyNotes: z.string().trim().max(1000).nullable().optional(),
    status: z.enum(['VALID', 'EXCLUDED']).optional(),
    // storage:'data' kinds (Phase 36b): column key -> new cell text.
    values: z.record(z.string().min(1).max(64), z.string().max(1000).nullable()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' })
  .refine(
    (v) =>
      !(
        v.debitCents !== undefined &&
        v.creditCents !== undefined &&
        v.debitCents > 0 &&
        v.creditCents > 0
      ),
    { message: 'A row has one side, not both' },
  );

/** POST /migration-imports/:id/rows/status — bulk include/exclude (36c). */
export const setRowsStatusSchema = z.object({
  rowIds: z.array(z.uuid()).min(1).max(MAX_IMPORT_ROWS),
  status: z.enum(['VALID', 'EXCLUDED']),
});
