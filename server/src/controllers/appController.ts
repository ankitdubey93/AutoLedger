import type { RequestHandler } from 'express';
import * as appService from '../services/appService.js';

/** GET /apps — the suite's app registry. Thin adapter, zero SQL (guardrails rule 2). */
export const listApps: RequestHandler = (_req, res) => {
  const apps = appService.listApps();
  res.json({ success: true, count: apps.length, apps });
};
