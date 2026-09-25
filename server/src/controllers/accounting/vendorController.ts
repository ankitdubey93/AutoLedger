import type { RequestHandler } from 'express';
import * as vendorService from '../../services/accounting/vendorService.js';
import { createVendorSchema, updateVendorSchema } from '../../schemas/accounting/vendorSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import * as partyLedgerService from '../../services/accounting/partyLedgerService.js';
import { optionalIsoDate, optionalText, readPagination } from '../../utils/queryParam.js';

/**
 * Thin adapters over vendorService. Zero SQL (guardrails rule 2).
 *
 * There is no `remove` export — a vendor is retired with `isActive: false`
 * through `update`, never deleted.
 */

/** GET /vendors */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const vendors = await vendorService.listVendors(user.orgId, {
    q: optionalText(req, 'q', 200),
    includeInactive: req.query.includeInactive === 'true',
  });
  res.json({ success: true, count: vendors.length, vendors });
};

/** GET /vendors/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const vendor = await vendorService.getVendorById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, vendor });
};

/** POST /vendors */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createVendorSchema, req.body);
  const vendor = await vendorService.createVendor(user.orgId, user.id, input);
  res.status(201).json({ success: true, vendor });
};

/** PATCH /vendors/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateVendorSchema, req.body);
  const vendor = await vendorService.updateVendor(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, vendor });
};

/** GET /vendors/:id/ledger — the party's account under the control account (Phase 25). */
export const ledger: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const result = await partyLedgerService.vendorLedger(user.orgId, requireParam(req, 'id'), {
    page,
    limit,
    from: optionalIsoDate(req, 'from'),
    to: optionalIsoDate(req, 'to'),
  });

  res.json({
    success: true,
    ...result,
    count: result.rows.length,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(result.totalCount / limit)),
  });
};

/** GET /vendors/:id/open-items?asOf=YYYY-MM-DD */
export const openItems: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const result = await partyLedgerService.vendorOpenItems(
    user.orgId,
    requireParam(req, 'id'),
    optionalIsoDate(req, 'asOf'),
  );
  res.json({ success: true, ...result });
};
