import type { RequestHandler } from 'express';
import * as healthService from '../services/healthService.js';
import { API_VERSION } from '../config/constants.js';
import { env } from '../config/env.js';

/**
 * Thin adapter: call the service, choose a status code, shape the body.
 * No SQL, no logic — docs/guardrails.md rule 2.
 */
export const getHealth: RequestHandler = async (_req, res) => {
  const [db, redis] = await Promise.all([healthService.checkDatabase(), healthService.checkRedis()]);

  // 503 only when the database is unreachable — every read endpoint still
  // works with Redis down, so that alone must not fail health checks;
  // only job processing stops. A health endpoint that answers 200 while its
  // primary datastore is down is worse than no health endpoint, but Redis
  // is secondary infrastructure, not the primary datastore.
  const statusCode = db.connected ? 200 : 503;
  const status = db.connected && redis.connected ? 'ok' : 'degraded';

  res.status(statusCode).json({
    success: db.connected,
    ...(!db.connected
      ? { error: 'Database unreachable' }
      : !redis.connected
        ? { error: 'Redis unreachable — background jobs are not running' }
        : {}),
    status,
    service: 'autoledger-server',
    apiVersion: API_VERSION,
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    db,
    redis,
  });
};
