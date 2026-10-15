import type { RequestHandler } from 'express';
import * as depositService from '../../services/accounting/depositService.js';
import { voidDepositApplicationSchema } from '../../schemas/accounting/depositSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import type { QuoteDirection } from '../../types/accounting.js';

/**
 * Phase 42 — thin adapters over depositService's void. Zero SQL (guardrails
 * rule 2). The direction is fixed by the route, never read from the request;
 * the service 404s an application of the other direction.
 */

function voidHandler(direction: QuoteDirection): RequestHandler {
  return async (req, res) => {
    const user = requireUser(req);
    const id = requireParam(req, 'id');
    const { entryDate } = parseBody(voidDepositApplicationSchema, req.body ?? {});
    const application = await depositService.voidDepositApplication(user.orgId, user.id, direction, id, entryDate);
    res.json({ success: true, application });
  };
}

/** POST /deposit-applications/sales/:id/void */
export const voidSales: RequestHandler = voidHandler('SALES');

/** POST /deposit-applications/purchase/:id/void */
export const voidPurchase: RequestHandler = voidHandler('PURCHASE');
