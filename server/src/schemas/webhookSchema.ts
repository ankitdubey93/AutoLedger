import { z } from 'zod';
import { OUTBOX_EVENT_TYPES } from '../types/webhooks.js';

/** Request schemas for webhook endpoint configuration (Phase 7). */

export const createEndpointSchema = z.object({
  url: z.string().trim().min(1).max(500),
  label: z.string().trim().min(1).max(100),
  eventTypes: z.array(z.enum(OUTBOX_EVENT_TYPES)).min(1).max(20),
});

export const updateEndpointSchema = z
  .object({
    url: z.string().trim().min(1).max(500).optional(),
    label: z.string().trim().min(1).max(100).optional(),
    eventTypes: z.array(z.enum(OUTBOX_EVENT_TYPES)).min(1).max(20).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });
