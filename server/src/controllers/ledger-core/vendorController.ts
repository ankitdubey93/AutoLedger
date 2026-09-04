import type { RequestHandler } from 'express';
import * as vendorService from '../../services/ledger-core/vendorService.js';
import { createVendorSchema, updateVendorSchema } from '../../schemas/ledger-core/vendorSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalText } from '../../utils/queryParam.js';

/**
 * Thin adapters over vendorService. Zero SQL (guardrails rule 2).
 *
 * There is no `remove` export — a vendor is retired with `isActive: false`
 * through `update`, never deleted.
 */

/** GET /ledger-core/vendors */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const vendors = await vendorService.listVendors(user.orgId, {
    q: optionalText(req, 'q', 200),
    includeInactive: req.query.includeInactive === 'true',
  });
  res.json({ success: true, count: vendors.length, vendors });
};

/** GET /ledger-core/vendors/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const vendor = await vendorService.getVendorById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, vendor });
};

/** POST /ledger-core/vendors */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createVendorSchema, req.body);
  const vendor = await vendorService.createVendor(user.orgId, user.id, input);
  res.status(201).json({ success: true, vendor });
};

/** PATCH /ledger-core/vendors/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateVendorSchema, req.body);
  const vendor = await vendorService.updateVendor(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, vendor });
};
