import { z } from 'zod';

export const createCloseRunSchema = z.object({ fiscalPeriodId: z.uuid() }).strict();
