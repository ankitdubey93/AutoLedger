import { z } from 'zod';
import { TAXGUARD_JURISDICTIONS } from '../../types/taxguard.js';

export const askSchema = z
  .object({
    questionText: z.string().trim().min(3).max(2000),
    jurisdiction: z.enum(TAXGUARD_JURISDICTIONS),
  })
  .strict();
