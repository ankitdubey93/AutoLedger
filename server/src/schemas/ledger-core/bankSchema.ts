import { z } from 'zod';
import { MAX_CSV_CHARS } from '../../config/constants.js';

/**
 * Request schemas for LedgerCore bank reconciliation.
 *
 * Deliberately absent: `currencyCode` (the organization's base currency),
 * `status` (a bank line is born UNMATCHED), `dedupeHash` (server-computed —
 * a client-supplied hash would let a caller suppress or forge deduplication).
 */

export const importStatementSchema = z
  .object({
    accountId: z.uuid(),
    fileName: z.string().trim().min(1).max(200),
    content: z.string().min(1).max(MAX_CSV_CHARS),
    dateFormat: z.enum(['ISO', 'DMY', 'MDY']).default('ISO'),
    columnMap: z
      .object({
        date: z.string().trim().min(1).max(100),
        description: z.string().trim().min(1).max(100),
        amount: z.string().trim().max(100).nullable().default(null),
        debit: z.string().trim().max(100).nullable().default(null),
        credit: z.string().trim().max(100).nullable().default(null),
        reference: z.string().trim().max(100).nullable().default(null),
      })
      .refine((v) => v.amount !== null || (v.debit !== null && v.credit !== null), {
        message: 'columnMap needs either an amount column or both a debit and a credit column',
      })
      .nullable()
      .default(null),
    closingBalanceCents: z.int().min(-1_000_000_000_000).max(1_000_000_000_000).nullable().default(null),
    closingBalanceOn: z.iso.date().nullable().default(null),
  })
  .refine((v) => (v.closingBalanceCents === null) === (v.closingBalanceOn === null), {
    message: 'closingBalanceCents and closingBalanceOn must be supplied together',
  });

export const matchBankTransactionSchema = z
  .object({
    suggestionId: z.uuid().nullable().default(null),
    invoiceId: z.uuid().nullable().default(null),
    billId: z.uuid().nullable().default(null),
  })
  .refine((v) => [v.suggestionId, v.invoiceId, v.billId].filter((x) => x !== null).length === 1, {
    message: 'Name exactly one of suggestionId, invoiceId or billId',
  });
