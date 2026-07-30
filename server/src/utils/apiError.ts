/**
 * The only error type a service or controller should throw for a condition the
 * client is allowed to see. Anything else reaching the error handler is treated
 * as an unexpected fault and reported as a generic 500 — an internal message
 * must never leak to a caller.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    // Drop the constructor frame so the stack points at the throw site.
    Error.captureStackTrace(this, ApiError);
  }
}
