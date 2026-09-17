import type { RequestHandler } from 'express';
import * as aiUsageService from '../services/aiUsageService.js';
import { requireUser } from '../utils/requireUser.js';
import { optionalIsoDate, optionalText } from '../utils/queryParam.js';

/** Thin adapter over aiUsageService. Zero SQL (guardrails rule 2). */

/** GET /ai-usage */
export const summary: RequestHandler = async (req, res) => {
  const user = requireUser(req);

  const usage = await aiUsageService.getUsageSummary(user.orgId, {
    from: optionalIsoDate(req, 'from'),
    to: optionalIsoDate(req, 'to'),
    appSlug: optionalText(req, 'appSlug', 50),
  });

  res.json({ success: true, usage });
};
