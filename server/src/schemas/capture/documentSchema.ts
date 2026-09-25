import { z } from 'zod';

export const createCaptureDocumentSchema = z.object({
  documentId: z.uuid({ message: 'documentId must be a UUID' }),
});

export type CreateCaptureDocumentInput = z.infer<typeof createCaptureDocumentSchema>;
