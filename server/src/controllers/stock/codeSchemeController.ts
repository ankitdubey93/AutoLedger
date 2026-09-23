import type { RequestHandler } from 'express';
import * as codeSchemeService from '../../services/stock/codeSchemeService.js';
import {
  createCodeSchemeSchema,
  previewPatternSchema,
  updateCodeSchemeSchema,
} from '../../schemas/stock/codeSchemeSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/** Thin adapters over codeSchemeService. Zero SQL (guardrails rule 2). */

/** GET /stock/code-schemes */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const codeSchemes = await codeSchemeService.listCodeSchemes(user.orgId, req.query.includeInactive === 'true');
  res.json({ success: true, count: codeSchemes.length, codeSchemes });
};

/** GET /stock/code-schemes/presets */
export const presets: RequestHandler = (_req, res) => {
  const list = codeSchemeService.listPresets();
  res.json({ success: true, count: list.length, presets: list });
};

/** POST /stock/code-schemes/preview */
export const preview: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(previewPatternSchema, req.body);
  const result = await codeSchemeService.previewPattern(user.orgId, input);
  res.json({ success: true, ...result });
};

/** POST /stock/code-schemes */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createCodeSchemeSchema, req.body);
  const codeScheme = await codeSchemeService.createCodeScheme(user.orgId, user.id, input);
  res.status(201).json({ success: true, codeScheme });
};

/** PATCH /stock/code-schemes/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateCodeSchemeSchema, req.body);
  const codeScheme = await codeSchemeService.updateCodeScheme(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, codeScheme });
};
