import type { RequestHandler } from 'express';
import * as migrationImportService from '../../services/ledger-core/migrationImportService.js';
import {
  createMigrationImportSchema,
  patchMigrationRowSchema,
} from '../../schemas/ledger-core/migrationImportSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { readPagination } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';
import { isMigrationImportKind, isMigrationRowStatus } from '../../types/ledger-core.js';

/** Thin adapters over migrationImportService. Zero SQL (guardrails rule 2). */

/** POST /ledger-core/migration-imports */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createMigrationImportSchema, req.body);
  const result = await migrationImportService.createImport(user.orgId, user.id, input);
  res.status(201).json({ success: true, import: result.import, rows: result.rows });
};

/** GET /ledger-core/migration-imports */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const kindParam = req.query.kind;
  let kind = null;
  if (kindParam !== undefined) {
    if (typeof kindParam !== 'string' || !isMigrationImportKind(kindParam)) {
      throw new ApiError(400, 'kind must be CHART_OF_ACCOUNTS or OPENING_BALANCES');
    }
    kind = kindParam;
  }

  const { imports, totalCount } = await migrationImportService.listImports(user.orgId, { page, limit, kind });

  res.json({
    success: true,
    count: imports.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    imports,
  });
};

/** GET /ledger-core/migration-imports/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const imp = await migrationImportService.getImportById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, import: imp });
};

/** GET /ledger-core/migration-imports/:id/rows */
export const listRows: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const statusParam = req.query.status;
  let status = null;
  if (statusParam !== undefined) {
    if (typeof statusParam !== 'string' || !isMigrationRowStatus(statusParam)) {
      throw new ApiError(400, 'status must be VALID, INVALID or EXCLUDED');
    }
    status = statusParam;
  }

  const { rows, totalCount } = await migrationImportService.listRows(user.orgId, requireParam(req, 'id'), {
    page,
    limit,
    status,
  });

  res.json({
    success: true,
    count: rows.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    rows,
  });
};

/** PATCH /ledger-core/migration-imports/:id/rows/:rowId */
export const patchRow: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(patchMigrationRowSchema, req.body);
  const result = await migrationImportService.patchRow(
    user.orgId,
    requireParam(req, 'id'),
    requireParam(req, 'rowId'),
    input,
  );
  res.json({ success: true, import: result.import, row: result.row });
};

/** POST /ledger-core/migration-imports/:id/validate */
export const validate: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const imp = await migrationImportService.revalidate(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, import: imp });
};

/** GET /ledger-core/migration-imports/:id/preview */
export const preview: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const result = await migrationImportService.preview(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, preview: result });
};

/** POST /ledger-core/migration-imports/:id/commit — OWNER/ADMIN only. */
export const commit: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const { import: imp, result } = await migrationImportService.commit(user.orgId, user.id, id);
  res.json({ success: true, import: imp, result });
};

/** DELETE /ledger-core/migration-imports/:id */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await migrationImportService.deleteImport(user.orgId, requireParam(req, 'id'));
  res.status(204).end();
};
