import { z } from 'zod';

/**
 * Request schemas for Accounting items ("Products & Services"). `code`, `kind`
 * and `itemType` are not updatable.
 *
 * Phase 32: a create body names its type with `itemType` (SERVICE or
 * NON_INVENTORY — INVENTORY and FIXED_ASSET are created in Inventory) or,
 * for Phase 24 callers, with the older `kind` (GOODS maps to NON_INVENTORY).
 * Sending both requires them to agree. The parsed result always carries
 * `itemType`; `kind` is derived from it in the service, never trusted alone.
 */

const createItemShape = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).nullable().default(null),
  kind: z.enum(['SERVICE', 'GOODS']).optional(),
  itemType: z.enum(['SERVICE', 'NON_INVENTORY', 'INVENTORY', 'FIXED_ASSET']).optional(),
  salePriceCents: z.int().min(0).max(1_000_000_000_000).nullable().default(null),
  purchasePriceCents: z.int().min(0).max(1_000_000_000_000).nullable().default(null),
  revenueAccountId: z.uuid().nullable().default(null),
  expenseAccountId: z.uuid().nullable().default(null),
  saleTaxRateBp: z.int().min(0).max(10_000).default(0),
  purchaseTaxRateBp: z.int().min(0).max(10_000).default(0),
});

export const createItemSchema = createItemShape.transform((value, ctx) => {
  const fromKind = value.kind === undefined ? undefined : value.kind === 'SERVICE' ? 'SERVICE' : 'NON_INVENTORY';
  const itemType = value.itemType ?? fromKind;
  if (itemType === undefined) {
    ctx.addIssue({ code: 'custom', message: 'itemType is required', path: ['itemType'] });
    return z.NEVER;
  }
  if (fromKind !== undefined && value.itemType !== undefined && fromKind !== value.itemType) {
    ctx.addIssue({ code: 'custom', message: 'kind and itemType disagree', path: ['kind'] });
    return z.NEVER;
  }
  const { kind: _kind, itemType: _itemType, ...rest } = value;
  return { ...rest, itemType };
});

export const updateItemSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    salePriceCents: z.int().min(0).max(1_000_000_000_000).nullable().optional(),
    purchasePriceCents: z.int().min(0).max(1_000_000_000_000).nullable().optional(),
    revenueAccountId: z.uuid().nullable().optional(),
    expenseAccountId: z.uuid().nullable().optional(),
    /** Phase 32: only accepted for stock-managed items. */
    assetAccountId: z.uuid().nullable().optional(),
    cogsAccountId: z.uuid().nullable().optional(),
    saleTaxRateBp: z.int().min(0).max(10_000).optional(),
    purchaseTaxRateBp: z.int().min(0).max(10_000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
