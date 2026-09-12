import type { RequestHandler } from 'express';
import * as cohortService from '../../services/unitecon/cohortService.js';
import { requireUser } from '../../utils/requireUser.js';
import { optionalText } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';

/** Thin adapter over cohortService. Zero SQL (guardrails rule 2). */

const FIRST_OF_MONTH = /^\d{4}-\d{2}-01$/;

/** GET /unitecon/cohorts?from=YYYY-MM-01&to=YYYY-MM-01 */
export const getCohorts: RequestHandler = async (req, res) => {
  const user = requireUser(req);

  const from = optionalText(req, 'from', 10);
  const to = optionalText(req, 'to', 10);
  if (from === null || to === null) {
    throw new ApiError(400, 'from and to are required (YYYY-MM-01)');
  }
  if (!FIRST_OF_MONTH.test(from) || !FIRST_OF_MONTH.test(to)) {
    throw new ApiError(400, 'from and to must be the first of a month (YYYY-MM-01)');
  }

  const cohorts = await cohortService.cohortMatrix(user.orgId, from, to);
  res.json({ success: true, cohorts });
};
