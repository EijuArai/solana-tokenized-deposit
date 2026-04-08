export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  UNAUTHORIZED: "UNAUTHORIZED",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  WHITELIST_REQUIRED: "WHITELIST_REQUIRED",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  INTEGRATION_ERROR: "INTEGRATION_ERROR",
  RECONCILIATION_ERROR: "RECONCILIATION_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly details?: unknown;

  public constructor(
    code: ErrorCode,
    message: string,
    statusCode = 500,
    retryable = false,
    details?: unknown,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.details = details;
  }
}

export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof AppError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      },
    };
  }

  return {
    error: {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: "Unexpected internal error",
      retryable: false,
    },
  };
}
