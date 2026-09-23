import type { RequestHandler } from 'express';
import * as lookupService from '../../services/stock/lookupService.js';
import * as labelService from '../../services/stock/labelService.js';
import { labelRequestSchema } from '../../schemas/stock/labelSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { optionalText, optionalUuid } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';

/** Thin adapters over lookupService and labelService. Zero SQL (guardrails rule 2). */

/** GET /stock/lookup?q= or ?kind=lot|serial&id= */
export const lookup: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const rawKind = req.query.kind;

  if (rawKind !== undefined) {
    if (rawKind !== 'lot' && rawKind !== 'serial') {
      throw new ApiError(400, 'kind must be lot or serial');
    }
    const id = optionalUuid(req, 'id');
    if (id === null) throw new ApiError(400, 'id is required');

    const match = await lookupService.lookupById(user.orgId, rawKind === 'lot' ? 'LOT' : 'SERIAL', id);
    res.json({ success: true, match });
    return;
  }

  const q = optionalText(req, 'q', 100);
  if (q === null) throw new ApiError(400, 'q is required');

  const matches = await lookupService.lookup(user.orgId, q);
  res.json({ success: true, count: matches.length, matches });
};

/** POST /stock/labels */
export const labels: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(labelRequestSchema, req.body);
  const list = await labelService.buildLabels(user.orgId, input.targets);
  res.json({ success: true, count: list.length, labels: list });
};
