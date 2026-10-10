import { z } from 'zod';
import { STATEMENT_SEND_MAX_PARTIES, STATEMENT_TYPES } from '../../config/constants.js';

/** Phase 39b — statement email templates and sending. */

const PARTY_KINDS = ['CUSTOMER', 'VENDOR'] as const;

export const createStatementEmailTemplateSchema = z.object({
  partyKind: z.enum(PARTY_KINDS),
  name: z.string().trim().min(1).max(100),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  isDefault: z.boolean().default(false),
});

export const updateStatementEmailTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(5000).optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

const statementRequestFields = {
  type: z.enum(STATEMENT_TYPES).nullable().default(null),
  asOf: z.iso.date().nullable().default(null),
  from: z.iso.date().nullable().default(null),
  to: z.iso.date().nullable().default(null),
};

export const sendStatementsSchema = z.object({
  ...statementRequestFields,
  partyIds: z.array(z.uuid()).min(1, 'Choose at least one party').max(STATEMENT_SEND_MAX_PARTIES),
  templateId: z.uuid().nullable().default(null),
  toEmail: z.email().max(254).nullable().default(null),
});

export const previewStatementEmailSchema = z.object({
  ...statementRequestFields,
  partyId: z.uuid(),
  templateId: z.uuid().nullable().default(null),
});

/** Phase 39c — public: which invoices to pay. Amounts are computed by the server. */
export const startOnlinePaymentSchema = z.object({
  invoiceIds: z.array(z.uuid()).min(1, 'Choose at least one invoice to pay').max(100),
});

export const updateOnlinePaymentSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    depositAccountId: z.uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
