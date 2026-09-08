import type { RequestHandler } from 'express';
import * as webhookService from '../services/webhookService.js';
import { createEndpointSchema, updateEndpointSchema } from '../schemas/webhookSchema.js';
import { parseBody } from '../utils/parseBody.js';
import { requireUser } from '../utils/requireUser.js';
import { requireParam } from '../utils/routeParam.js';

/** Thin adapters over webhookService. Zero SQL (guardrails rule 2). */

const SECRET_NOTICE = 'Store this secret now — it is shown once and cannot be retrieved again.';

/** GET /webhooks */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const endpoints = await webhookService.listEndpoints(user.orgId);
  res.json({ success: true, count: endpoints.length, endpoints });
};

/** GET /webhooks/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const endpoint = await webhookService.getEndpointById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, endpoint });
};

/** POST /webhooks */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createEndpointSchema, req.body);
  const endpoint = await webhookService.createEndpoint(user.orgId, user.id, input);
  res.status(201).json({ success: true, endpoint, secretNotice: SECRET_NOTICE });
};

/** PATCH /webhooks/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateEndpointSchema, req.body);
  const endpoint = await webhookService.updateEndpoint(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, endpoint });
};

/** DELETE /webhooks/:id */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await webhookService.deleteEndpoint(user.orgId, requireParam(req, 'id'));
  res.status(204).end();
};

/** POST /webhooks/:id/rotate-secret */
export const rotate: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const endpoint = await webhookService.rotateSecret(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, endpoint, secretNotice: SECRET_NOTICE });
};
