import type { RequestHandler } from 'express';
import * as customerService from '../../services/ledger-core/customerService.js';
import { createCustomerSchema, updateCustomerSchema } from '../../schemas/ledger-core/customerSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalText } from '../../utils/queryParam.js';

/**
 * Thin adapters over customerService. Zero SQL (guardrails rule 2).
 *
 * There is no `remove` export — a customer is retired with `isActive: false`
 * through `update`, never deleted.
 */

/** GET /ledger-core/customers */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const customers = await customerService.listCustomers(user.orgId, {
    q: optionalText(req, 'q', 200),
    includeInactive: req.query.includeInactive === 'true',
  });
  res.json({ success: true, count: customers.length, customers });
};

/** GET /ledger-core/customers/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const customer = await customerService.getCustomerById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, customer });
};

/** POST /ledger-core/customers */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createCustomerSchema, req.body);
  const customer = await customerService.createCustomer(user.orgId, user.id, input);
  res.status(201).json({ success: true, customer });
};

/** PATCH /ledger-core/customers/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateCustomerSchema, req.body);
  const customer = await customerService.updateCustomer(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, customer });
};
