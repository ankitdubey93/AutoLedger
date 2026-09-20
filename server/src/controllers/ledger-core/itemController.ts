import type { RequestHandler } from 'express';
import * as itemService from '../../services/ledger-core/itemService.js';
import { createItemSchema, updateItemSchema } from '../../schemas/ledger-core/itemSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalText } from '../../utils/queryParam.js';
import type { ItemKind } from '../../types/ledger-core.js';

/**
 * Thin adapters over itemService. Zero SQL (guardrails rule 2).
 *
 * There is no `remove` export — an item is retired with `isActive: false`
 * through `update`, never deleted.
 */

function optionalKind(raw: unknown): ItemKind | null {
  return raw === 'SERVICE' || raw === 'GOODS' ? raw : null;
}

/** GET /ledger-core/items */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const items = await itemService.listItems(user.orgId, {
    q: optionalText(req, 'q', 200),
    kind: optionalKind(req.query.kind),
    includeInactive: req.query.includeInactive === 'true',
  });
  res.json({ success: true, count: items.length, items });
};

/** GET /ledger-core/items/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const item = await itemService.getItemById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, item });
};

/** POST /ledger-core/items */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createItemSchema, req.body);
  const item = await itemService.createItem(user.orgId, user.id, input);
  res.status(201).json({ success: true, item });
};

/** PATCH /ledger-core/items/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateItemSchema, req.body);
  const item = await itemService.updateItem(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, item });
};
