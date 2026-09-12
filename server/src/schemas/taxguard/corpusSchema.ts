import { z } from 'zod';
import { TAXGUARD_JURISDICTIONS } from '../../types/taxguard.js';

export const createCorpusSchema = z
  .object({
    documentId: z.uuid(),
    title: z.string().trim().min(1).max(300),
    jurisdiction: z.enum(TAXGUARD_JURISDICTIONS),
    actYear: z.number().int().min(1800).max(2200).nullable().default(null),
  })
  .strict();
