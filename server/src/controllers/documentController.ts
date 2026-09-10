import type { RequestHandler } from 'express';
import * as documentService from '../services/documentService.js';
import { attachDocumentSchema } from '../schemas/documentSchema.js';
import { parseBody } from '../utils/parseBody.js';
import { requireUser } from '../utils/requireUser.js';
import { requireParam } from '../utils/routeParam.js';
import { optionalText, optionalUuid, readPagination } from '../utils/queryParam.js';
import { ApiError } from '../utils/apiError.js';

/** Thin adapters over documentService. Zero SQL (guardrails rule 2). */

/** Strips characters that would make a filename dangerous inside a header. */
function safeFilename(name: string): string {
  return name.replace(/["\\\r\n\x00-\x1f]/g, '');
}

/** POST /documents — multipart, field name "file". */
export const upload: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  if (req.file === undefined) {
    throw new ApiError(400, 'Send exactly one file in a field named "file"');
  }
  const { document, created } = await documentService.uploadDocument(user.orgId, user.id, {
    buffer: req.file.buffer,
    originalname: req.file.originalname,
  });
  res.status(created ? 201 : 200).json({ success: true, document, created });
};

/** GET /documents */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);
  const { documents, totalCount, currentPage, totalPages } = await documentService.listDocuments(
    user.orgId,
    {
      appSlug: optionalText(req, 'appSlug', 40),
      entityType: optionalText(req, 'entityType', 40),
      entityId: optionalUuid(req, 'entityId'),
      page,
      limit,
    },
  );
  res.json({ success: true, count: documents.length, totalCount, currentPage, totalPages, documents });
};

/** GET /documents/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const document = await documentService.getDocumentById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, document });
};

/** GET /documents/:id/file */
export const download: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { document, stream } = await documentService.openDocumentStream(
    user.orgId,
    requireParam(req, 'id'),
  );
  res.setHeader('Content-Type', document.mimeType);
  res.setHeader('Content-Length', String(document.byteSize));
  // The two headers that stop a stored file from becoming stored XSS: never
  // render it inline, and never let the browser re-sniff a type we already
  // decided from magic bytes.
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeFilename(document.originalFilename)}"`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
};

/** DELETE /documents/:id */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await documentService.deleteDocument(user.orgId, requireParam(req, 'id'));
  res.status(204).end();
};

/** POST /documents/:id/links */
export const attach: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(attachDocumentSchema, req.body);
  const link = await documentService.attachDocument(
    user.orgId,
    requireParam(req, 'id'),
    user.id,
    input,
  );
  res.status(201).json({ success: true, link });
};

/** DELETE /documents/:id/links/:linkId */
export const detach: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await documentService.detachDocument(
    user.orgId,
    requireParam(req, 'id'),
    requireParam(req, 'linkId'),
  );
  res.status(204).end();
};
