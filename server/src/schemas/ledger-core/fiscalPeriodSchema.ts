import { z } from 'zod';

/**
 * POST /ledger-core/fiscal-periods/generate. One field: any date inside the
 * fiscal year to generate. The month/day boundaries themselves come from
 * ledger_settings, never from the request — a caller cannot invent a fiscal
 * year that disagrees with the organization's configured one.
 */
export const generatePeriodsSchema = z.object({
  containingDate: z.iso.date(),
});
