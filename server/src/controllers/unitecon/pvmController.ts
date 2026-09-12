import type { RequestHandler } from 'express';
import * as pvmService from '../../services/unitecon/pvmService.js';
import { requireUser } from '../../utils/requireUser.js';
import { optionalText } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';

const FIRST_OF_MONTH = /^\d{4}-\d{2}-01$/;

/** GET /unitecon/pvm?baseFrom=...&baseTo=...&compareFrom=...&compareTo=... */
export const getPvm: RequestHandler = async (req, res) => {
  const user = requireUser(req);

  const baseFrom = optionalText(req, 'baseFrom', 10);
  const baseTo = optionalText(req, 'baseTo', 10);
  const compareFrom = optionalText(req, 'compareFrom', 10);
  const compareTo = optionalText(req, 'compareTo', 10);

  if (baseFrom === null || baseTo === null || compareFrom === null || compareTo === null) {
    throw new ApiError(400, 'baseFrom, baseTo, compareFrom and compareTo are required (YYYY-MM-01)');
  }
  for (const value of [baseFrom, baseTo, compareFrom, compareTo]) {
    if (!FIRST_OF_MONTH.test(value)) {
      throw new ApiError(400, 'Period bounds must be the first of a month (YYYY-MM-01)');
    }
  }

  const pvm = await pvmService.pvmReport(
    user.orgId,
    { from: baseFrom, to: baseTo },
    { from: compareFrom, to: compareTo },
  );
  res.json({ success: true, pvm });
};
