import { z } from 'zod';
import { STOCK_TRACKING_MODES } from '../../types/stock.js';
import { ITEM_CODE_REGEX } from '../../utils/stockCodePattern.js';

/**
 * Request schemas for StockLedger items. `code`, `categoryId`, `itemType`,
 * `tracking`, `uomId` and `codeSchemeId` are not updatable — mirroring
 * ledger-core's `itemSchema.ts`, sending `{ code: 'X' }` alone to the update
 * schema strips the unrecognized key (zod's default, non-strict behavior)
 * and then trips the "No fields to update" refine below, which is a 400 —
 * this schema achieves that the same way ledger-core's does, without
 * `.strict()`.
 */

const BARCODE_REGEX = /^[0-9]{8}$|^[0-9]{12,14}$/;
const quantityMilli = z.int().min(0).max(1_000_000_000);

export const createStockItemSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).nullable().default(null),
    categoryId: z.uuid(),
    uomId: z.uuid().nullable().default(null),
    tracking: z.enum(STOCK_TRACKING_MODES).nullable().default(null),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(ITEM_CODE_REGEX, 'Code may use A-Z, 0-9, - _ / . (max 40)')
      .nullable()
      .default(null),
    codeSchemeId: z.uuid().nullable().default(null),
    barcode: z.string().trim().regex(BARCODE_REGEX, 'Barcode must be 8, 12, 13 or 14 digits').nullable().default(null),
    attributes: z.record(z.string(), z.unknown()).default({}),
    reorderPointMilli: quantityMilli.nullable().default(null),
  })
  .refine((v) => !(v.code !== null && v.codeSchemeId !== null), {
    message: 'Provide either code or codeSchemeId, not both',
  });

export const updateStockItemSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    barcode: z.string().trim().regex(BARCODE_REGEX, 'Barcode must be 8, 12, 13 or 14 digits').nullable().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    reorderPointMilli: quantityMilli.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
