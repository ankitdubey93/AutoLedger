import type { RequestHandler } from 'express';
import { AU_TAX_CODES } from '../../config/taxPacks/au.js';

/** GET /tax-codes */
export const list: RequestHandler = (_req, res) => {
  res.json({
    success: true,
    codes: AU_TAX_CODES.map(({ code, label, direction, rateBp, reported }) => ({ code, label, direction, rateBp, reported })),
  });
};
