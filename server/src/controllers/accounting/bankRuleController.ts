import type { RequestHandler } from 'express';
import * as bankRuleService from '../../services/accounting/bankRuleService.js';
import { createBankRuleSchema, updateBankRuleSchema } from '../../schemas/accounting/bankRuleSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/**
 * Thin adapters over bankRuleService. Zero SQL (guardrails rule 2).
 *
 * There is no GET `/:id` and no `remove` export — a rule is read only as
 * part of the list, and retired with `isActive: false` through `update`,
 * never deleted.
 */

/** GET /bank-rules */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const bankRules = await bankRuleService.listBankRules(user.orgId, {
    includeInactive: req.query.includeInactive === 'true',
  });
  res.json({ success: true, count: bankRules.length, bankRules });
};

/** POST /bank-rules */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createBankRuleSchema, req.body);
  const bankRule = await bankRuleService.createBankRule(user.orgId, user.id, input);
  res.status(201).json({ success: true, bankRule });
};

/** POST /bank-rules/apply */
export const apply: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const result = await bankRuleService.applyRulesToUnmatched(user.orgId, user.id);
  res.json({ success: true, appliedCount: result.appliedCount });
};

/** PATCH /bank-rules/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateBankRuleSchema, req.body);
  const bankRule = await bankRuleService.updateBankRule(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, bankRule });
};
