import type { RequestHandler } from 'express';
import * as fxRevaluationService from '../../services/ledger-core/fxRevaluationService.js';
import { runRevaluationSchema } from '../../schemas/ledger-core/fxRevaluationSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { readPagination } from '../../utils/queryParam.js';

/** Thin adapters over fxRevaluationService. Zero SQL (guardrails rule 2). */

/** GET /ledger-core/fx-revaluations */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const { revaluations, totalCount } = await fxRevaluationService.listRevaluations(user.orgId, {
    page,
    limit,
  });

  res.json({
    success: true,
    revaluations,
    count: revaluations.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
  });
};

/** GET /ledger-core/fx-revaluations/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const revaluation = await fxRevaluationService.getRevaluationById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, revaluation });
};

/** POST /ledger-core/fx-revaluations */
export const run: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(runRevaluationSchema, req.body);
  const revaluation = await fxRevaluationService.runRevaluation(user.orgId, user.id, input.asOfDate);
  res.status(201).json({ success: true, revaluation });
};
