import type { Request, RequestHandler } from 'express';
import * as orderService from '../../services/accounting/orderService.js';
import * as depositService from '../../services/accounting/depositService.js';
import { createDepositSchema } from '../../schemas/accounting/depositSchema.js';
import {
  cancelOrderSchema,
  convertOrderSchema,
  createOrderSchema,
  updateOrderSchema,
} from '../../schemas/accounting/orderSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate, optionalText, optionalUuid, readPagination, readSort } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';
import { ORDER_STATUSES, type OrderStatus, type QuoteDirection } from '../../types/accounting.js';

/**
 * Phase 42 — thin adapters over orderService, built once per direction so
 * `/orders` (SALES) and `/purchase-orders` (PURCHASE) share every handler.
 * The direction is fixed by the router, never read from the request. Zero
 * SQL (guardrails rule 2).
 */

function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

function optionalStatus(req: Request): OrderStatus | null {
  const raw = optionalText(req, 'status', 12);
  if (raw === null) return null;
  if (!isOrderStatus(raw)) throw new ApiError(400, `status must be one of ${ORDER_STATUSES.join(', ')}`);
  return raw;
}

export interface OrderController {
  list: RequestHandler;
  getOne: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
  confirm: RequestHandler;
  close: RequestHandler;
  reopen: RequestHandler;
  cancel: RequestHandler;
  convert: RequestHandler;
  deposit: RequestHandler;
}

export function makeOrderController(direction: QuoteDirection): OrderController {
  return {
    /** GET / */
    list: async (req, res) => {
      const user = requireUser(req);
      const { page, limit } = readPagination(req.query);
      const { orders, totalCount } = await orderService.listOrders(user.orgId, direction, {
        page,
        limit,
        status: optionalStatus(req),
        partyId: optionalUuid(req, 'partyId'),
        from: optionalIsoDate(req, 'from'),
        to: optionalIsoDate(req, 'to'),
        q: optionalText(req, 'q', 200),
        sort: readSort(req, orderService.ORDER_SORT_KEYS, { key: 'orderDate', direction: 'desc' }),
      });
      res.json({
        success: true,
        count: orders.length,
        totalCount,
        currentPage: page,
        totalPages: Math.max(1, Math.ceil(totalCount / limit)),
        orders,
      });
    },

    /** GET /:id */
    getOne: async (req, res) => {
      const user = requireUser(req);
      const order = await orderService.getOrderById(user.orgId, direction, requireParam(req, 'id'));
      res.json({ success: true, order });
    },

    /** POST / — a DRAFT. */
    create: async (req, res) => {
      const user = requireUser(req);
      const input = parseBody(createOrderSchema, req.body);
      const order = await orderService.createOrder(user.orgId, user.id, direction, input);
      res.status(201).json({ success: true, order });
    },

    /** PATCH /:id — a draft only. */
    update: async (req, res) => {
      const user = requireUser(req);
      const input = parseBody(updateOrderSchema, req.body);
      const order = await orderService.updateOrder(user.orgId, direction, requireParam(req, 'id'), input);
      res.json({ success: true, order });
    },

    /** DELETE /:id — a draft only. */
    remove: async (req, res) => {
      const user = requireUser(req);
      await orderService.deleteOrder(user.orgId, direction, requireParam(req, 'id'));
      res.status(204).end();
    },

    /** POST /:id/confirm — DRAFT → CONFIRMED; allocates the order number. */
    confirm: async (req, res) => {
      const user = requireUser(req);
      const order = await orderService.confirmOrder(user.orgId, user.id, direction, requireParam(req, 'id'));
      res.json({ success: true, order });
    },

    /** POST /:id/close — CONFIRMED → CLOSED. */
    close: async (req, res) => {
      const user = requireUser(req);
      const order = await orderService.closeOrder(user.orgId, direction, requireParam(req, 'id'));
      res.json({ success: true, order });
    },

    /** POST /:id/reopen — CLOSED → CONFIRMED. */
    reopen: async (req, res) => {
      const user = requireUser(req);
      const order = await orderService.reopenOrder(user.orgId, direction, requireParam(req, 'id'));
      res.json({ success: true, order });
    },

    /** POST /:id/cancel — CONFIRMED → CANCELLED, with a reason. */
    cancel: async (req, res) => {
      const user = requireUser(req);
      const { reason } = parseBody(cancelOrderSchema, req.body);
      const order = await orderService.cancelOrder(user.orgId, direction, requireParam(req, 'id'), reason);
      res.json({ success: true, order });
    },

    /** POST /:id/convert — bill part or all of a confirmed order as a draft invoice or bill. */
    convert: async (req, res) => {
      const user = requireUser(req);
      const input = parseBody(convertOrderSchema, req.body ?? {});
      const document = await orderService.convertOrder(user.orgId, user.id, direction, requireParam(req, 'id'), input);
      res.status(201).json({ success: true, document });
    },

    /** POST /:id/deposit — a DRAFT deposit invoice (or prepayment bill) for a CONFIRMED order. */
    deposit: async (req, res) => {
      const user = requireUser(req);
      const input = parseBody(createDepositSchema, req.body ?? {});
      const document = await depositService.createDepositDocument(
        user.orgId,
        user.id,
        direction,
        requireParam(req, 'id'),
        input,
      );
      res.status(201).json({ success: true, document });
    },
  };
}
