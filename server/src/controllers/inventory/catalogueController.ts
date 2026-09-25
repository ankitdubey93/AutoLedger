import type { RequestHandler } from 'express';
import * as catalogueService from '../../services/inventory/catalogueService.js';
import {
  createAttributeSchema,
  createCategorySchema,
  createUomSchema,
  updateAttributeSchema,
  updateCategorySchema,
  updateUomSchema,
} from '../../schemas/inventory/catalogueSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/** Thin adapters over catalogueService. Zero SQL (guardrails rule 2). */

// ------------------------------------------------------------- UoMs

/** GET /inventory/uoms */
export const listUoms: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const uoms = await catalogueService.listUoms(user.orgId, req.query.includeInactive === 'true');
  res.json({ success: true, count: uoms.length, uoms });
};

/** POST /inventory/uoms */
export const createUom: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createUomSchema, req.body);
  const uom = await catalogueService.createUom(user.orgId, user.id, input);
  res.status(201).json({ success: true, uom });
};

/** PATCH /inventory/uoms/:id */
export const updateUom: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateUomSchema, req.body);
  const uom = await catalogueService.updateUom(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, uom });
};

// ------------------------------------------------------------- Categories

/** GET /inventory/categories */
export const listCategories: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const categories = await catalogueService.listCategories(user.orgId, req.query.includeInactive === 'true');
  res.json({ success: true, count: categories.length, categories });
};

/** GET /inventory/categories/:id */
export const getCategory: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { category, attributes } = await catalogueService.getCategory(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, category, attributes });
};

/** POST /inventory/categories */
export const createCategory: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createCategorySchema, req.body);
  const category = await catalogueService.createCategory(user.orgId, user.id, input);
  res.status(201).json({ success: true, category });
};

/** PATCH /inventory/categories/:id */
export const updateCategory: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateCategorySchema, req.body);
  const category = await catalogueService.updateCategory(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, category });
};

// ------------------------------------------------------------- Attribute definitions

/** POST /inventory/categories/:id/attributes */
export const createAttribute: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createAttributeSchema, req.body);
  const attribute = await catalogueService.createAttribute(user.orgId, user.id, requireParam(req, 'id'), input);
  res.status(201).json({ success: true, attribute });
};

/** PATCH /inventory/categories/:id/attributes/:attributeId */
export const updateAttribute: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateAttributeSchema, req.body);
  const attribute = await catalogueService.updateAttribute(
    user.orgId,
    requireParam(req, 'id'),
    requireParam(req, 'attributeId'),
    input,
  );
  res.json({ success: true, attribute });
};
