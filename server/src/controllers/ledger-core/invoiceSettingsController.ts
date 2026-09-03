import type { RequestHandler } from 'express';
import * as invoiceSettingsService from '../../services/ledger-core/invoiceSettingsService.js';
import { updateInvoiceSettingsSchema } from '../../schemas/ledger-core/invoiceSettingsSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';

/**
 * Thin adapters over invoiceSettingsService. Zero SQL (guardrails rule 2).
 *
 * The organization comes from `requireUser(req).orgId` — the verified access
 * token — and never from a param, query value or header (rule 1).
 */

/** GET /ledger-core/settings/invoicing */
export const get: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const invoiceSettings = await invoiceSettingsService.getInvoiceSettings(user.orgId);
  res.json({ success: true, invoiceSettings });
};

/** PATCH /ledger-core/settings/invoicing */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateInvoiceSettingsSchema, req.body);
  const invoiceSettings = await invoiceSettingsService.updateInvoiceSettings(user.orgId, input);
  res.json({ success: true, invoiceSettings });
};
