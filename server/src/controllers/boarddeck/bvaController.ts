import type { RequestHandler } from 'express';
import * as bvaService from '../../services/boarddeck/bvaService.js';
import { requireUser } from '../../utils/requireUser.js';
import { optionalUuid, optionalText } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';

/** Thin adapter over bvaService. Zero SQL (guardrails rule 2). */

const FIRST_OF_MONTH = /^\d{4}-\d{2}-01$/;
const MIN_TOP_N = 1;
const MAX_TOP_N = 20;
const DEFAULT_TOP_N = 5;

/** GET /boarddeck/bva?planId=&from=&to=&topN= */
export const getBva: RequestHandler = async (req, res) => {
  const user = requireUser(req);

  const planId = optionalUuid(req, 'planId');
  if (planId === null) throw new ApiError(400, 'planId is required');

  const from = optionalText(req, 'from', 10);
  const to = optionalText(req, 'to', 10);
  for (const value of [from, to]) {
    if (value !== null && !FIRST_OF_MONTH.test(value)) {
      throw new ApiError(400, 'from and to must be the first of a month (YYYY-MM-01)');
    }
  }

  const rawTopN = req.query.topN;
  let topN = DEFAULT_TOP_N;
  if (rawTopN !== undefined) {
    const parsed = Number(rawTopN);
    if (!Number.isInteger(parsed) || parsed < MIN_TOP_N || parsed > MAX_TOP_N) {
      throw new ApiError(400, 'topN must be an integer between 1 and 20');
    }
    topN = parsed;
  }

  const bva = await bvaService.bvaReport(user.orgId, planId, from, to, topN);
  res.json({ success: true, bva });
};
