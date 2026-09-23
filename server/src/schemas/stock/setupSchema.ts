import { z } from 'zod';
import { STOCK_INDUSTRY_KEYS } from '../../types/stock.js';

/** Request schema for choosing (or re-applying) a StockLedger industry profile. */
export const applyProfileSchema = z.object({
  industryProfile: z.enum(STOCK_INDUSTRY_KEYS),
});
