import type { RequestHandler } from 'express';
import * as abnLookupService from '../../services/accounting/abnLookupService.js';
import { requireParam } from '../../utils/routeParam.js';

/** GET /abn/status */
export const status: RequestHandler = (_req, res) => {
  res.json({ success: true, lookupEnabled: abnLookupService.abnLookupEnabled() });
};

/** GET /abn/:abn */
export const lookup: RequestHandler = async (req, res) => {
  const result = await abnLookupService.lookupAbn(requireParam(req, 'abn'));
  res.json({ success: true, found: result !== null, result });
};
