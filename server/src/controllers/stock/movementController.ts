import type { RequestHandler } from 'express';
import * as movementService from '../../services/stock/movementService.js';
import * as stockQueryService from '../../services/stock/stockQueryService.js';
import { adjustmentSchema, issueSchema, receiptSchema, transferSchema } from '../../schemas/stock/movementSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate, optionalUuid, readPagination } from '../../utils/queryParam.js';
import { isStockMovementType, isStockSerialStatus } from '../../types/stock.js';
import type { StockMovementType, StockSerialStatus } from '../../types/stock.js';

/** Thin adapters over movementService and stockQueryService. Zero SQL (guardrails rule 2). */

function optionalMovementType(raw: unknown): StockMovementType | null {
  return typeof raw === 'string' && isStockMovementType(raw) ? raw : null;
}

function optionalSerialStatus(raw: unknown): StockSerialStatus | null {
  return typeof raw === 'string' && isStockSerialStatus(raw) ? raw : null;
}

/** POST /stock/receipts */
export const receive: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(receiptSchema, req.body);
  const result = await movementService.receive(user.orgId, user.id, input);
  res.status(201).json({ success: true, movementGroupId: result.movementGroupId, movements: result.movements });
};

/** POST /stock/issues */
export const issue: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(issueSchema, req.body);
  const result = await movementService.issue(user.orgId, user.id, input);
  res.status(201).json({ success: true, movementGroupId: result.movementGroupId, movements: result.movements });
};

/** POST /stock/transfers */
export const transfer: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(transferSchema, req.body);
  const result = await movementService.transfer(user.orgId, user.id, input);
  res.status(201).json({ success: true, movementGroupId: result.movementGroupId, movements: result.movements });
};

/** POST /stock/adjustments */
export const adjust: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(adjustmentSchema, req.body);
  const result = await movementService.adjust(user.orgId, user.id, input);
  res.status(201).json({ success: true, movementGroupId: result.movementGroupId, movements: result.movements });
};

/** GET /stock/balances */
export const balances: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const list = await stockQueryService.listBalances(user.orgId, {
    itemId: optionalUuid(req, 'itemId'),
    locationId: optionalUuid(req, 'locationId'),
    includeZero: req.query.includeZero === 'true',
  });
  res.json({ success: true, count: list.length, balances: list });
};

/** GET /stock/movements */
export const movements: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);
  const { movements: list, totalCount } = await stockQueryService.listMovements(user.orgId, {
    itemId: optionalUuid(req, 'itemId'),
    locationId: optionalUuid(req, 'locationId'),
    movementType: optionalMovementType(req.query.type),
    movementGroupId: optionalUuid(req, 'groupId'),
    from: optionalIsoDate(req, 'from'),
    to: optionalIsoDate(req, 'to'),
    page,
    limit,
  });
  res.json({
    success: true,
    count: list.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    movements: list,
  });
};

/** GET /stock/items/:id/lots */
export const itemLots: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const lots = await stockQueryService.listItemLots(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, count: lots.length, lots });
};

/** GET /stock/items/:id/serials */
export const itemSerials: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const serials = await stockQueryService.listItemSerials(
    user.orgId,
    requireParam(req, 'id'),
    optionalSerialStatus(req.query.status),
  );
  res.json({ success: true, count: serials.length, serials });
};

/** GET /stock/summary */
export const summary: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const result = await stockQueryService.getSummary(user.orgId);
  res.json({ success: true, summary: result });
};

/** GET /stock/product-balances — on-hand per LedgerCore product id, for the Products & Services list and line pickers. */
export const productBalances: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const balances = await stockQueryService.listProductBalances(user.orgId);
  res.json({ success: true, count: balances.length, balances });
};
