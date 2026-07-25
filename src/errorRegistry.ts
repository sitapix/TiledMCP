export const TILED_MCP_ERROR_CODE_CONTRACT_NAME =
  "tiled-mcp-error-codes" as const;
export const TILED_MCP_ERROR_CODE_CONTRACT_VERSION =
  1 as const;

/**
 * Explicit public allowlist for the tool application-error envelope.
 *
 * New internal identifiers are deliberately not public by default: adding one
 * requires placing it in this list or the non-application classification below.
 */
export const TILED_MCP_APPLICATION_ERROR_CODES =
  Object.freeze([
    "ASSET_REGISTRY_CORRUPT",
    "ASSET_REGISTRY_LIMIT_EXCEEDED",
    "CHANGE_SET_LIMIT_EXCEEDED",
    "CHANGE_SET_NOT_FOUND",
    "CHECKPOINT_CHANGED",
    "CHECKPOINT_CORRUPT",
    "CHECKPOINT_NOT_COMMITTED",
    "CHECKPOINT_NOT_FOUND",
    "CHECKPOINT_QUOTA_EXCEEDED",
    "CHECKPOINT_STATE_CONFLICT",
    "DEPENDENCY_REVISION_CONFLICT",
    "DOCUMENT_CHANGED_DURING_READ",
    "DOCUMENT_TOO_LARGE",
    "DUPLICATE_JSON_KEY",
    "DUPLICATE_LAYER_TARGET_IN_SOURCE_SUBTREE",
    "EXTERNAL_REFERENCE_NOT_ALLOWED",
    "FILE_ALREADY_EXISTS",
    "FILE_LOCKED",
    "FILE_LOCK_CORRUPT",
    "FILE_NOT_FOUND",
    "GID_OUT_OF_RANGE",
    "GID_RANGE_EXHAUSTED",
    "IMAGE_CHANGED_DURING_READ",
    "IMAGE_DIMENSIONS_EXCEEDED",
    "IMAGE_ENCODING_FAILED",
    "IMAGE_TOO_LARGE",
    "INTERNAL_ERROR",
    "INVALID_ARGUMENT",
    "INVALID_DOCUMENT",
    "INVALID_GID",
    "INVALID_JSON",
    "INVALID_PROJECT_PATH",
    "INVALID_TILESET_ATLAS",
    "INVALID_TILESET_IMAGE",
    "INVALID_TILE_DATA",
    "INVALID_TILE_TRANSFORM",
    "JSON_NESTING_LIMIT",
    "LAYER_DEPTH_EXCEEDED",
    "LAYER_HAS_DESCENDANTS",
    "LAYER_ID_EXHAUSTED",
    "LAYER_INDEX_OUT_OF_RANGE",
    "LAYER_LIMIT_EXCEEDED",
    "LAYER_MOVE_CYCLE",
    "LAYER_NOT_FOUND",
    "LAYER_TYPE_MISMATCH",
    "NEXT_LAYER_ID_INVALID",
    "NEXT_OBJECT_ID_INVALID",
    "OBJECT_ID_EXHAUSTED",
    "OBJECT_IN_USE",
    "OBJECT_LIMIT_EXCEEDED",
    "OBJECT_NOT_FOUND",
    "OBJECT_REFERENCE_NOT_FOUND",
    "OBJECT_SHAPE_MISMATCH",
    "OVERLAY_TOO_DENSE",
    "PAGE_OUT_OF_RANGE",
    "PARENT_DIRECTORY_NOT_FOUND",
    "PATH_OUTSIDE_ROOT",
    "PREVIEW_DIMENSIONS_EXCEEDED",
    "PREVIEW_REGION_REQUIRED",
    "RASTER_TEMP_CLEANUP_FAILED",
    "REGION_OUT_OF_BOUNDS",
    "RESERVED_PROJECT_PATH",
    "RESULT_LIMIT_EXCEEDED",
    "REVERT_WOULD_DELETE",
    "REVISION_CONFLICT",
    "STALE_FILE_LOCK",
    "SYMLINK_NOT_ALLOWED",
    "TILESET_ALREADY_REFERENCED",
    "TILESET_GID_RANGE_OVERLAP",
    "TILESET_IMAGE_DIMENSION_MISMATCH",
    "TILESET_IN_USE",
    "TILESET_NOT_FOUND",
    "TILESET_NOT_IN_MAP",
    "TILE_ID_OUT_OF_RANGE",
    "TMXRASTERIZER_FAILED",
    "TMXRASTERIZER_NOT_EXECUTABLE",
    "TMXRASTERIZER_NOT_FOUND",
    "TMXRASTERIZER_OUTPUT_INVALID",
    "TMXRASTERIZER_OUTPUT_LIMIT",
    "TMXRASTERIZER_OUTPUT_MISSING",
    "TMXRASTERIZER_TIMEOUT",
    "UNSAFE_JSON_NUMBER",
    "UNSAFE_RENDER_REFERENCE",
    "UNSAFE_SVG",
    "UNSORTED_TILESET_REFERENCES",
    "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
    "UNSUPPORTED_DUPLICATE_TEMPLATE",
    "UNSUPPORTED_FORMAT",
    "UNSUPPORTED_IMAGE_FORMAT",
    "UNSUPPORTED_MAP_PROFILE",
    "UNSUPPORTED_OBJECT_PROFILE",
    "UNSUPPORTED_OBJECT_REFERENCE_ANALYSIS",
    "UNSUPPORTED_PROPERTY_QUERY",
    "UNSUPPORTED_RENDER_FEATURE",
    "UNSUPPORTED_RENDER_LAYER",
    "UNSUPPORTED_TILESET",
    "UNSUPPORTED_TILESET_REMOVAL_TEMPLATE",
    "UNSUPPORTED_TILE_ENCODING",
  ] as const);

