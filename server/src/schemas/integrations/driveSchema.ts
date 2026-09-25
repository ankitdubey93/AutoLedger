import { z } from 'zod';
import { columnMapSchema } from '../accounting/bankSchema.js';

/**
 * Request schemas for the platform Drive integration. `columnMapSchema` is
 * imported, not redefined — see its own comment in `bankSchema.ts`.
 *
 * The two `.refine()` checks below mirror
 * `chk_integration_drive_folders_purpose_payload` exactly (migration 053):
 * belt-and-braces validation, guardrails rule 7 — both the service layer and
 * the database enforce the same invariant.
 */

export const createDriveFolderSchema = z
  .object({
    purpose: z.enum(['VENDOR_BILL', 'BANK_STATEMENT']),
    folder: z.string().trim().min(1).max(500),
    ledgerAccountId: z.uuid().nullable().default(null),
    dateFormat: z.enum(['ISO', 'DMY', 'MDY']).nullable().default(null),
    columnMap: columnMapSchema.nullable().default(null),
  })
  .refine((v) => v.purpose !== 'BANK_STATEMENT' || (v.ledgerAccountId !== null && v.dateFormat !== null), {
    message: 'A bank statement folder needs a ledger account and a date format',
  })
  .refine(
    (v) => v.purpose !== 'VENDOR_BILL' || (v.ledgerAccountId === null && v.dateFormat === null && v.columnMap === null),
    { message: 'A vendor bill folder takes no bank settings' },
  );

export const updateDriveFolderSchema = z
  .object({
    purpose: z.enum(['VENDOR_BILL', 'BANK_STATEMENT']).optional(),
    ledgerAccountId: z.uuid().nullable().optional(),
    dateFormat: z.enum(['ISO', 'DMY', 'MDY']).nullable().optional(),
    columnMap: columnMapSchema.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (v) => v.purpose !== 'BANK_STATEMENT' || v.ledgerAccountId === undefined || v.ledgerAccountId !== null,
    { message: 'A bank statement folder needs a ledger account' },
  )
  .refine((v) => v.purpose !== 'BANK_STATEMENT' || v.dateFormat === undefined || v.dateFormat !== null, {
    message: 'A bank statement folder needs a date format',
  });
