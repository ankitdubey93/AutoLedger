import { z } from 'zod';

/**
 * Request schema for Phase 46c's History & notes. Only the note text is
 * client-supplied: the entity type comes from the router, the id from the
 * route, the actor from the verified access token.
 */
export const addHistoryNoteSchema = z.object({ text: z.string().trim().min(1, 'Write a note first').max(1000, 'A note can be at most 1000 characters') }).strict();
