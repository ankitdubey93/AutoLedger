import type { RequestHandler } from 'express';
import * as itemService from '../../services/stock/itemService.js';
import { createStockItemSchema, updateStockItemSchema } from '../../schemas/stock/itemSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalText, optionalUuid, readPagination } from '../../utils/queryParam.js';
import { isStockItemType, isStockTrackingMode } from '../../types/stock.js';
import type { StockItemType, StockTrackingMode } from '../../types/stock.js';

/** Thin adapters over itemService. Zero SQL (guardrails rule 2). */

function optionalItemType(raw: unknown): StockItemType | null {
  return typeof raw === 'string' && isStockItemType(raw) ? raw : null;
}

function optionalTracking(raw: unknown): StockTrackingMode | null {
  return typeof raw === 'string' && isStockTrackingMode(raw) ? raw : null;
}

/** GET /stock/items */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);
  const { items, totalCount } = await itemService.listItems(user.orgId, {
    q: optionalText(req, 'q', 200),
    categoryId: optionalUuid(req, 'categoryId'),
    itemType: optionalItemType(req.query.itemType),
    tracking: optionalTracking(req.query.tracking),
    includeInactive: req.query.includeInactive === 'true',
    lowStock: req.query.lowStock === 'true',
    page,
    limit,
  });
  res.json({
    success: true,
    count: items.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    items,
  });
};

/** GET /stock/items/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { item, attributes, serialAttributes } = await itemService.getItem(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, item, attributes, serialAttributes });
};

/** POST /stock/items */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createStockItemSchema, req.body);
  const item = await itemService.createItem(user.orgId, user.id, input);
  res.status(201).json({ success: true, item });
};

/** PATCH /stock/items/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateStockItemSchema, req.body);
  const item = await itemService.updateItem(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, item });
};
