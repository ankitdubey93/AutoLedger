import { z } from 'zod';
import { GL_EXCEPTION_RULES, GL_EXCEPTION_SUBJECT_TYPES } from '../../types/accounting.js';

/** Request schemas for the Phase 45 GL exception report. */

export const createGlExceptionReviewSchema = z.object({
  rule: z.enum(GL_EXCEPTION_RULES),
  subjectType: z.enum(GL_EXCEPTION_SUBJECT_TYPES),
  subjectId: z.uuid(),
  note: z.string().trim().min(1, 'A note is required').max(500),
});
