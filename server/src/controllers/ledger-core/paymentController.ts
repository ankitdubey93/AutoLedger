import type { RequestHandler, Request } from 'express';
import * as paymentService from '../../services/ledger-core/paymentService.js';
import { createPaymentSchema, voidPaymentSchema } from '../../schemas/ledger-core/paymentSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate, optionalText, optionalUuid, readPagination } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';
import {
  isPaymentDirection,
  isPaymentStatus,
  type PaymentDirection,
  type PaymentStatus,
} from '../../types/ledger-core.js';

/**
 * Thin adapters over paymentService. Zero SQL (guardrails rule 2).
 *
 * There is no PATCH and no DELETE — a posted payment is corrected by voiding
 * it (POST /:id/void), which posts a reversal (guardrails rule 6).
 */

function optionalDirection(req: Request): PaymentDirection | null {
  const raw = optionalText(req, 'direction', 10);
  if (raw === null) return null;
  if (!isPaymentDirection(raw)) {
    throw new ApiError(400, 'direction must be RECEIVE or PAY');
  }
  return raw;
}

function optionalPaymentStatus(req: Request): PaymentStatus | null {
  const raw = optionalText(req, 'status', 10);
  if (raw === null) return null;
  if (!isPaymentStatus(raw)) {
    throw new ApiError(400, 'status must be POSTED or VOID');
  }
  return raw;
}

/** GET /ledger-core/payments */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const { payments, totalCount } = await paymentService.listPayments(user.orgId, {
    page,
    limit,
    direction: optionalDirection(req),
    status: optionalPaymentStatus(req),
    customerId: optionalUuid(req, 'customerId'),
    vendorId: optionalUuid(req, 'vendorId'),
    from: optionalIsoDate(req, 'from'),
    to: optionalIsoDate(req, 'to'),
  });

  res.json({
    success: true,
    count: payments.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    payments,
  });
};

/** GET /ledger-core/payments/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const payment = await paymentService.getPaymentById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, payment });
};

/** POST /ledger-core/payments */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createPaymentSchema, req.body);
  const payment = await paymentService.createPayment(user.orgId, user.id, input);
  res.status(201).json({ success: true, payment });
};

/** POST /ledger-core/payments/:id/void */
export const void_: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const { entryDate } = parseBody(voidPaymentSchema, req.body ?? {});
  const payment = await paymentService.voidPayment(user.orgId, user.id, id, entryDate);
  res.json({ success: true, payment });
};
