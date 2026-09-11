import type { RequestHandler } from 'express';
import * as apFlowDocumentService from '../../services/ap-flow/apFlowDocumentService.js';
import * as postingService from '../../services/ap-flow/postingService.js';
import { createApFlowDocumentSchema } from '../../schemas/ap-flow/documentSchema.js';
import { updateLineItemSchema } from '../../schemas/ap-flow/lineItemSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { readPagination } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';
import { isApFlowDocumentStatus } from '../../types/ap-flow.js';

/** Thin adapters over apFlowDocumentService. Zero SQL (guardrails rule 2). */

/** POST /ap-flow/documents */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createApFlowDocumentSchema, req.body);
  const document = await apFlowDocumentService.createApFlowDocument(user.orgId, user.id, input);
  res.status(201).json({ success: true, document });
};

/** GET /ap-flow/documents */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);
  const rawStatus = req.query.status;
  let status = null;
  if (typeof rawStatus === 'string' && rawStatus !== '') {
    if (!isApFlowDocumentStatus(rawStatus)) {
      throw new ApiError(400, 'Unknown status filter');
    }
    status = rawStatus;
  }

  const { documents, totalCount, currentPage, totalPages } = await apFlowDocumentService.listApFlowDocuments(
    user.orgId,
    { status, page, limit },
  );
  res.json({ success: true, count: documents.length, totalCount, currentPage, totalPages, documents });
};

/** GET /ap-flow/documents/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const document = await apFlowDocumentService.getApFlowDocumentById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, document });
};

/** GET /ap-flow/documents/:id/pages/:pageNumber/image */
export const pageImage: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const pageNumberRaw = Number(requireParam(req, 'pageNumber'));
  if (!Number.isInteger(pageNumberRaw) || pageNumberRaw < 1) {
    throw new ApiError(400, 'Invalid page number');
  }
  const { stream, byteSize } = await apFlowDocumentService.openPageImage(
    user.orgId,
    requireParam(req, 'id'),
    pageNumberRaw,
  );
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Length', String(byteSize));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
};

/** POST /ap-flow/documents/:id/reextract */
export const reextract: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const document = await apFlowDocumentService.requestReextraction(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, document });
};

/**
 * POST /ap-flow/documents/:id/post
 *
 * No request body — there is nothing for the caller to supply, and
 * accepting a sourceType/entryDate from the body would let a client forge
 * provenance (docs/api.md's rule on journal_entries.source_type/source_id).
 */
export const post: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const document = await postingService.postApFlowDocument(user.orgId, user.id, requireParam(req, 'id'));
  res.json({ success: true, document });
};

/** GET /ap-flow/review-queue */
export const reviewQueue: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);
  const { entries, totalCount, currentPage, totalPages } = await apFlowDocumentService.listReviewQueue(
    user.orgId,
    { page, limit },
  );
  res.json({ success: true, count: entries.length, totalCount, currentPage, totalPages, entries });
};

/** PATCH /ap-flow/documents/:id/line-items/:lineId */
export const updateLineItem: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateLineItemSchema, req.body);
  const document = await apFlowDocumentService.updateLineItemAccount(
    user.orgId,
    requireParam(req, 'id'),
    requireParam(req, 'lineId'),
    input.accountId,
  );
  res.json({ success: true, document });
};
