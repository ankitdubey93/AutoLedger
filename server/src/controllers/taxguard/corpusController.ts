import type { RequestHandler } from 'express';
import * as corpusService from '../../services/taxguard/corpusService.js';
import { createCorpusSchema } from '../../schemas/taxguard/corpusSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/** Thin adapters over corpusService. Zero SQL (guardrails rule 2). */

/** GET /taxguard/corpus */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const corpusDocuments = await corpusService.listCorpusDocuments(user.orgId);
  res.json({ success: true, corpusDocuments });
};

/** GET /taxguard/corpus/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const corpusDocument = await corpusService.getCorpusDocumentById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, corpusDocument });
};

/** GET /taxguard/corpus/:id/chunks */
export const chunks: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const rows = await corpusService.listChunks(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, chunks: rows });
};

/** POST /taxguard/corpus */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createCorpusSchema, req.body);
  const corpusDocument = await corpusService.createCorpusDocument(user.orgId, user.id, input);
  res.status(201).json({ success: true, corpusDocument });
};

/** DELETE /taxguard/corpus/:id */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await corpusService.deleteCorpusDocument(user.orgId, requireParam(req, 'id'));
  res.status(204).send();
};
