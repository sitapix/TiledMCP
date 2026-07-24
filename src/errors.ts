import {
  isTiledMcpErrorCode,
  type TiledMcpErrorCode,
} from "./errorRegistry.js";

export type ErrorDetails = Record<string, unknown>;

export class TiledMcpError extends Error {
  readonly code: TiledMcpErrorCode;
  readonly details: ErrorDetails;

  constructor(
    code: TiledMcpErrorCode,
    message: string,
    details: ErrorDetails = {},
  ) {
    super(message);
    this.name = "TiledMcpError";
    if (isTiledMcpErrorCode(code)) {
      this.code = code;
      this.details = details;
    } else {
      this.code = "INTERNAL_ERROR";
      this.details = {};
    }
  }
}

export function asTiledMcpError(error: unknown): TiledMcpError {
  if (error instanceof TiledMcpError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new TiledMcpError("INTERNAL_ERROR", message);
}
