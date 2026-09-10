import { z } from 'zod';

export const createApFlowDocumentSchema = z.object({
  documentId: z.uuid({ message: 'documentId must be a UUID' }),
});

export type CreateApFlowDocumentInput = z.infer<typeof createApFlowDocumentSchema>;
