import { z } from 'zod';
import {
  STOCK_ATTRIBUTE_SCOPES,
  STOCK_ATTRIBUTE_TYPES,
  STOCK_ITEM_TYPES,
  STOCK_TRACKING_MODES,
} from '../../types/stock.js';

/** Request schemas for StockLedger's units of measure, categories and custom-field definitions. */

export const createUomSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/),
  name: z.string().trim().min(1).max(60),
  decimalPlaces: z.int().min(0).max(3),
});

export const updateUomSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export const createCategorySchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/),
  name: z.string().trim().min(1).max(100),
  itemType: z.enum(STOCK_ITEM_TYPES),
  defaultTracking: z.enum(STOCK_TRACKING_MODES),
  defaultUomId: z.uuid().nullable().default(null),
  parentId: z.uuid().nullable().default(null),
});

export const updateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    defaultUomId: z.uuid().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

const attributeOptionsSchema = z.array(z.string().trim().min(1).max(60)).min(1).max(50).nullable().default(null);

export const createAttributeSchema = z
  .object({
    key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,39}$/),
    label: z.string().trim().min(1).max(80),
    appliesTo: z.enum(STOCK_ATTRIBUTE_SCOPES),
    dataType: z.enum(STOCK_ATTRIBUTE_TYPES),
    options: attributeOptionsSchema,
    decimalPlaces: z.int().min(0).max(4).nullable().default(null),
    isRequired: z.boolean().default(false),
    sortOrder: z.int().min(0).max(999).default(0),
  })
  .superRefine((value, ctx) => {
    if (value.dataType === 'SELECT') {
      if (value.options === null) {
        ctx.addIssue('options are required for SELECT attributes and allowed only for them');
      } else if (new Set(value.options).size !== value.options.length) {
        ctx.addIssue('options must be unique');
      }
    } else if (value.options !== null) {
      ctx.addIssue('options are required for SELECT attributes and allowed only for them');
    }

    if (value.dataType === 'NUMBER') {
      if (value.decimalPlaces === null) {
        ctx.addIssue('decimalPlaces is required for NUMBER attributes and allowed only for them');
      }
    } else if (value.decimalPlaces !== null) {
      ctx.addIssue('decimalPlaces is required for NUMBER attributes and allowed only for them');
    }
  });

export const updateAttributeSchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    options: z.array(z.string().trim().min(1).max(60)).min(1).max(50).optional(),
    isRequired: z.boolean().optional(),
    sortOrder: z.int().min(0).max(999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
