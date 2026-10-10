import type { RequestHandler } from 'express';
import * as onlinePaymentService from '../../services/accounting/onlinePaymentService.js';
import { updateOnlinePaymentSettingsSchema } from '../../schemas/accounting/statementEmailSchema.js';
import { ONLINE_PAYMENT_STATUSES, type OnlinePaymentStatus } from '../../types/accounting.js';
import { ApiError } from '../../utils/apiError.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';

/** Thin adapters over onlinePaymentService (Phase 39c). Zero SQL (rule 2). */

/** GET /settings/online-payments */
export const getSettings: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const onlinePaymentSettings = await onlinePaymentService.getSettings(user.orgId);
  res.json({ success: true, onlinePaymentSettings });
};

/** PATCH /settings/online-payments */
export const updateSettings: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateOnlinePaymentSettingsSchema, req.body);
  const onlinePaymentSettings = await onlinePaymentService.updateSettings(user.orgId, input);
  res.json({ success: true, onlinePaymentSettings });
};

/** GET /online-payments?status= */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const raw = req.query.status;
  if (raw !== undefined && (typeof raw !== 'string' || !(ONLINE_PAYMENT_STATUSES as readonly string[]).includes(raw))) {
    throw new ApiError(400, `status must be one of ${ONLINE_PAYMENT_STATUSES.join(', ')}`);
  }
  const payments = await onlinePaymentService.listOnlinePayments(user.orgId, (raw as OnlinePaymentStatus | undefined) ?? null);
  res.json({ success: true, count: payments.length, onlinePayments: payments });
};
