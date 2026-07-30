import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ApiError } from '../utils/apiError.js';
import { env } from '../config/env.js';

/** Terminal 404: reached only when no earlier route matched. Mount last. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

/**
 * The single place an error response is shaped — docs/api.md: never hand-roll
 * one in a controller.
 *
 * Express identifies error middleware by **arity**: exactly four declared
 * parameters. `next` is unused here and must still be declared, or Express
 * registers this as ordinary middleware and errors sail past it.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ success: false, error: err.message });
    return;
  }

  // Unexpected: log the real thing server-side, tell the client nothing.
  console.error('[error] unhandled:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    ...(env.isProduction ? {} : { detail: err instanceof Error ? err.message : String(err) }),
  });
};
