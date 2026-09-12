import type { RequestHandler } from 'express';
import * as productLineService from '../../services/unitecon/productLineService.js';
import { createProductLineSchema, updateProductLineSchema } from '../../schemas/unitecon/productLineSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalText } from '../../utils/queryParam.js';

/** Thin adapters over productLineService. Zero SQL (guardrails rule 2). */

/** GET /unitecon/product-lines?includeInactive=true */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const includeInactive = optionalText(req, 'includeInactive', 5) === 'true';
  const productLines = await productLineService.listProductLines(user.orgId, { includeInactive });
  res.json({ success: true, productLines, count: productLines.length });
};

/** POST /unitecon/product-lines */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createProductLineSchema, req.body);
  const productLine = await productLineService.createProductLine(user.orgId, user.id, input);
  res.status(201).json({ success: true, productLine });
};

/** PATCH /unitecon/product-lines/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateProductLineSchema, req.body);
  const productLine = await productLineService.updateProductLine(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, productLine });
};

/** DELETE /unitecon/product-lines/:id */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await productLineService.deleteProductLine(user.orgId, requireParam(req, 'id'));
  res.json({ success: true });
};
