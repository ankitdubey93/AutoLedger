import type { Request, RequestHandler } from 'express';
import * as auditService from '../services/auditService.js';
import { requireUser } from '../utils/requireUser.js';
import { requireParam } from '../utils/routeParam.js';
import { optionalIsoDate, optionalText, optionalUuid, readPagination } from '../utils/queryParam.js';
import { ApiError } from '../utils/apiError.js';
import { AUDIT_OPERATIONS, isAuditOperation, type AuditOperation } from '../types/audit.js';

/** Thin adapters over auditService. Zero SQL (guardrails rule 2). */

function optionalOperation(req: Request): AuditOperation | null {
  const raw = optionalText(req, 'operation', 10);
  if (raw === null) return null;
  if (!isAuditOperation(raw)) {
    throw new ApiError(400, `operation must be one of ${AUDIT_OPERATIONS.join(', ')}`);
  }
  return raw;
}

/** GET /audit-logs */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const { logs, totalCount } = await auditService.listAuditLogs(user.orgId, {
    page,
    limit,
    appSlug: optionalText(req, 'appSlug', 40),
    tableName: optionalText(req, 'tableName', 63),
    rowId: optionalUuid(req, 'rowId'),
    operation: optionalOperation(req),
    actorUserId: optionalUuid(req, 'actorUserId'),
    from: optionalIsoDate(req, 'from'),
    to: optionalIsoDate(req, 'to'),
  });

  res.json({
    success: true,
    count: logs.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    logs,
  });
};

/** GET /audit-logs/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const log = await auditService.getAuditLogById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, log });
};
