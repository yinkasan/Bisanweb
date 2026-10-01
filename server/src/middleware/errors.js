import { isTransientConnectionError } from '../db/connectionError.js';

/** Application error with an HTTP status code. */
export class ApiError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new ApiError(400, msg, details);
export const unauthorized = (msg = 'Authentication required') => new ApiError(401, msg);
export const forbidden = (msg = 'You do not have permission to perform this action') => new ApiError(403, msg);
export const notFound = (msg = 'Record not found') => new ApiError(404, msg);
export const conflict = (msg) => new ApiError(409, msg);

/** Wraps an async route handler so rejections reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  // PostgreSQL unique violation
  if (err?.code === '23505') {
    return res.status(409).json({ error: 'A record with these details already exists' });
  }
  // PostgreSQL check violation
  if (err?.code === '23514') {
    return res.status(400).json({ error: 'Value violates a database constraint' });
  }
  // Hosted database unreachable (idle pooler socket, project still resuming).
  // Retryable infrastructure condition, not a request or code fault.
  if (isTransientConnectionError(err)) {
    // eslint-disable-next-line no-console
    console.warn('[error] transient database connection failure:', err.message);
    return res
      .status(503)
      .json({ error: 'The database is unavailable right now, it may be waking up. Please try again in a moment.' });
  }
  // eslint-disable-next-line no-console
  console.error('[error]', err);
  return res.status(500).json({ error: 'Internal server error' });
}
