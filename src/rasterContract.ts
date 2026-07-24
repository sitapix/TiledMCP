export const DEFAULT_RASTER_RENDER_EDGE = 1_400;
export const MAX_RASTER_RENDER_EDGE = 2_048;
export const MAX_RASTER_PNG_BYTES =
  8 * 1_024 * 1_024;
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
