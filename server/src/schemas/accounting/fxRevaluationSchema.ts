import { z } from 'zod';

export const runRevaluationSchema = z.object({
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'asOfDate must be YYYY-MM-DD'),
});
