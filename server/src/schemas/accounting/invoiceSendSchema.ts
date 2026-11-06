import { z } from 'zod';

/** Phase 48 — emailing an issued invoice to its customer. */
export const sendInvoiceSchema = z.object({
  toEmail: z.string().trim().toLowerCase().pipe(z.email()).nullable().default(null),
  message: z.string().trim().max(2000).nullable().default(null),
});
