import express, { type Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import apiRouter from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { attachRequestContext } from './middleware/requestContext.js';
import { requireTrustedOrigin } from './middleware/originCheck.js';
import { env } from './config/env.js';
import { API_BASE_PATH, JSON_BODY_LIMIT } from './config/constants.js';

/**
 * Builds the app without binding a port, so tests can drive it through
 * supertest and `index.ts` owns the process lifecycle. Middleware order is
 * load-bearing: parsers before routes, 404 after all routes, error handler last.
 */
export function createApp(): Express {
  const app = express();

  // Removes the default `X-Powered-By: Express` header — free version disclosure.
  app.disable('x-powered-by');

  // Opens the AsyncLocalStorage context Phase 5's audit trail reads the actor
  // and IP from — first, before anything else, so even a 404 or a CORS
  // rejection is still a request with a context waiting for it.
  app.use(attachRequestContext);

  // Security headers (2026-09-29): HSTS, X-Content-Type-Options: nosniff,
  // X-Frame-Options, Referrer-Policy: no-referrer (a reset link's token must
  // not leak through Referer), a restrictive Content-Security-Policy and the
  // cross-origin isolation headers. Defaults are right for a JSON API whose
  // browser client reads every response through CORS-mode fetch.
  app.use(helmet());

  // `credentials: true` is required for the httpOnly refresh cookie in Phase 1,
  // and it forbids a wildcard origin, so FRONTEND_URL is mandatory.
  // `X-Request-Id` is exposed so the client can quote it when reporting a problem.
  app.use(cors({ origin: env.FRONTEND_URL, credentials: true, exposedHeaders: ['X-Request-Id', 'Content-Disposition'] }));

  // After CORS (which answers preflights), before any route that changes state.
  app.use(requireTrustedOrigin);

  // Populates `req.cookies`, which the auth middleware reads the access token
  // from. Must run before any route that authenticates. Unsigned: the tokens
  // are JWTs and carry their own signature, so cookie signing would only add a
  // second secret to manage.
  app.use(cookieParser());

  // Phase 39c — Stripe signs the exact bytes it sends, so its webhook gets
  // the raw body. Mounted first: express.json then sees an already-read body
  // and leaves it alone.
  app.use(`${API_BASE_PATH}/public/stripe/webhook`, express.raw({ type: 'application/json', limit: JSON_BODY_LIMIT }));

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use(API_BASE_PATH, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
