export const DEFAULT_RASTER_RENDER_EDGE = 1_400;
export const MAX_RASTER_RENDER_EDGE = 2_048;
/**
 * The stdio transport buffers one whole JSON-RPC message before dispatching it.
 * MCP TypeScript SDK >= 1.30 caps that buffer at 10 MiB
 * (`STDIO_DEFAULT_MAX_BUFFER_SIZE`) and throws once a single message exceeds it.
 * The client transport turns that throw into `onerror` followed by `close()`,
 * so an oversized response drops the whole session rather than failing the one
 * call that produced it.
 */
export const STDIO_INBOUND_MESSAGE_LIMIT_BYTES =
  10 * 1_024 * 1_024;

/**
 * Inline image content ships base64-encoded, which inflates the payload to 4/3
 * of the raw PNG, so the encoded size is what has to fit inside
 * `STDIO_INBOUND_MESSAGE_LIMIT_BYTES` alongside the JSON-RPC envelope,
 * `structuredContent`, and the text summary. At 7 MiB the encoded image is
 * ~9.33 MiB, leaving ~683 KiB for the rest of the message.
 *
 * `tests/rasterContract.test.ts` pins that arithmetic, and holds every producer
 * budget that feeds `imageToolResult` to the same ceiling so the three cannot
 * drift apart.
 */
export const MAX_RASTER_PNG_BYTES =
  7 * 1_024 * 1_024;
export const MAX_RASTER_INPUT_IMAGES = 64;
export const MAX_RASTER_INPUT_AGGREGATE_BYTES =
  64 * 1_024 * 1_024;
export const MAX_RASTER_INPUT_AGGREGATE_PIXELS =
  16_000_000;
export const MAX_RASTER_INPUT_EDGE = 8_192;
export const MAX_RENDERER_VERSION_LENGTH =
  1_024;
export const RASTER_RENDER_PROFILE =
  "tmxrasterizer-png-v1" as const;
export const RASTER_SNAPSHOT_CONSISTENCY =
  "non-atomic-read-set" as const;
