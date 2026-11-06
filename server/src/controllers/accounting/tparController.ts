import type { RequestHandler } from 'express';
import * as reportService from '../../services/accounting/reportService.js';
import { tparTable } from '../../services/accounting/reportTables.js';
import * as tparService from '../../services/accounting/tparService.js';
import { recordTparLodgmentSchema } from '../../schemas/accounting/tparSchema.js';
import { ApiError } from '../../utils/apiError.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireParam } from '../../utils/routeParam.js';
import { requireUser } from '../../utils/requireUser.js';
import { readReportFormat, sendReportFile } from './reportExport.js';

function readYear(value: string): number {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ApiError(400, 'A financial year is the year it ends, such as 2026');
  return year;
}

/** GET /tpar/:year */
export const report: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const format = readReportFormat(req);
  const result = await tparService.tparReport(user.orgId, readYear(requireParam(req, 'year')));
  if (format !== null) {
    const ctx = await reportService.loadReportContext(user.orgId);
    await sendReportFile(res, tparTable(ctx, result), format);
    return;
  }
  res.json({ success: true, report: result });
};

/** POST /tpar/:year/lodge */
export const lodge: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(recordTparLodgmentSchema, req.body);
  const result = await tparService.recordTparLodgment(user.orgId, user.id, readYear(requireParam(req, 'year')), input);
  res.json({ success: true, report: result });
};
