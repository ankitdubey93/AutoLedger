import type { RequestHandler } from 'express';
import * as quoteEmailTemplateService from '../../services/accounting/quoteEmailTemplateService.js';
import {
  createQuoteTemplateSchema,
  updateQuoteTemplateSchema,
} from '../../schemas/accounting/quoteEmailTemplateSchema.js';
import { ApiError } from '../../utils/apiError.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import type { QuoteDirection } from '../../types/accounting.js';

/**
 * Phase 42 Slice C — thin adapters over quoteEmailTemplateService, mirroring
 * statementEmailController. Zero SQL (rule 2); the org always comes from the
 * verified token (rule 1).
 */

/** GET /settings/quote-email-templates?direction=SALES|PURCHASE */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const raw = req.query.direction;
  if (raw !== 'SALES' && raw !== 'PURCHASE') {
    throw new ApiError(400, 'direction must be SALES or PURCHASE');
  }
  const templates = await quoteEmailTemplateService.listQuoteTemplates(user.orgId, raw as QuoteDirection);
  res.json({ success: true, templates });
};

/** POST /settings/quote-email-templates */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createQuoteTemplateSchema, req.body);
  const template = await quoteEmailTemplateService.createQuoteTemplate(user.orgId, user.id, input);
  res.status(201).json({ success: true, template });
};

/** PATCH /settings/quote-email-templates/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateQuoteTemplateSchema, req.body);
  const template = await quoteEmailTemplateService.updateQuoteTemplate(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, template });
};

/** DELETE /settings/quote-email-templates/:id */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await quoteEmailTemplateService.deleteQuoteTemplate(user.orgId, requireParam(req, 'id'));
  res.status(204).end();
};
