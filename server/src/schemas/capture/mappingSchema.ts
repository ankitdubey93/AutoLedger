import { z } from 'zod';

/**
 * The shape of the `suggest_accounts` tool's `input`, as the model returns
 * it. Untrusted input, parsed exactly like a request body — never spread
 * into a query. `account_code` is checked against the candidate list handed
 * to the model in `mappingService.classifyWithModel`; a code outside that
 * list is discarded there, not here.
 */
export const classificationAssignmentSchema = z.object({
  line_index: z.number(),
  account_code: z.string(),
  confidence: z.number(),
});

export const classificationToolInputSchema = z.object({
  assignments: z.array(classificationAssignmentSchema).default([]),
});

export type ClassificationToolInput = z.infer<typeof classificationToolInputSchema>;
