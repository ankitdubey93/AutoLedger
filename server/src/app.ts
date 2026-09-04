import express, { type Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import apiRouter from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { attachRequestContext } from './middleware/requestContext.js';
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

  // `credentials: true` is required for the httpOnly refresh cookie in Phase 1,
  // and it forbids a wildcard origin, so FRONTEND_URL is mandatory.
  app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));

  // Populates `req.cookies`, which the auth middleware reads the access token
  // from. Must run before any route that authenticates. Unsigned: the tokens
  // are JWTs and carry their own signature, so cookie signing would only add a
  // second secret to manage.
  app.use(cookieParser());

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use(API_BASE_PATH, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
