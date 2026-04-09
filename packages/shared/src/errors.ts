export type VinkoErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "UPSTREAM_ERROR"
  | "INTERNAL_ERROR";

export class VinkoError extends Error {
  readonly code: VinkoErrorCode;
  readonly context?: Record<string, unknown> | undefined;

  constructor(message: string, code: VinkoErrorCode, context?: Record<string, unknown>) {
    super(message);
    this.name = "VinkoError";
    this.code = code;
    this.context = context;
  }
}

export function isVinkoError(error: unknown): error is VinkoError {
  return error instanceof VinkoError;
}

export function toErrorPayload(error: unknown): {
  code: VinkoErrorCode;
  message: string;
  context?: Record<string, unknown> | undefined;
} {
  if (isVinkoError(error)) {
    return {
      code: error.code,
      message: error.message,
      context: error.context
    };
  }
  if (error instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: error.message
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: String(error)
  };
}
