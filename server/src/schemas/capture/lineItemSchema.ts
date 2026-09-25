import { z } from 'zod';

export const updateLineItemSchema = z.object({
  accountId: z.uuid({ message: 'accountId must be a UUID' }),
});

export type UpdateLineItemInput = z.infer<typeof updateLineItemSchema>;
