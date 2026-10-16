import type { Request, RequestHandler } from 'express';
import * as glExceptionService from '../../services/accounting/glExceptionService.js';
import * as reportService from '../../services/accounting/reportService.js';
import { glExceptionsTable } from '../../services/accounting/reportTables.js';
import { createGlExceptionReviewSchema } from '../../schemas/accounting/glExceptionSchema.js';
import { GL_EXCEPTION_RULES, type GlExceptionRule } from '../../types/accounting.js';
import { ApiError } from '../../utils/apiError.js';
import { optionalCsvList, optionalIsoDate } from '../../utils/queryParam.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { readReportFormat, sendReportFile } from './reportExport.js';
import { UUID_RE } from './reportController.js';

/**
 * Thin adapters over glExceptionService. Zero SQL (guardrails rule 2).
 * Phase 45 — the GL exception report and its review decisions.
 */

/** One of the constant rule names, or ApiError(400). */
function readRule(value: string): GlExceptionRule {
  const found = GL_EXCEPTION_RULES.find((rule) => rule === value);
  if (found === undefined) throw new ApiError(400, `Unknown rule "${value}"`);
  return found;
}

/** `includeReviewed` absent → false; 'true' / 'false' only. */
function readIncludeReviewed(req: Request): boolean {
  const value = req.query.includeReviewed;
  if (value === undefined) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ApiError(400, 'includeReviewed must be true or false');
}

/** GET /reports/exceptions?from=&to=&rules=&includeReviewed=&format= */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const from = optionalIsoDate(req, 'from');
  const to = optionalIsoDate(req, 'to');
  if (from === null || to === null) throw new ApiError(400, 'from and to are required');
  const requestedRules = optionalCsvList(
    req,
    'rules',
    /^[A-Z_]{1,30}$/,
    4,
    'rules must be a comma-separated list',
  );
  const rules = requestedRules === null ? [...GL_EXCEPTION_RULES] : requestedRules.map(readRule);
  const includeReviewed = readIncludeReviewed(req);
  const format = readReportFormat(req);

  const report = await glExceptionService.listExceptions(user.orgId, { from, to, rules, includeReviewed });
  if (format !== null) {
    const ctx = await reportService.loadReportContext(user.orgId);
    await sendReportFile(res, glExceptionsTable(ctx, report), format);
    return;
  }
  res.json({ success: true, ...report });
};

/** POST /reports/exceptions/reviews */
export const createReview: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createGlExceptionReviewSchema, req.body);
  const review = await glExceptionService.createReview(user.orgId, user.id, input);
  res.status(201).json({ success: true, review });
};

/** DELETE /reports/exceptions/reviews/:id — "Reopen" deletes the review row. */
export const deleteReview: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  if (!UUID_RE.test(id)) throw new ApiError(404, 'Review not found');
  await glExceptionService.deleteReview(user.orgId, id);
  res.status(204).end();
};
