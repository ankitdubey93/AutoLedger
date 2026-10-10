import type { RequestHandler } from 'express';
import * as statementEmailService from '../../services/accounting/statementEmailService.js';
import * as statementService from '../../services/accounting/statementService.js';
import {
  createStatementEmailTemplateSchema,
  previewStatementEmailSchema,
  sendStatementsSchema,
  updateStatementEmailTemplateSchema,
} from '../../schemas/accounting/statementEmailSchema.js';
import { ApiError } from '../../utils/apiError.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import type { PartyKind } from '../../types/accounting.js';

/**
 * Thin adapters over statementEmailService (Phase 39b). Zero SQL (rule 2);
 * the org always comes from the verified token (rule 1).
 */

/** GET /settings/statement-email-templates?kind=CUSTOMER|VENDOR */
export const listTemplates: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const raw = req.query.kind;
  if (raw !== undefined && raw !== 'CUSTOMER' && raw !== 'VENDOR') {
    throw new ApiError(400, 'kind must be CUSTOMER or VENDOR');
  }
  const templates = await statementEmailService.listTemplates(user.orgId, raw ?? null);
  res.json({ success: true, count: templates.length, templates });
};

/** POST /settings/statement-email-templates */
export const createTemplate: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createStatementEmailTemplateSchema, req.body);
  const template = await statementEmailService.createTemplate(user.orgId, user.id, input);
  res.status(201).json({ success: true, template });
};

/** PATCH /settings/statement-email-templates/:id */
export const updateTemplate: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateStatementEmailTemplateSchema, req.body);
  const template = await statementEmailService.updateTemplate(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, template });
};

/** DELETE /settings/statement-email-templates/:id */
export const deleteTemplate: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await statementEmailService.deleteTemplate(user.orgId, requireParam(req, 'id'));
  res.status(204).end();
};

function sendHandler(kind: PartyKind): RequestHandler {
  return async (req, res) => {
    const user = requireUser(req);
    const input = parseBody(sendStatementsSchema, req.body);
    const result = await statementEmailService.sendStatements(user.orgId, user.id, kind, {
      partyIds: input.partyIds,
      request: statementService.readStatementRequest(input),
      templateId: input.templateId,
      toEmail: input.toEmail,
    });
    res.status(201).json({ success: true, ...result });
  };
}

function previewHandler(kind: PartyKind): RequestHandler {
  return async (req, res) => {
    const user = requireUser(req);
    const input = parseBody(previewStatementEmailSchema, req.body);
    const preview = await statementEmailService.previewStatementEmail(
      user.orgId,
      kind,
      input.partyId,
      statementService.readStatementRequest(input),
      input.templateId,
    );
    res.json({ success: true, preview });
  };
}

function sendsHandler(kind: PartyKind): RequestHandler {
  return async (req, res) => {
    const user = requireUser(req);
    const sends = await statementEmailService.listSends(user.orgId, kind, requireParam(req, 'id'));
    res.json({ success: true, count: sends.length, sends });
  };
}

/** POST /statements/customers/send */
export const sendCustomers = sendHandler('CUSTOMER');
/** POST /statements/vendors/send */
export const sendVendors = sendHandler('VENDOR');
/** POST /statements/customers/preview-email */
export const previewCustomer = previewHandler('CUSTOMER');
/** POST /statements/vendors/preview-email */
export const previewVendor = previewHandler('VENDOR');
/** GET /statements/customers/:id/sends */
export const customerSends = sendsHandler('CUSTOMER');
/** GET /statements/vendors/:id/sends */
export const vendorSends = sendsHandler('VENDOR');

/** POST /statement-sends/:id/revoke */
export const revokeSend: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const send = await statementEmailService.revokeSend(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, send });
};
