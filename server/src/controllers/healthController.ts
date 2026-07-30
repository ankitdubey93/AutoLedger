import type { RequestHandler } from 'express';
import * as healthService from '../services/healthService.js';
import { API_VERSION } from '../config/constants.js';
import { env } from '../config/env.js';

/**
 * Thin adapter: call the service, choose a status code, shape the body.
 * No SQL, no logic — docs/guardrails.md rule 1.
 */
export const getHealth: RequestHandler = async (_req, res) => {
  const db = await healthService.checkDatabase();

  // 503 when the database is unreachable. A health endpoint that answers 200
  // while its datastore is down is worse than no health endpoint.
  res.status(db.connected ? 200 : 503).json({
    success: db.connected,
    ...(db.connected ? {} : { error: 'Database unreachable' }),
    status: db.connected ? 'ok' : 'degraded',
    service: 'autoledger-server',
    apiVersion: API_VERSION,
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    db,
  });
};
