import { z } from 'zod';
import { MAX_CSV_CHARS } from '../../config/constants.js';
import { ACCOUNT_TYPES, MIGRATION_IMPORT_KINDS } from '../../types/ledger-core.js';

/**
 * Request schemas for LedgerCore's staged migration importers (Phase 9b).
 *
 * There is no `dateFormat` and no `columnMap` here, unlike
 * `schemas/ledger-core/bankSchema.ts`: neither importer has a date column —
 * a chart has no dates, and every opening balance posts at
 * `ledger_settings.books_start_date` — and column resolution is by header
 * synonym only.
 */

export const createMigrationImportSchema = z.object({
  kind: z.enum(MIGRATION_IMPORT_KINDS),
  fileName: z.string().trim().min(1).max(200),
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
    status: z.enum(['VALID', 'EXCLUDED']).optional(),
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
