export type ErrorDetails = Record<string, unknown>;

export class TiledMcpError extends Error {
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(code: string, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = "TiledMcpError";
    this.code = code;
    this.details = details;
  }
}

export function asTiledMcpError(error: unknown): TiledMcpError {
  if (error instanceof TiledMcpError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new TiledMcpError("INTERNAL_ERROR", message);
}
