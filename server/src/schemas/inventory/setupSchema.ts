import { z } from 'zod';
import { STOCK_INDUSTRY_KEYS } from '../../types/inventory.js';

/** Request schema for choosing (or re-applying) a Inventory industry profile. */
export const applyProfileSchema = z.object({
  industryProfile: z.enum(STOCK_INDUSTRY_KEYS),
});

/** Phase 32: the location a document line lands in when it names none. `null` clears it. */
export const updateStockSettingsSchema = z.object({
  defaultLocationId: z.uuid().nullable(),
});
