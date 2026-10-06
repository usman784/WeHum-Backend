export const ErrorCodes = {
  VALIDATION_FAILED: 400,
  AUTH_REQUIRED: 401, TOKEN_EXPIRED: 401, TOKEN_INVALID: 401, TOKEN_REUSED: 401, MFA_REQUIRED: 401, INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403, ATTESTATION_FAILED: 403, PREMIUM_REQUIRED: 403, ACCOUNT_REQUIRED: 403, MEDITATION_REQUIRED: 403, MUTED: 403,
  NOT_FOUND: 404, FEATURE_OFF: 404,
  CONFLICT_VERSION: 409, ACCOUNT_EXISTS: 409, ALREADY_EXISTS: 409, IN_USE: 409,
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  DEDICATION_LINKS: 422, MEDIA_NOT_READY: 422, YOUTUBE_UNAVAILABLE: 422, INVALID_STATE: 422,
  UPDATE_REQUIRED: 426,
  RATE_LIMITED: 429, DEDICATION_LIMIT: 429,
  INTERNAL: 500,
  MAINTENANCE: 503, DEPENDENCY_DOWN: 503,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

/** Throw this everywhere; the filter turns it into { error: { code, message, details, traceId } }. */
export class AppError extends Error {
  constructor(public readonly code: ErrorCode, message?: string, public readonly details?: unknown, public readonly headers?: Record<string, string>) {
    super(message ?? code);
  }
  get status(): number { return ErrorCodes[this.code]; }
}
