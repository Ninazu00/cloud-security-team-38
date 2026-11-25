// One error shape for the whole API, decided once in the contract:
//   { "error": { "code": "ROOM_CONFLICT", "message": "...", "requestId": "..." } }
// Clients branch on `code`; `message` is for humans and may change. Anything
// thrown that is not an ApiError is treated as a bug and reported as INTERNAL,
// with the real message only in the log.

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code stable, screaming-snake identifier from the contract
   * @param {string} message human-readable explanation, safe to show
   * @param {object} [details] structured extras (conflicting ids, field errors)
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, message, details) => new ApiError(400, code, message, details);
export const unauthorized = (code, message, details) => new ApiError(401, code, message, details);
export const forbidden = (code, message, details) => new ApiError(403, code, message, details);
export const notFound = (code, message, details) => new ApiError(404, code, message, details);
export const conflict = (code, message, details) => new ApiError(409, code, message, details);
export const gone = (code, message, details) => new ApiError(410, code, message, details);
export const payloadTooLarge = (code, message, details) => new ApiError(413, code, message, details);
export const unsupportedMediaType = (code, message, details) => new ApiError(415, code, message, details);
export const unprocessable = (code, message, details) => new ApiError(422, code, message, details);
export const locked = (code, message, details) => new ApiError(423, code, message, details);
export const tooManyRequests = (code, message, details) => new ApiError(429, code, message, details);
export const unavailable = (code, message, details) => new ApiError(503, code, message, details);

export function errorBody(code, message, requestId, details) {
  const body = { error: { code, message, requestId } };
  if (details !== undefined) body.error.details = details;
  return body;
}
