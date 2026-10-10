import type { Request, RequestHandler } from 'express';
import * as statementService from '../../services/accounting/statementService.js';
import * as statementSettingsService from '../../services/accounting/statementSettingsService.js';
import { updateStatementSettingsSchema } from '../../schemas/accounting/statementSchema.js';
import { STATEMENT_TYPES } from '../../config/constants.js';
import { ApiError } from '../../utils/apiError.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate, optionalText } from '../../utils/queryParam.js';
import type { PartyKind, StatementType } from '../../types/accounting.js';

/**
 * Thin adapters over statementService / statementSettingsService (Phase 39a).
 * Zero SQL (guardrails rule 2). The org always comes from the verified token.
 */

function optionalStatementType(req: Request): StatementType | null {
  const value = req.query.type;
  if (value === undefined) return null;
  if (typeof value !== 'string' || !(STATEMENT_TYPES as readonly string[]).includes(value)) {
    throw new ApiError(400, `type must be one of ${STATEMENT_TYPES.join(', ')}`);
  }
  return value as StatementType;
}

function listHandler(kind: PartyKind): RequestHandler {
  return async (req, res) => {
    const user = requireUser(req);
    const asOf = optionalIsoDate(req, 'asOf') ?? statementService.todayIso();
    const parties = await statementService.listStatementParties(user.orgId, kind, {
      asOf,
      q: optionalText(req, 'q', 200),
      includeZero: req.query.includeZero === 'true',
    });
    res.json({ success: true, asOf, count: parties.length, parties });
  };
}

function getHandler(kind: PartyKind): RequestHandler {
  return async (req, res) => {
    const user = requireUser(req);
    const request = statementService.readStatementRequest({
      type: optionalStatementType(req),
      asOf: optionalIsoDate(req, 'asOf'),
      from: optionalIsoDate(req, 'from'),
      to: optionalIsoDate(req, 'to'),
    });
    const statement = await statementService.getStatement(user.orgId, kind, requireParam(req, 'id'), request);
    res.json({ success: true, statement });
  };
}

/** GET /statements/customers */
export const listCustomers = listHandler('CUSTOMER');
/** GET /statements/vendors */
export const listVendors = listHandler('VENDOR');
/** GET /statements/customers/:id */
export const getCustomer = getHandler('CUSTOMER');
/** GET /statements/vendors/:id */
export const getVendor = getHandler('VENDOR');

/** GET /settings/statements */
export const getSettings: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const statementSettings = await statementSettingsService.getStatementSettings(user.orgId);
  res.json({ success: true, statementSettings });
};

/** PATCH /settings/statements */
export const updateSettings: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateStatementSettingsSchema, req.body);
  const statementSettings = await statementSettingsService.updateStatementSettings(user.orgId, input);
  res.json({ success: true, statementSettings });
};
