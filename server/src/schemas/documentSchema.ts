import { z } from 'zod';

/**
 * Request schemas for the Document Vault (Phase 9.5).
 *
 * GET /documents' query filters are NOT here — list-endpoint query strings
 * are read by utils/queryParam.ts's readers directly in the controller
 * (the established pattern, e.g. journalController.list), not by a zod
 * schema. zod is reserved for JSON request bodies.
 */

/** Body for POST /documents/:id/links. */
export const attachDocumentSchema = z.object({
  appSlug: z.string().trim().min(1).max(40),
  entityType: z.string().trim().min(1).max(40),
  entityId: z.uuid(),
});

export type AttachDocumentBody = z.infer<typeof attachDocumentSchema>;