/**
 * Explicit non-application classification. These identifiers remain available
 * to startup, capability-probe, and internal-invariant code, but the tool
 * boundary never publishes them as application error codes.
 */
const NON_APPLICATION_ERROR_CODES = Object.freeze([
  "ASSET_ID_COLLISION",
  "CHANGE_SET_TAMPERED",
  "INVALID_CHANGE_SET",
  "INVALID_INTERNAL_PATH",
  "INVALID_PROJECT_ROOT",
  "JSON_SOURCE_PATCH_DELETION_MISMATCH",
  "JSON_SOURCE_PATCH_DUPLICATE_PATH",
  "JSON_SOURCE_PATCH_INSERTION_MISMATCH",
  "JSON_SOURCE_PATCH_INVALID_PATH",
  "JSON_SOURCE_PATCH_MISMATCH",
  "JSON_SOURCE_PATCH_MOVE_MISMATCH",
  "JSON_SOURCE_PATCH_OBJECT_MISMATCH",
  "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
  "JSON_SOURCE_PATCH_PATH_NOT_FOUND",
  "JSON_SOURCE_PATCH_TARGET_INVALID",
  "PROJECT_ROOT_REQUIRED",
  "TILED_CLI_FAILED",
  "TILED_CLI_NOT_EXECUTABLE",
  "TILED_CLI_NOT_FOUND",
  "TILED_CLI_OUTPUT_LIMIT",
  "TILED_CLI_TIMEOUT",
  "TILED_CLI_UNEXPECTED_OUTPUT",
  "TMXRASTERIZER_UNEXPECTED_OUTPUT",
] as const);

type NonApplicationErrorCode =
  (typeof NON_APPLICATION_ERROR_CODES)[number];
export type TiledMcpApplicationErrorCode =
  (typeof TILED_MCP_APPLICATION_ERROR_CODES)[number];
export type TiledMcpErrorCode =
  | TiledMcpApplicationErrorCode
  | NonApplicationErrorCode;

/**
 * Closed internal vocabulary accepted by TiledMcpError. It is derived from the
 * two explicit, mutually exclusive surface classifications above.
 */
