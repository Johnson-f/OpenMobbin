export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

export function safeError(error: unknown, secrets: readonly string[] = []): { code: string; message: string; retryable: boolean } {
  const source = error instanceof AppError
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unexpected error", retryable: false };
  return {
    ...source,
    message: secrets.filter(Boolean).reduce((message, secret) => message.replaceAll(secret, "[redacted]"), source.message),
  };
}
