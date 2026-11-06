import type { RequestHandler } from 'express';
import * as basService from '../../services/accounting/basService.js';
import * as reportService from '../../services/accounting/reportService.js';
import { basEventsTable, basTable } from '../../services/accounting/reportTables.js';
import { addBasAdjustmentSchema, createBasSchema, lodgeBasSchema, updateBasSchema } from '../../schemas/accounting/basSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireParam } from '../../utils/routeParam.js';
import { requireUser } from '../../utils/requireUser.js';
import { readReportFormat, sendReportFile } from './reportExport.js';

/** Thin adapters over basService. Zero SQL (rule 2). */

export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  res.json({ success: true, ...(await basService.listBas(user.orgId)) });
};

export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createBasSchema, req.body);
  res.status(201).json({ success: true, bas: await basService.createBas(user.orgId, user.id, input.periodStart) });
};

export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const format = readReportFormat(req);
  const bas = await basService.getBas(user.orgId, requireParam(req, 'id'));
  if (format !== null) {
    const ctx = await reportService.loadReportContext(user.orgId);
    await sendReportFile(res, basTable(ctx, bas), format);
    return;
  }
  res.json({ success: true, bas });
};

export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateBasSchema, req.body);
  res.json({ success: true, bas: await basService.updateBas(user.orgId, requireParam(req, 'id'), input) });
};

export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await basService.deleteBas(user.orgId, requireParam(req, 'id'));
  res.status(204).end();
};

export const addAdjustment: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(addBasAdjustmentSchema, req.body);
  res.status(201).json({ success: true, bas: await basService.addAdjustment(user.orgId, user.id, requireParam(req, 'id'), input) });
};

export const removeAdjustment: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  res.json({
    success: true,
    bas: await basService.removeAdjustment(user.orgId, requireParam(req, 'id'), requireParam(req, 'adjustmentId')),
  });
};

export const finalise: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  res.json({ success: true, bas: await basService.finaliseBas(user.orgId, user.id, requireParam(req, 'id')) });
};

export const reopen: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  res.json({ success: true, bas: await basService.reopenBas(user.orgId, requireParam(req, 'id')) });
};

export const lodge: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(lodgeBasSchema, req.body);
  res.json({ success: true, bas: await basService.lodgeBas(user.orgId, user.id, requireParam(req, 'id'), input) });
};

/** GET /bas/:id/events?label=G1&format= — the drill-down, and the GST audit export. */
export const events: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const format = readReportFormat(req);
  const label = typeof req.query.label === 'string' && req.query.label !== '' ? req.query.label : null;
  const id = requireParam(req, 'id');
  const rows = await basService.listBasEvents(user.orgId, id, label);
  if (format !== null) {
    const ctx = await reportService.loadReportContext(user.orgId);
    const bas = await basService.getBas(user.orgId, id);
    await sendReportFile(res, basEventsTable(ctx, bas, rows, label), format);
    return;
  }
  res.json({ success: true, count: rows.length, events: rows });
};
