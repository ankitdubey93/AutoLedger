import type { RequestHandler } from 'express';
import * as captureDocumentService from '../../services/capture/captureDocumentService.js';
import * as postingService from '../../services/capture/postingService.js';
import { createCaptureDocumentSchema } from '../../schemas/capture/documentSchema.js';
import { updateLineItemSchema } from '../../schemas/capture/lineItemSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { readPagination } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';
import { isCaptureDocumentStatus } from '../../types/capture.js';

/** Thin adapters over captureDocumentService. Zero SQL (guardrails rule 2). */

/** POST /capture/documents */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createCaptureDocumentSchema, req.body);
  const document = await captureDocumentService.createCaptureDocument(user.orgId, user.id, input);
  res.status(201).json({ success: true, document });
};

/** POST /capture/documents/upload — multipart, field "file". */
export const upload: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  if (req.file === undefined) {
    throw new ApiError(400, 'Send exactly one file in a field named "file"');
  }
  const { document, created } = await captureDocumentService.captureFile(user.orgId, user.id, {
    buffer: req.file.buffer,
    originalname: req.file.originalname,
  });
  res.status(created ? 201 : 200).json({ success: true, document, created });
};

/** GET /capture/documents */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);
  const rawStatus = req.query.status;
  let status = null;
  if (typeof rawStatus === 'string' && rawStatus !== '') {
    if (!isCaptureDocumentStatus(rawStatus)) {
      throw new ApiError(400, 'Unknown status filter');
    }
    status = rawStatus;
  }

  const { documents, totalCount, currentPage, totalPages } = await captureDocumentService.listCaptureDocuments(
    user.orgId,
    { status, page, limit },
  );
  res.json({ success: true, count: documents.length, totalCount, currentPage, totalPages, documents });
};

/** GET /capture/documents/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const document = await captureDocumentService.getCaptureDocumentById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, document });
};

/** GET /capture/documents/:id/pages/:pageNumber/image */
export const pageImage: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const pageNumberRaw = Number(requireParam(req, 'pageNumber'));
  if (!Number.isInteger(pageNumberRaw) || pageNumberRaw < 1) {
    throw new ApiError(400, 'Invalid page number');
  }
  const { stream, byteSize } = await captureDocumentService.openPageImage(
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

/** POST /capture/documents/:id/reextract */
export const reextract: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const document = await captureDocumentService.requestReextraction(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, document });
};

/**
 * POST /capture/documents/:id/post
 *
 * No request body — there is nothing for the caller to supply, and
 * accepting a sourceType/entryDate from the body would let a client forge
 * provenance (docs/api.md's rule on journal_entries.source_type/source_id).
 */
export const post: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const document = await postingService.postCaptureDocument(user.orgId, user.id, requireParam(req, 'id'));
  res.json({ success: true, document });
};

/** GET /capture/review-queue */
export const reviewQueue: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);
  const { entries, totalCount, currentPage, totalPages } = await captureDocumentService.listReviewQueue(
    user.orgId,
    { page, limit },
  );
  res.json({ success: true, count: entries.length, totalCount, currentPage, totalPages, entries });
};

/** PATCH /capture/documents/:id/line-items/:lineId */
export const updateLineItem: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateLineItemSchema, req.body);
  const document = await captureDocumentService.updateLineItemAccount(
    user.orgId,
    requireParam(req, 'id'),
    requireParam(req, 'lineId'),
    input.accountId,
  );
  res.json({ success: true, document });
};
