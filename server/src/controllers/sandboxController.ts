import type { RequestHandler } from 'express';
import * as sandboxService from '../services/sandbox/sandboxService.js';
import { requireUser } from '../utils/requireUser.js';

/** Thin adapters over sandboxService. Zero SQL (guardrails rule 2). */

/** GET /sandbox */
export const status: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const sandbox = await sandboxService.getSandboxStatus(user.orgId);
  res.status(200).json({ success: true, sandbox });
};

/** POST /sandbox/load */
export const load: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const dataset = await sandboxService.loadSandbox(user.orgId, user.id);
  res.status(201).json({ success: true, dataset });
};

/** DELETE /sandbox */
export const unload: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await sandboxService.unloadSandbox(user.orgId);
  res.status(200).json({ success: true });
};
