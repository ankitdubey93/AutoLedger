import type { RequestHandler } from 'express';
import * as bankImportService from '../../services/ledger-core/bankImportService.js';
import { importStatementSchema } from '../../schemas/ledger-core/bankSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalUuid, readPagination } from '../../utils/queryParam.js';

/** Thin adapters over bankImportService. Zero SQL (guardrails rule 2). */

/** POST /ledger-core/bank-imports */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(importStatementSchema, req.body);
  const result = await bankImportService.importStatement(user.orgId, user.id, input);
  res.status(201).json({ success: true, ...result });
};

/** GET /ledger-core/bank-imports */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const { imports, totalCount } = await bankImportService.listImports(user.orgId, {
    page,
    limit,
    accountId: optionalUuid(req, 'accountId'),
  });

  res.json({
    success: true,
    count: imports.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    imports,
  });
};

/** GET /ledger-core/bank-imports/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const bankImport = await bankImportService.getImportById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, import: bankImport });
};
