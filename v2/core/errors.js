// Every error that leaves the API goes through toHttpError(), so clients always get
// the same shape: { error: { code, message, details?, requestId } }.

export class CalmError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code Stable machine readable code, e.g. "NOT_FOUND"
   * @param {string} message Human readable message, safe to show to API clients
   * @param {Record<string, string>} [details] Per-field messages
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'CalmError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

export const badRequest = (message = 'Bad request', details) => new CalmError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required') => new CalmError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have permission to do this') => new CalmError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Resource not found') => new CalmError(404, 'NOT_FOUND', message);
export const conflict = (message = 'Resource already exists', details) => new CalmError(409, 'CONFLICT', message, details);
export const validationError = (details, message = 'Validation failed') =>
  new CalmError(422, 'VALIDATION_ERROR', message, details);
export const tooManyRequests = (message = 'Too many requests, slow down') => new CalmError(429, 'RATE_LIMITED', message);

/**
 * Translate anything thrown inside a request into a CalmError.
 * Unknown errors become a generic 500: internal messages never reach the client.
 */
export function toHttpError(err) {
  if (err instanceof CalmError) return err;

  // Express body parser errors
  if (err?.type === 'entity.parse.failed') return new CalmError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  if (err?.type === 'entity.too.large') return new CalmError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  if (err?.status === 400 && err?.expose) return badRequest(err.message);

  // Mongoose
  if (err?.name === 'CastError') {
    return err.path === '_id'
      ? notFound()
      : validationError({ [err.path]: `Invalid value for ${err.path}` });
  }
  if (err?.name === 'ValidationError' && err.errors) {
    const details = {};
    for (const [path, e] of Object.entries(err.errors)) details[path] = e.message;
    return validationError(details);
  }
  if (err?.code === 11000) {
    const field = Object.keys(err.keyValue ?? err.keyPattern ?? {})[0];
    return field ? conflict(`${field} already exists`, { [field]: 'Already taken' }) : conflict();
  }

  return new CalmError(500, 'INTERNAL_ERROR', 'Something went wrong');
}
