import { z } from 'zod';

export const recordTparLodgmentSchema = z.object({
  lodgedOn: z.iso.date(),
  atoReference: z.string().trim().max(100).nullable().default(null),
});