export const TILED_MCP_ERROR_CODES =
  Object.freeze(
    [
      ...TILED_MCP_APPLICATION_ERROR_CODES,
      ...NON_APPLICATION_ERROR_CODES,
    ].sort(),
  );

const tiledMcpErrorCodeSet =
  new Set<string>(TILED_MCP_ERROR_CODES);
const tiledMcpApplicationErrorCodeSet =
  new Set<string>(
    TILED_MCP_APPLICATION_ERROR_CODES,
  );

export const TILED_MCP_CAPABILITY_ISSUE_CODES =
  Object.freeze([
    "INTERNAL_ERROR",
    "TILED_CLI_FAILED",
    "TILED_CLI_NOT_EXECUTABLE",
    "TILED_CLI_NOT_FOUND",
    "TILED_CLI_OUTPUT_LIMIT",
    "TILED_CLI_TIMEOUT",
    "TILED_CLI_UNEXPECTED_OUTPUT",
    "TMXRASTERIZER_FAILED",
    "TMXRASTERIZER_NOT_EXECUTABLE",
    "TMXRASTERIZER_NOT_FOUND",
    "TMXRASTERIZER_OUTPUT_LIMIT",
    "TMXRASTERIZER_TIMEOUT",
    "TMXRASTERIZER_UNEXPECTED_OUTPUT",
  ] as const satisfies readonly TiledMcpErrorCode[]);

export type TiledMcpCapabilityIssueCode =
  (typeof TILED_MCP_CAPABILITY_ISSUE_CODES)[number];

const tiledMcpCapabilityIssueCodeSet =
  new Set<string>(
    TILED_MCP_CAPABILITY_ISSUE_CODES,
  );

export function isTiledMcpErrorCode(
  value: unknown,
): value is TiledMcpErrorCode {
  return (
    typeof value === "string" &&
    tiledMcpErrorCodeSet.has(value)
  );
}

export function isTiledMcpApplicationErrorCode(
  value: unknown,
): value is TiledMcpApplicationErrorCode {
  return (
    typeof value === "string" &&
    tiledMcpApplicationErrorCodeSet.has(value)
  );
}

export function isTiledMcpCapabilityIssueCode(
  value: unknown,
): value is TiledMcpCapabilityIssueCode {
  return (
    typeof value === "string" &&
    tiledMcpCapabilityIssueCodeSet.has(value)
  );
}

export const TILED_MCP_APPLICATION_ERROR_REGISTRY =
  Object.freeze({
    format:
      "tiled-mcp-application-error-registry",
    formatVersion: 1,
    name: TILED_MCP_ERROR_CODE_CONTRACT_NAME,
    registryVersion:
      TILED_MCP_ERROR_CODE_CONTRACT_VERSION,
    wireLocation:
      "structuredContent.result.error",
    codeLocation:
      "structuredContent.result.error.code",
    fallbackCode: "INTERNAL_ERROR",
    compatibility: Object.freeze({
      existingIdentifiersAndMeanings:
        "stable-within-registry-v1",
      additions:
        "new-server-versions-may-add-codes",
      clientUnknownCodePolicy:
        "handle-as-unknown-and-refresh-discovery",
    } as const),
    messages:
      "bounded-human-readable-not-stable-for-control-flow",
    details:
      "bounded-opaque-no-stable-fields-in-v1",
    excludedSurfaces: Object.freeze([
      "mcp-sdk-input-errors",
      "cli-capability-probe-issues",
      "startup-fatal-errors",
      "validation-diagnostics",
      "checkpoint-reconciliation-diagnostics",
      "operating-system-error-codes",
    ] as const),
    codes: TILED_MCP_APPLICATION_ERROR_CODES,
  } as const);

export const TILED_MCP_APPLICATION_ERROR_REGISTRY_JSON =
  `${JSON.stringify(
    TILED_MCP_APPLICATION_ERROR_REGISTRY,
    null,
    2,
  )}\n`;
