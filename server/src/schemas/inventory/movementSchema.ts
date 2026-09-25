import { z } from 'zod';

/** Request schemas for Inventory's movement write path: receive, issue, transfer, adjust. */

const quantityMilli = z.int().min(1).max(1_000_000_000);
const unitCostCents = z.int().min(0).max(100_000_000_000);
const isoDate = z.iso.date();

const lotOnReceiptSchema = z
  .object({
    lotNumber: z.string().trim().min(1).max(40),
    manufacturedOn: isoDate.nullable().default(null),
    expiresOn: isoDate.nullable().default(null),
  })
  .nullable()
  .default(null);

const receiptSerialSchema = z.object({
  serialNumber: z.string().trim().min(1).max(60),
  costCents: z.int().min(0).max(100_000_000_000).nullable().default(null),
  attributes: z.record(z.string(), z.unknown()).default({}),
});

const receiptLineSchema = z.object({
  itemId: z.uuid(),
  quantityMilli,
  unitCostCents,
  lot: lotOnReceiptSchema,
  serials: z.array(receiptSerialSchema).min(1).max(1000).nullable().default(null),
});

export const receiptSchema = z.object({
  occurredOn: isoDate,
  reference: z.string().trim().max(100).nullable().default(null),
  locationId: z.uuid(),
  lines: z.array(receiptLineSchema).min(1).max(200),
});

const outboundLineSchema = z.object({
  itemId: z.uuid(),
  quantityMilli,
  lotId: z.uuid().nullable().default(null),
  serialIds: z.array(z.uuid()).min(1).max(1000).nullable().default(null),
});

export const issueSchema = z.object({
  occurredOn: isoDate,
  reference: z.string().trim().max(100).nullable().default(null),
  locationId: z.uuid(),
  lines: z.array(outboundLineSchema).min(1).max(200),
});

export const transferSchema = z.object({
  occurredOn: isoDate,
  reference: z.string().trim().max(100).nullable().default(null),
  fromLocationId: z.uuid(),
  toLocationId: z.uuid(),
  lines: z.array(outboundLineSchema).min(1).max(200),
});

const adjustmentLineSchema = z.object({
  itemId: z.uuid(),
  direction: z.enum(['IN', 'OUT']),
  quantityMilli,
  lotId: z.uuid().nullable().default(null),
  unitCostCents: unitCostCents.nullable().default(null),
});

export const adjustmentSchema = z.object({
  occurredOn: isoDate,
  reason: z.string().trim().min(1).max(200),
  locationId: z.uuid(),
  lines: z.array(adjustmentLineSchema).min(1).max(200),
});
