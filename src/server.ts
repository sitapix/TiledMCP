import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  McpServer,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import type {
  RenderPngResult,
  TiledCliAdapter,
  TiledCliCapabilities,
} from "./adapters/tiledCli.js";
import {
  ChangeSetRegistry,
  DEFAULT_MAX_PENDING_CELL_WRITES,
  DEFAULT_MAX_PENDING_OBJECT_SHAPE_POINTS,
  MAX_PENDING_TRANSACTIONS,
  MAX_TRANSACTION_MEMBERS,
  MIN_TRANSACTION_MEMBERS,
  type TransactionPlan,
} from "./changeSets.js";
import {
  TILED_MCP_APPLICATION_ERROR_REGISTRY,
  TILED_MCP_CAPABILITY_ISSUE_CODES,
  isTiledMcpApplicationErrorCode,
  type TiledMcpApplicationErrorCode,
} from "./errorRegistry.js";
import { TiledMcpError, asTiledMcpError } from "./errors.js";
import {
  TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT,
} from "./filesystemThreatModelContract.js";
import {
  DEFAULT_TILE_RENDER_COLUMNS,
  DEFAULT_TILE_RENDER_SCALE,
  DEFAULT_TILESET_SHEET_PAGE_SIZE,
  DEFAULT_TILESET_SHEET_SCALE,
  MAX_TILE_RENDER_BYTES,
  MAX_TILE_RENDER_COLUMNS,
  MAX_TILE_RENDER_EDGE,
  MAX_TILE_RENDER_LOCAL_IDS,
  MAX_TILE_RENDER_PIXELS,
  MAX_TILE_RENDER_SCALE,
  MAX_TILESET_IMAGE_BYTES,
  MAX_TILESET_INPUT_EDGE,
  MAX_TILESET_INPUT_PIXELS,
  MAX_TILESET_SHEET_BYTES,
  MAX_TILESET_SHEET_COLUMNS,
  MAX_TILESET_SHEET_EDGE,
  MAX_TILESET_SHEET_PAGE_SIZE,
  MAX_TILESET_SHEET_PIXELS,
  MAX_TILESET_SHEET_SCALE,
  MAX_SIMPLE_SVG_BYTES,
} from "./images/tilesetSheet.js";
import {
  DEFAULT_NATIVE_PREVIEW_SCALE,
  MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS,
  MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES,
  MAX_NATIVE_PREVIEW_BYTES,
  MAX_NATIVE_PREVIEW_EDGE,
  MAX_NATIVE_PREVIEW_HIGHLIGHTS,
  MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
  MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS_AGGREGATE,
  MAX_NATIVE_PREVIEW_OBJECTS,
  MAX_NATIVE_PREVIEW_OBJECT_POINTS,
  MAX_NATIVE_PREVIEW_PIXELS,
  MAX_NATIVE_PREVIEW_PIXEL_BLENDS,
  MAX_NATIVE_PREVIEW_SCALE,
  MIN_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
  NATIVE_PREVIEW_HIGHLIGHT_BLEND_MODE,
  NATIVE_PREVIEW_HIGHLIGHT_COLOR,
  NATIVE_PREVIEW_HIGHLIGHT_OVERLAP_MODE,
  NATIVE_PREVIEW_HIGHLIGHT_STYLE,
  NATIVE_PREVIEW_OBJECT_COLOR,
  NATIVE_PREVIEW_OBJECT_CURVE_MAX_ERROR_PIXELS,
  NATIVE_PREVIEW_OBJECT_CURVE_TESSELLATION,
  NATIVE_PREVIEW_OBJECT_DRAW_ORDER,
  NATIVE_PREVIEW_OBJECT_ORIGIN_MARKER,
  NATIVE_PREVIEW_OBJECT_PROFILE,
  NATIVE_PREVIEW_OBJECT_QUANTIZATION,
  NATIVE_PREVIEW_OBJECT_STROKE_WIDTH,
  NATIVE_PREVIEW_OBJECT_STYLE,
  NATIVE_PREVIEW_OBJECT_VISIBILITY_POLICY,
  NATIVE_PREVIEW_TILE_OBJECT_COLLISION,
  NATIVE_PREVIEW_TILE_OBJECT_FRAMES,
  MAX_NATIVE_PREVIEW_TILE_COLLISION_SHAPES,
  MAX_NATIVE_PREVIEW_TILE_COLLISION_SHAPES_AGGREGATE,
} from "./images/mapPreview.js";
import {
  DEFAULT_USAGE_TOP_TILE_LIMIT,
  MAX_ADD_TILESET_GID_SCANS,
  MAX_CELL_WRITES,
  MAX_MERGE_OFFSET,
  MAX_CREATE_MAP_DIMENSION,
  MAX_CREATE_MAP_TILE_EDGE,
  MAX_CREATE_TILE_LAYER_CELLS,
  MAX_DUPLICATE_LAYER_BYTES,
  MAX_FLOOD_FILL_SCANS,
  MAX_LAYER_NAME_LENGTH,
  MAX_MAP_CLASS_NAME_CODE_POINTS,
  MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET,
  MAX_OBJECT_SHAPE_POINTS,
  MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET,
  MAX_REMOVE_TILESET_GID_SCANS,
  MAX_REPLACE_TILE_MAPPINGS,
  MAX_REPLACE_TILE_SCANS,
  MAX_RESIZE_CROPPED_CELL_SAMPLE,
  MAX_RESIZE_MAP_DIMENSION,
  MAX_RESIZE_OFFSET_MAGNITUDE,
  MAX_RESIZE_SOURCE_CELL_SCANS,
  MAX_STAMP_PATTERN_CELLS,
  MAX_STAMP_PATTERN_EDGE,
  MAX_TILE_OPERATION_SCANS,
  MAX_TILESET_COUNT,
  MAX_USAGE_DISTINCT_TILES,
  MAX_USAGE_LAYER_SUMMARIES,
  MAX_USAGE_RESULT_BYTES,
  MAX_USAGE_SCAN_VALUES,
  MAX_USAGE_TILESET_SUMMARIES,
  MAX_USAGE_TOP_TILE_LIMIT,
  MAX_USAGE_UNUSED_LOCAL_ID_SAMPLE,
  MIN_POLYGON_OBJECT_POINTS,
  MIN_POLYLINE_OBJECT_POINTS,
  type AnalyzeUsageInput,
  type MapService,
} from "./maps/mapService.js";
import {
  DEFAULT_MAX_PENDING_TEXT_OBJECT_PAYLOAD_BYTES,
  MAX_TEXT_OBJECT_CONTENT_CODE_POINTS,
  MAX_TEXT_OBJECT_CONTENT_UTF8_BYTES,
  MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET,
  MAX_TEXT_OBJECT_FONT_FAMILY_CODE_POINTS,
  MAX_TEXT_OBJECT_FONT_FAMILY_UTF8_BYTES,
  MAX_TEXT_OBJECT_PIXEL_SIZE,
  MIN_TEXT_OBJECT_PIXEL_SIZE,
  TEXT_OBJECT_DEFAULTS,
  TEXT_OBJECT_FIELDS,
  TEXT_OBJECT_HORIZONTAL_ALIGNMENTS,
  TEXT_OBJECT_VERTICAL_ALIGNMENTS,
  measureTextObjectPayloadBytes,
} from "./maps/textObjects.js";
import {
  MAX_PREVIEW_ATLASES,
  MAX_PREVIEW_LAYER_LABEL_LENGTH,
  MAX_PREVIEW_LAYERS,
  MAX_PREVIEW_OMITTED_LAYERS,
  MAX_PREVIEW_REGION_CELLS,
  MAX_PREVIEW_TILE_DRAWS,
} from "./maps/previewScene.js";
import {
  DEFAULT_TILESET_METADATA_LIMIT,
  MAX_TILESET_ANIMATION_FRAMES,
  MAX_TILESET_ANIMATION_FRAME_SAMPLE,
  MAX_TILESET_COLLISION_OBJECTS,
  MAX_TILESET_DETAIL_DISPLAY_CODE_POINTS,
  MAX_TILESET_DETAIL_RESULT_BYTES,
  MAX_TILESET_METADATA_ENTRIES,
  MAX_TILESET_METADATA_LIMIT,
  MAX_TILESET_PROPERTY_ENTRIES,
  MAX_TILESET_WANG_SETS,
  MAX_TILESET_WANG_SET_SUMMARIES,
  MAX_TILESET_WANG_COLORS,
  MAX_TILESET_WANG_COLORS_PER_SET,
  MAX_TILESET_WANG_TILES,
  MAX_TILESET_WANG_TILE_SAMPLE,
  WANG_ID_INDEX_COUNT,
} from "./maps/tilesetDetails.js";
import {
  DEFAULT_TILE_FIND_LIMIT,
  MAX_TILE_FIND_CLAUSES,
  MAX_TILE_FIND_EVALUATIONS,
  MAX_TILE_FIND_LIMIT,
  MAX_TILE_FIND_QUERY_BYTES,
  MAX_TILE_FIND_QUERY_CODE_POINTS,
  MAX_TILE_FIND_RESULT_BYTES,
  MAX_TILE_FIND_VALUE_CODE_POINTS,
  TILE_FIND_PROPERTY_EQUALS_TYPES,
} from "./maps/tileSearch.js";
import type {
  MapEditOperation,
  TileRef,
} from "./maps/types.js";
import {
  applyResultOutputSchema,
  commitResultOutputSchema,
  exactJsonValueOutputSchema,
  toolOutputSchema,
} from "./outputSchemas/common.js";
import {
  addTilesetPreviewToolOutputSchema,
  replaceTilesetPreviewToolOutputSchema,
  checkpointPruneBatchPreviewToolOutputSchema,
  checkpointRestorePreviewToolOutputSchema,
  createLayerPreviewToolOutputSchema,
  createTilesetPreviewToolOutputSchema,
  deleteFilePreviewToolOutputSchema,
  preparedCheckpointAbandonPreviewToolOutputSchema,
  preparedCheckpointCommitPreviewToolOutputSchema,
  preparedCheckpointDiscardPreviewToolOutputSchema,
  previewEditsToolOutputSchema,
  previewShapeToolOutputSchema,
  previewTransactionToolOutputSchema,
  worldEditPreviewToolOutputSchema,
  wangEditPreviewToolOutputSchema,
  tilesetPropertyEditPreviewToolOutputSchema,
  fileExportPreviewToolOutputSchema,
  propertyTypeEditPreviewToolOutputSchema,
  tileNameEditPreviewToolOutputSchema,
  updateTilePreviewToolOutputSchema,
} from "./outputSchemas/changeSets.js";
import {
  MAX_CREATE_TILESET_MARGIN,
  MAX_CREATE_TILESET_NAME_CODE_POINTS,
  MAX_CREATE_TILESET_SPACING,
  MAX_CREATE_TILESET_TILE_EDGE,
} from "./maps/tilesetCreate.js";
import {
  MAX_COORDINATE_CONVERSIONS,
  MAX_COORDINATE_MAGNITUDE,
} from "./maps/coordinates.js";
import {
  MAX_TILESET_CLASS_NAME_CODE_POINTS,
  MAX_TILESET_GRID_EDGE,
  MAX_TILESET_NAME_CODE_POINTS,
  MAX_TILESET_OFFSET,
  TILESET_FILL_MODES,
  TILESET_GRID_ORIENTATIONS,
  TILESET_OBJECT_ALIGNMENTS,
  TILESET_RENDER_SIZES,
  type TilesetPropertyPatch,
} from "./maps/tilesetProperties.js";
import { MAX_WORLD_EDIT_OPERATIONS } from "./maps/worldRead.js";
import {
  MAX_DELETE_REFERENCE_SCAN_ASSETS,
  MAX_DELETE_REFERENCE_SCAN_BYTES,
  MAX_DELETE_REFERRER_SAMPLE,
} from "./maps/fileDelete.js";
import { MAX_TRANSACTION_STAGED_BYTES } from "./storage/transactions.js";
import {
  MAX_DECODED_TILE_DATA_BYTES,
  MAX_TILE_LAYER_CHUNKS,
  TILE_DATA_READ_COMPRESSIONS,
} from "./maps/tileData.js";
import {
  MAX_TILE_ANIMATION_FRAME_DURATION_MS,
  MAX_TILE_ANIMATION_FRAMES_PER_TILE,
  MAX_TILE_CLASS_NAME_CODE_POINTS,
  MAX_TILE_COLLISION_COORDINATE,
  MAX_TILE_COLLISION_POINTS_PER_CHANGE_SET,
  MAX_TILE_COLLISION_SHAPE_POINTS,
  MAX_TILE_COLLISION_SHAPES_PER_TILE,
  MIN_TILE_COLLISION_POLYGON_POINTS,
  MIN_TILE_COLLISION_POLYLINE_POINTS,
  MAX_TILE_PROBABILITY,
  MAX_TILE_PROPERTIES_PER_TILE,
  MAX_TILE_PROPERTY_NAME_CODE_POINTS,
  MAX_TILE_PROPERTY_REMOVES_PER_TILE,
  MAX_TILE_PROPERTY_SETS_PER_TILE,
  MAX_TILE_PROPERTY_VALUE_CODE_POINTS,
  MAX_TILE_UPDATES_PER_CHANGE_SET,
  TILE_PROPERTY_WRITE_TYPES,
} from "./maps/tilesetEdits.js";
import {
  MAX_WANG_ASSIGNMENTS_PER_OPERATION,
  MAX_WANG_EDIT_OPERATIONS,
  MAX_WANG_NAME_CODE_POINTS,
  MAX_WANG_SETS_PER_TILESET,
} from "./maps/wangEdits.js";
import {
  MAX_CLASS_MEMBER_PATH_DEPTH,
  MAX_CLASS_MEMBER_WRITES_PER_TARGET,
  MAX_LIST_ELEMENT_WRITES_PER_TARGET,
  measurePropertiesPatchBytes } from "./maps/propertyEdits.js";
import {
  checkpointListToolOutputSchema,
  listFilesToolOutputSchema,
  worldListToolOutputSchema,
  mapSummaryToolOutputSchema,
  listPropertyTypesToolOutputSchema,
  renderDiffToolOutputSchema,
  listTileNamesToolOutputSchema,
  selectCellsToolOutputSchema,
  renderPreviewToolOutputSchema,
  objectDetailsToolOutputSchema,
  objectListToolOutputSchema,
  rasterMapToolOutputSchema,
  regionToolOutputSchema,
  tileRenderToolOutputSchema,
  tilesetSheetToolOutputSchema,
  validationToolOutputSchema,
} from "./outputSchemas/read.js";
import {
  tileFindToolOutputSchema,
  tilesetDetailToolOutputSchema,
  usageAnalysisToolOutputSchema,
  connectivityToolOutputSchema,
  coordinateToolOutputSchema,
} from "./outputSchemas/semantic.js";
import type { ProjectPathResolver } from "./project/pathResolver.js";
import {
  ASSET_REGISTRY_FORMAT,
  ASSET_REGISTRY_FORMAT_VERSION,
} from "./project/assetRegistry.js";
import {
  APPLICATION_ERROR_RESOURCE_META,
  APPLICATION_ERROR_RESOURCE_URI,
  registerApplicationErrorResource,
} from "./resources/applicationErrors.js";
import {
  GUIDE_RESOURCE_URI,
  registerGuideResource,
} from "./resources/guide.js";
import { TILED_MCP_SERVER_INSTRUCTIONS } from "./resources/instructions.js";
import { registerTiledMcpPrompts } from "./resources/prompts.js";
import {
  DEFAULT_RASTER_RENDER_EDGE,
  MAX_RASTER_INPUT_AGGREGATE_BYTES,
  MAX_RASTER_INPUT_AGGREGATE_PIXELS,
  MAX_RASTER_INPUT_EDGE,
  MAX_RASTER_INPUT_IMAGES,
  MAX_RASTER_PNG_BYTES,
  MAX_RASTER_RENDER_EDGE,
  MAX_RENDERER_VERSION_LENGTH,
  RASTER_RENDER_PROFILE,
  RASTER_SNAPSHOT_CONSISTENCY,
} from "./rasterContract.js";
import { applyChangeSetPlan } from "./planKinds.js";
import {
  CHECKPOINT_PRUNE_BATCH_GARBAGE_COLLECTION,
  MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
  MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
  planCheckpointPruneBatch,
} from "./storage/checkpointBatchPrune.js";
import {
} from "./storage/checkpointPrune.js";
import {
  planCheckpointRestore,
} from "./storage/checkpointRestore.js";
import {
  planPreparedCheckpointDiscard,
} from "./storage/preparedCheckpointDiscard.js";
import {
  planPreparedCheckpointAbandon,
  planPreparedCheckpointCommit,
} from "./storage/preparedCheckpointAdjudication.js";
import {
  CHECKPOINT_ID_PATTERN,
  CHECKPOINT_ID_INPUT_PATTERN,
  CHECKPOINT_STORAGE_POLICY,
  MAX_CHECKPOINT_OBSERVED_ENTRIES,
  MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT,
} from "./storage/checkpoints.js";
import type { DocumentStore } from "./storage/documentStore.js";
import { KeyedMutex } from "./storage/keyedMutex.js";
import { revisionOf } from "./storage/revision.js";
import {
  SERVER_DESCRIPTION,
  SERVER_NAME,
  SERVER_TITLE,
  SERVER_VERSION,
} from "./version.js";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47,
  0x0d, 0x0a, 0x1a, 0x0a,
]);
const MAX_INLINE_IMAGE_BYTES =
  MAX_RASTER_PNG_BYTES;
const MAX_TEXT_CONTENT_BYTES = 1_024;
const MAX_ERROR_MESSAGE_CHARS = 4_096;
const MAX_ERROR_DETAIL_CHARS = 8_000;
const MAX_ERROR_TEXT_MESSAGE_CODE_POINTS = 512;
const TEXT_CONTENT_CONTRACT_NAME = "tiled-mcp-summary" as const;
const TEXT_CONTENT_CONTRACT_VERSION = 1 as const;
declare const trustedToolResultBrand: unique symbol;
type TrustedToolResult = CallToolResult & {
  readonly [trustedToolResultBrand]: true;
};
const trustedToolResults =
  new WeakSet<CallToolResult>();
const INTERNAL_ERROR_MESSAGE =
  "Internal TiledMCP error." as const;
const INTERNAL_ERROR_DETAILS = Object.freeze({});
const INTERNAL_ERROR_RESULT = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "INTERNAL_ERROR",
    message: INTERNAL_ERROR_MESSAGE,
    details: INTERNAL_ERROR_DETAILS,
  }),
});
const INTERNAL_ERROR_STRUCTURED_CONTENT =
  Object.freeze({
    result: INTERNAL_ERROR_RESULT,
  });
const INTERNAL_ERROR_STRUCTURED_CONTENT_BYTES =
  Buffer.byteLength(
    JSON.stringify(
      INTERNAL_ERROR_STRUCTURED_CONTENT,
    ),
    "utf8",
  );
const INTERNAL_ERROR_TEXT = JSON.stringify({
  kind: TEXT_CONTENT_CONTRACT_NAME,
  version: TEXT_CONTENT_CONTRACT_VERSION,
  ok: false,
  error: {
    code: "INTERNAL_ERROR",
    message: INTERNAL_ERROR_MESSAGE,
  },
  structuredContentBytes:
    INTERNAL_ERROR_STRUCTURED_CONTENT_BYTES,
});
const projectPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .describe("Canonical project-relative POSIX path; absolute paths and .. are forbidden");
const revisionSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u)
  .describe("SHA-256 revision returned by a read or preview");
const uint32Schema = z.number().int().min(0).max(0xffffffff);
const positiveIdSchema = z.number().int().positive();
const safeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = safeIntegerSchema.min(1);
const coordinateSpaceSchema = z
  .enum(["tile", "screen", "pixel"])
  .describe(
    "tile = whole/fractional cell indices; screen = rendered pixel position; pixel = the space object x/y live in",
  );
/**
 * Ordinates are fractional on purpose -- a screen point mid-tile is the normal
 * input -- so this bounds magnitude rather than requiring integers.
 */
const coordinateOrdinateSchema = z
  .number()
  .finite()
  .min(-MAX_COORDINATE_MAGNITUDE)
  .max(MAX_COORDINATE_MAGNITUDE);
const nativePreviewHighlightRectInputSchema = z
  .object({
    x: z
      .number()
      .int()
      .min(-1_000_000_000)
      .max(1_000_000_000),
    y: z
      .number()
      .int()
      .min(-1_000_000_000)
      .max(1_000_000_000),
    width: positiveSafeIntegerSchema,
    height: positiveSafeIntegerSchema,
  })
  .strict()
  .superRefine((rect, context) => {
    if (!Number.isSafeInteger(rect.x + rect.width)) {
      context.addIssue({
        code: "custom",
        message:
          "Highlight rectangle right edge must be a safe integer",
        path: ["width"],
      });
    }
    if (!Number.isSafeInteger(rect.y + rect.height)) {
      context.addIssue({
        code: "custom",
        message:
          "Highlight rectangle bottom edge must be a safe integer",
        path: ["height"],
      });
    }
  });
const nativePreviewObjectIdsInputSchema = z
  .array(positiveSafeIntegerSchema)
  .min(1)
  .max(MAX_NATIVE_PREVIEW_OBJECTS)
  .meta({ uniqueItems: true })
  .superRefine((objectIds, context) => {
    const seen = new Set<number>();
    for (const [index, objectId] of objectIds.entries()) {
      if (seen.has(objectId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate object id ${objectId}`,
          path: [index],
        });
      }
      seen.add(objectId);
    }
  });
const objectCoordinateSchema = z.number().min(-1_000_000_000).max(1_000_000_000);
const objectExtentSchema = z.number().min(0).max(1_000_000_000);
const objectStringSchema = z.string().max(1_024);
const objectOpacitySchema = z.number().min(0).max(1);
const mapRenderOrderSchema = z.enum([
  "right-down",
  "right-up",
  "left-down",
  "left-up",
]);
const mapClassNameSchema = z.string().refine(
  (value) =>
    hasAtMostCodePoints(
      value,
      MAX_MAP_CLASS_NAME_CODE_POINTS,
    ),
  {
    message: `Map className may contain at most ${MAX_MAP_CLASS_NAME_CODE_POINTS} Unicode code points`,
  },
);
const layerBlendModeSchema = z.enum([
  "normal",
  "add",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
]);
const tiledColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu);
type TextObjectField =
  (typeof TEXT_OBJECT_FIELDS)[number];
function isValidTextObjectField(
  field: TextObjectField,
  value: unknown,
): boolean {
  try {
    measureTextObjectPayloadBytes({ [field]: value });
    return true;
  } catch {
    return false;
  }
}
const textObjectContentSchema = z
  .string()
  .max(MAX_TEXT_OBJECT_CONTENT_CODE_POINTS * 2)
  .refine(
    (value) =>
      isValidTextObjectField("text", value),
    {
      message:
        "Text must satisfy the advertised Unicode, control-code-point, code-point, and UTF-8 byte limits",
    },
  );
const textObjectFontFamilySchema = z
  .string()
  .min(1)
  .max(MAX_TEXT_OBJECT_FONT_FAMILY_CODE_POINTS * 2)
  .refine(
    (value) =>
      isValidTextObjectField("fontFamily", value),
    {
      message:
        "fontFamily must satisfy the advertised Unicode, control-code-point, code-point, and UTF-8 byte limits",
    },
  );
const textObjectPixelSizeSchema = z
  .number()
  .int()
  .min(MIN_TEXT_OBJECT_PIXEL_SIZE)
  .max(MAX_TEXT_OBJECT_PIXEL_SIZE);
const textObjectHorizontalAlignmentSchema = z.enum(
  TEXT_OBJECT_HORIZONTAL_ALIGNMENTS,
);
const textObjectVerticalAlignmentSchema = z.enum(
  TEXT_OBJECT_VERTICAL_ALIGNMENTS,
);
const tileFindSelectorSchema = z
  .string()
  .min(1)
  .max(MAX_TILE_FIND_QUERY_CODE_POINTS * 2)
  .refine(
    (value) =>
      Array.from(value).length <= MAX_TILE_FIND_QUERY_CODE_POINTS,
    {
      message: `Must contain at most ${MAX_TILE_FIND_QUERY_CODE_POINTS} Unicode code points`,
    },
  );
const tileFindValueStringSchema = z
  .string()
  .max(MAX_TILE_FIND_VALUE_CODE_POINTS * 2)
  .refine(
    (value) =>
      Array.from(value).length <= MAX_TILE_FIND_VALUE_CODE_POINTS,
    {
      message: `Must contain at most ${MAX_TILE_FIND_VALUE_CODE_POINTS} Unicode code points`,
    },
  );
const tileFindClauseSchema = z.union([
  z
    .object({
      kind: z.literal("class"),
      equals: tileFindSelectorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("propertyExists"),
      name: tileFindSelectorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("propertyEquals"),
      name: tileFindSelectorSchema,
      type: z.enum(["string", "file"]),
      value: tileFindValueStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("propertyEquals"),
      name: tileFindSelectorSchema,
      type: z.literal("color"),
      value: z.string().regex(/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu),
    })
    .strict(),
  z
    .object({
      kind: z.literal("propertyEquals"),
      name: tileFindSelectorSchema,
      type: z.literal("int"),
      value: z
        .number()
        .int()
        .min(Number.MIN_SAFE_INTEGER)
        .max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      kind: z.literal("propertyEquals"),
      name: tileFindSelectorSchema,
      type: z.literal("float"),
      value: z.number().min(-Number.MAX_VALUE).max(Number.MAX_VALUE),
    })
    .strict(),
  z
    .object({
      kind: z.literal("propertyEquals"),
      name: tileFindSelectorSchema,
      type: z.literal("bool"),
      value: z.boolean(),
    })
    .strict(),
]);
const tileFindQuerySchema = z
  .object({
    mode: z.enum(["all", "any"]).default("all"),
    clauses: z
      .array(tileFindClauseSchema)
      .min(1)
      .max(MAX_TILE_FIND_CLAUSES),
  })
  .strict();
const dependencyRevisionsSchema = z
  .record(z.string().min(1).max(128), revisionSchema)
  .superRefine((revisions, context) => {
    if (Object.keys(revisions).length > 4_096) {
      context.addIssue({
        code: "custom",
        message: "At most 4096 dependency revisions may be supplied",
      });
    }
  });

const usageAnalysisInputSchema = z
  .object({
    mapPath: projectPathSchema,
    topTileLimit: z
      .number()
      .int()
      .min(1)
      .max(MAX_USAGE_TOP_TILE_LIMIT)
      .optional(),
    expectedMapRevision: revisionSchema.optional(),
    expectedDependencyRevisions:
      dependencyRevisionsSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      (input.expectedMapRevision === undefined) !==
      (input.expectedDependencyRevisions === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "expectedMapRevision and expectedDependencyRevisions must be provided together",
        path: [
          input.expectedMapRevision === undefined
            ? "expectedMapRevision"
            : "expectedDependencyRevisions",
        ],
      });
    }
  });

const createLayerCommonShape = {
  mapPath: projectPathSchema,
  name: z.string().min(1).max(MAX_LAYER_NAME_LENGTH),
  parentGroupId: positiveIdSchema.optional(),
  index: z.number().int().min(0).max(10_000).optional(),
  expectedMapRevision: revisionSchema,
  expectedDependencyRevisions: dependencyRevisionsSchema,
} as const;

const createLayerInputSchema = z
  .object({
    ...createLayerCommonShape,
    type: z
      .enum(["tilelayer", "objectgroup", "imagelayer", "group"])
      .describe(
        "Layer kind. imagelayer requires imagePath; all other kinds forbid imagePath and expectedImageRevision.",
      ),
    imagePath: projectPathSchema
      .describe(
        "Project-relative image path. Required only when type is imagelayer.",
      )
      .optional(),
    expectedImageRevision: revisionSchema
      .describe(
        "Optional current image revision pin. Allowed only when type is imagelayer.",
      )
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.type === "imagelayer" &&
      input.imagePath === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "imagePath is required for an imagelayer",
        path: ["imagePath"],
      });
    }
    if (
      input.type !== "imagelayer" &&
      (input.imagePath !== undefined ||
        input.expectedImageRevision !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "imagePath and expectedImageRevision are allowed only for an imagelayer",
        path: [
          input.imagePath !== undefined
            ? "imagePath"
            : "expectedImageRevision",
        ],
      });
    }
  });

/**
 * Shared input sub-schemas carry a registry `id`.
 *
 * Zod inlines a reused schema at every use site, so the tile-reference family
 * alone was repeated fifteen times across the advertised input schemas. An
 * `id` makes the SDK's converter emit one `definitions` entry and a `$ref` per
 * use instead, which is what an agent carries in context for a whole session.
 *
 * Only worth doing where a schema is reused *within* one tool's document: MCP
 * gives every tool its own schema, so a single-use `$ref` costs more than the
 * inlining it replaces. Tagging the output schemas the same way measured as a
 * net loss and was reverted.
 *
 * The ids are part of the published contract, so renaming one means rerunning
 * `pnpm contract:generate`.
 */
const tileTransformSchema = z
  .object({
    kind: z.literal("orthogonal").optional(),
    flipH: z.boolean().optional(),
    flipV: z.boolean().optional(),
    flipD: z.boolean().optional(),
    rawFlags: uint32Schema.optional(),
  })
  .strict()
  .meta({ id: "TileTransform" });

const tileRefSchema = z
  .object({
    tileset: z
      .object({
        kind: z.literal("external"),
        assetId: z.string().min(1).max(128),
      })
      .strict(),
    localId: z.number().int().min(0).max(0x0fffffff),
    transform: tileTransformSchema.optional(),
  })
  .strict()
  .meta({ id: "TileRef" });

const namedTileRefSchema = z
  .union([
    tileRefSchema,
    z
      .object({
        name: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
      })
      .strict(),
  ])
  .meta({ id: "NamedTileRef" });

const setTilesSchema = z
  .object({
    type: z.literal("setTiles"),
    layerId: z.number().int(),
    cells: z
      .array(
        z
          .object({
            x: z.number().int(),
            y: z.number().int(),
            tile: tileRefSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100_000),
  })
  .strict();

const fillRegionSchema = z
  .object({
    type: z.literal("fillRegion"),
    layerId: z.number().int(),
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    tile: tileRefSchema.nullable(),
  })
  .strict();

const stampPatternSchema = z
  .object({
    type: z.literal("stampPattern"),
    layerId: positiveIdSchema,
    x: z.number().int(),
    y: z.number().int(),
    pattern: z
      .array(
        z
          .array(tileRefSchema.nullable())
          .min(1)
          .max(MAX_STAMP_PATTERN_EDGE),
      )
      .min(1)
      .max(MAX_STAMP_PATTERN_EDGE)
      .superRefine((pattern, context) => {
        const width = pattern[0]?.length ?? 0;
        for (
          let rowIndex = 1;
          rowIndex < pattern.length;
          rowIndex += 1
        ) {
          if (pattern[rowIndex]?.length !== width) {
            context.addIssue({
              code: "custom",
              message:
                "stampPattern rows must all have the same length",
              path: [rowIndex],
            });
          }
        }
        if (
          width > 0 &&
          pattern.length * width >
            MAX_STAMP_PATTERN_CELLS
        ) {
          context.addIssue({
            code: "custom",
            message: `stampPattern may contain at most ${MAX_STAMP_PATTERN_CELLS} cells`,
          });
        }
      }),
  })
  .strict();

const floodFillSchema = z
  .object({
    type: z.literal("floodFill"),
    layerId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    x: safeIntegerSchema,
    y: safeIntegerSchema,
    tile: tileRefSchema.nullable(),
  })
  .strict();

const copyRegionSourceSchema = z
  .object({
    layerId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    x: safeIntegerSchema,
    y: safeIntegerSchema,
    width: z
      .number()
      .int()
      .positive()
      .max(MAX_CELL_WRITES),
    height: z
      .number()
      .int()
      .positive()
      .max(MAX_CELL_WRITES),
  })
  .strict();

const copyRegionDestinationSchema = z
  .object({
    layerId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    x: safeIntegerSchema,
    y: safeIntegerSchema,
  })
  .strict();

const copyRegionSchema = z
  .object({
    type: z.literal("copyRegion"),
    source: copyRegionSourceSchema,
    destination: copyRegionDestinationSchema,
  })
  .strict();

const replaceTilesRegionSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

const replaceTilesSchema = z
  .object({
    type: z.literal("replaceTiles"),
    layerId: positiveIdSchema,
    mappings: z
      .array(
        z
          .object({
            from: tileRefSchema,
            to: tileRefSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_REPLACE_TILE_MAPPINGS),
    region: replaceTilesRegionSchema.optional(),
  })
  .strict();

const objectCommonShape = {
  x: objectCoordinateSchema,
  y: objectCoordinateSchema,
  name: objectStringSchema.optional(),
  className: objectStringSchema.optional(),
  rotation: objectCoordinateSchema.optional(),
  visible: z.boolean().optional(),
  opacity: objectOpacitySchema.optional(),
} as const;

const rectangleObjectSchema = z
  .object({
    shape: z.literal("rectangle"),
    ...objectCommonShape,
    width: objectExtentSchema.optional(),
    height: objectExtentSchema.optional(),
  })
  .strict();

const pointObjectSchema = z
  .object({
    shape: z.literal("point"),
    ...objectCommonShape,
  })
  .strict();

const tileObjectSchema = z
  .object({
    shape: z.literal("tile"),
    ...objectCommonShape,
    tile: tileRefSchema,
    width: objectExtentSchema,
    height: objectExtentSchema,
  })
  .strict();

const ellipseObjectSchema = z
  .object({
    shape: z.literal("ellipse"),
    ...objectCommonShape,
    width: objectExtentSchema.optional(),
    height: objectExtentSchema.optional(),
  })
  .strict();

const capsuleObjectSchema = z
  .object({
    shape: z.literal("capsule"),
    ...objectCommonShape,
    width: objectExtentSchema.optional(),
    height: objectExtentSchema.optional(),
  })
  .strict();

const objectPathPointSchema = z
  .object({
    x: objectCoordinateSchema,
    y: objectCoordinateSchema,
  })
  .strict();

const polygonObjectSchema = z
  .object({
    shape: z.literal("polygon"),
    ...objectCommonShape,
    points: z
      .array(objectPathPointSchema)
      .min(MIN_POLYGON_OBJECT_POINTS)
      .max(MAX_OBJECT_SHAPE_POINTS),
  })
  .strict();

const polylineObjectSchema = z
  .object({
    shape: z.literal("polyline"),
    ...objectCommonShape,
    points: z
      .array(objectPathPointSchema)
      .min(MIN_POLYLINE_OBJECT_POINTS)
      .max(MAX_OBJECT_SHAPE_POINTS),
  })
  .strict();

const textObjectSchema = z
  .object({
    shape: z.literal("text"),
    ...objectCommonShape,
    width: objectExtentSchema.optional(),
    height: objectExtentSchema.optional(),
    text: textObjectContentSchema,
    fontFamily:
      textObjectFontFamilySchema.optional(),
    pixelSize:
      textObjectPixelSizeSchema.optional(),
    wrap: z.boolean().optional(),
    color: tiledColorSchema.optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikeout: z.boolean().optional(),
    kerning: z.boolean().optional(),
    horizontalAlignment:
      textObjectHorizontalAlignmentSchema.optional(),
    verticalAlignment:
      textObjectVerticalAlignmentSchema.optional(),
  })
  .strict();

const createObjectSchema = z
  .object({
    type: z.literal("createObject"),
    layerId: positiveIdSchema,
    object: z.discriminatedUnion("shape", [
      rectangleObjectSchema,
      pointObjectSchema,
      ellipseObjectSchema,
      capsuleObjectSchema,
      polygonObjectSchema,
      polylineObjectSchema,
      textObjectSchema,
      tileObjectSchema,
    ]),
  })
  .strict();

const tilePropertyNameSchema = z
  .string()
  .min(1)
  .max(MAX_TILE_PROPERTY_NAME_CODE_POINTS * 2);

const tilePropertyWriteSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        name: tilePropertyNameSchema,
        type: z.enum(["string", "file"]),
        value: z
          .string()
          .max(
            MAX_TILE_PROPERTY_VALUE_CODE_POINTS * 2,
          ),
      })
      .strict(),
    z
      .object({
        name: tilePropertyNameSchema,
        type: z.literal("int"),
        value: z
          .number()
          .int()
          .min(Number.MIN_SAFE_INTEGER)
          .max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    z
      .object({
        name: tilePropertyNameSchema,
        type: z.literal("float"),
        value: z.number().finite(),
      })
      .strict(),
    z
      .object({
        name: tilePropertyNameSchema,
        type: z.literal("bool"),
        value: z.boolean(),
      })
      .strict(),
    z
      .object({
        name: tilePropertyNameSchema,
        type: z.literal("color"),
        value: z
          .string()
          .regex(/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu),
      })
      .strict(),
  ]);

const classMemberWriteSchema = z
  .object({
    property: tilePropertyNameSchema,
    path: z
      .array(tilePropertyNameSchema)
      .min(1)
      .max(MAX_CLASS_MEMBER_PATH_DEPTH),
    value: z.union([
      z.string().max(4_096),
      z.number().finite(),
      z.boolean(),
    ]),
  })
  .strict();

const listElementWriteSchema = z
  .object({
    property: tilePropertyNameSchema,
    index: z.number().int().min(0).max(100_000),
    value: z.union([
      z.string().max(4_096),
      z.number().finite(),
      z.boolean(),
    ]),
  })
  .strict();

const tilePropertiesPatchSchema = z
  .object({
    set: z
      .array(tilePropertyWriteSchema)
      .min(1)
      .max(MAX_TILE_PROPERTY_SETS_PER_TILE)
      .optional(),
    remove: z
      .array(tilePropertyNameSchema)
      .min(1)
      .max(MAX_TILE_PROPERTY_REMOVES_PER_TILE)
      .optional(),
    setClassMembers: z
      .array(classMemberWriteSchema)
      .min(1)
      .max(MAX_CLASS_MEMBER_WRITES_PER_TARGET)
      .optional(),
    setListElements: z
      .array(listElementWriteSchema)
      .min(1)
      .max(MAX_LIST_ELEMENT_WRITES_PER_TARGET)
      .optional(),
  })
  .strict()
  .refine(
    (patch) =>
      patch.set !== undefined ||
      patch.remove !== undefined ||
      patch.setClassMembers !== undefined ||
      patch.setListElements !== undefined,
    {
      message:
        "Tile properties patch must contain set, remove, setClassMembers, or setListElements entries",
    },
  )
  .meta({ id: "TilePropertiesPatch" });

const objectPatchSchema = z
  .object({
    x: objectCoordinateSchema.optional(),
    y: objectCoordinateSchema.optional(),
    width: objectExtentSchema.optional(),
    height: objectExtentSchema.optional(),
    tile: tileRefSchema.optional(),
    points: z
      .array(objectPathPointSchema)
      .min(MIN_POLYLINE_OBJECT_POINTS)
      .max(MAX_OBJECT_SHAPE_POINTS)
      .optional(),
    name: objectStringSchema.optional(),
    className: objectStringSchema.optional(),
    rotation: objectCoordinateSchema.optional(),
    visible: z.boolean().optional(),
    opacity: objectOpacitySchema.optional(),
    text: textObjectContentSchema.optional(),
    fontFamily:
      textObjectFontFamilySchema.optional(),
    pixelSize:
      textObjectPixelSizeSchema.optional(),
    wrap: z.boolean().optional(),
    color: tiledColorSchema.optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikeout: z.boolean().optional(),
    kerning: z.boolean().optional(),
    horizontalAlignment:
      textObjectHorizontalAlignmentSchema.optional(),
    verticalAlignment:
      textObjectVerticalAlignmentSchema.optional(),
    atlas: z
      .object({
        tileWidth: z
          .number()
          .int()
          .min(1)
          .max(MAX_TILESET_GRID_EDGE),
        tileHeight: z
          .number()
          .int()
          .min(1)
          .max(MAX_TILESET_GRID_EDGE),
        margin: z
          .number()
          .int()
          .min(0)
          .max(MAX_TILESET_GRID_EDGE)
          .optional(),
        spacing: z
          .number()
          .int()
          .min(0)
          .max(MAX_TILESET_GRID_EDGE)
          .optional(),
      })
      .strict()
      .optional(),
    properties:
      tilePropertiesPatchSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Object update patch must contain at least one field",
  });

const updateObjectSchema = z
  .object({
    type: z.literal("updateObject"),
    objectId: positiveIdSchema,
    patch: objectPatchSchema,
  })
  .strict();

const deleteObjectsSchema = z
  .object({
    type: z.literal("deleteObjects"),
    objectIds: z
      .array(positiveIdSchema)
      .min(1)
      .max(10_000)
      .superRefine((objectIds, context) => {
        const seen = new Set<number>();
        for (const [index, objectId] of objectIds.entries()) {
          if (seen.has(objectId)) {
            context.addIssue({
              code: "custom",
              message: `Duplicate object id ${objectId}`,
              path: [index],
            });
          }
          seen.add(objectId);
        }
      }),
  })
  .strict();

const mapPatchSchema = z
  .object({
    renderOrder: mapRenderOrderSchema.optional(),
    backgroundColor:
      tiledColorSchema.nullable().optional(),
    className: mapClassNameSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Map update patch must contain at least one field",
  });

const updateMapSchema = z
  .object({
    type: z.literal("updateMap"),
    patch: mapPatchSchema,
  })
  .strict();

const resizeMapSchema = z
  .object({
    type: z.literal("resizeMap"),
    width: z
      .number()
      .int()
      .min(1)
      .max(MAX_RESIZE_MAP_DIMENSION),
    height: z
      .number()
      .int()
      .min(1)
      .max(MAX_RESIZE_MAP_DIMENSION),
    offsetX: z
      .number()
      .int()
      .min(-MAX_RESIZE_OFFSET_MAGNITUDE)
      .max(MAX_RESIZE_OFFSET_MAGNITUDE)
      .optional(),
    offsetY: z
      .number()
      .int()
      .min(-MAX_RESIZE_OFFSET_MAGNITUDE)
      .max(MAX_RESIZE_OFFSET_MAGNITUDE)
      .optional(),
  })
  .strict();

const worldCoordinateSchema = z
  .number()
  .int()
  .min(-1_000_000_000)
  .max(1_000_000_000);
const worldSizeSchema = z
  .number()
  .int()
  .min(0)
  .max(1_000_000_000);

const transcodeTileLayerSchema = z
  .object({
    type: z.literal("transcodeTileLayer"),
    layerId: z.number().int().min(1),
    encoding: z.enum(["csv", "base64"]),
    compression: z
      .enum(["", "gzip", "zlib", "zstd"])
      .optional(),
  })
  .strict();

const layerPatchSchema = z
  .object({
    name: objectStringSchema.optional(),
    className: objectStringSchema.optional(),
    visible: z.boolean().optional(),
    opacity: objectOpacitySchema.optional(),
    offsetX: objectCoordinateSchema.optional(),
    offsetY: objectCoordinateSchema.optional(),
    parallaxX: objectCoordinateSchema.optional(),
    parallaxY: objectCoordinateSchema.optional(),
    tintColor: tiledColorSchema.nullable().optional(),
    locked: z.boolean().optional(),
    blendMode: layerBlendModeSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Layer update patch must contain at least one field",
  });

const updateLayerSchema = z
  .object({
    type: z.literal("updateLayer"),
    layerId: positiveIdSchema,
    patch: layerPatchSchema,
  })
  .strict();

const deleteLayerSchema = z
  .object({
    type: z.literal("deleteLayer"),
    layerId: positiveIdSchema,
    deleteDescendants: z.boolean().optional(),
  })
  .strict();

const moveLayerSchema = z
  .object({
    type: z.literal("moveLayer"),
    layerId: positiveIdSchema,
    parentGroupId: positiveIdSchema.optional(),
    index: z.number().int().min(0).max(10_000),
  })
  .strict();

const duplicateLayerDestinationSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("sameParent"),
        index: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("root"),
        index: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("group"),
        parentGroupId: positiveIdSchema,
        index: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional(),
      })
      .strict(),
  ],
);

const duplicateLayerSchema = z
  .object({
    type: z.literal("duplicateLayer"),
    layerId: positiveIdSchema,
    destination:
      duplicateLayerDestinationSchema.optional(),
    name: z.string().max(MAX_LAYER_NAME_LENGTH).optional(),
  })
  .strict();

const removeTilesetFromMapSchema = z
  .object({
    type: z.literal("removeTilesetFromMap"),
    tilesetAssetId: z
      .string()
      .regex(/^asset_[0-9a-f]{24}$/u),
  })
  .strict();

const tileAnimationFrameSchema = z
  .object({
    tileId: z
      .number()
      .int()
      .min(0)
      .max(0x0fffffff),
    durationMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_TILE_ANIMATION_FRAME_DURATION_MS),
  })
  .strict();

const tileCollisionCoordinateSchema = z
  .number()
  .finite()
  .min(-MAX_TILE_COLLISION_COORDINATE)
  .max(MAX_TILE_COLLISION_COORDINATE);
const tileCollisionExtentSchema = z
  .number()
  .finite()
  .min(0)
  .max(MAX_TILE_COLLISION_COORDINATE);
const tileCollisionNameSchema = z
  .string()
  .max(MAX_TILE_CLASS_NAME_CODE_POINTS * 2);
const tileCollisionShapeCommon = {
  x: tileCollisionCoordinateSchema,
  y: tileCollisionCoordinateSchema,
  rotation:
    tileCollisionCoordinateSchema.optional(),
  name: tileCollisionNameSchema.optional(),
  className: tileCollisionNameSchema.optional(),
} as const;
const tileCollisionPointSchema = z
  .object({
    x: tileCollisionCoordinateSchema,
    y: tileCollisionCoordinateSchema,
  })
  .strict();
const tileCollisionShapeSchema =
  z.discriminatedUnion("shape", [
    z
      .object({
        shape: z.enum([
          "rectangle",
          "ellipse",
          "capsule",
        ]),
        ...tileCollisionShapeCommon,
        width:
          tileCollisionExtentSchema.optional(),
        height:
          tileCollisionExtentSchema.optional(),
      })
      .strict(),
    z
      .object({
        shape: z.literal("point"),
        ...tileCollisionShapeCommon,
      })
      .strict(),
    z
      .object({
        shape: z.literal("polygon"),
        ...tileCollisionShapeCommon,
        points: z
          .array(tileCollisionPointSchema)
          .min(MIN_TILE_COLLISION_POLYGON_POINTS)
          .max(MAX_TILE_COLLISION_SHAPE_POINTS),
      })
      .strict(),
    z
      .object({
        shape: z.literal("polyline"),
        ...tileCollisionShapeCommon,
        points: z
          .array(tileCollisionPointSchema)
          .min(
            MIN_TILE_COLLISION_POLYLINE_POINTS,
          )
          .max(MAX_TILE_COLLISION_SHAPE_POINTS),
      })
      .strict(),
  ]);
const tileCollisionPatchSchema = z
  .object({
    shapes: z
      .array(tileCollisionShapeSchema)
      .min(1)
      .max(MAX_TILE_COLLISION_SHAPES_PER_TILE),
  })
  .strict();

const tileMetadataPatchSchema = z
  .object({
    probability: z
      .number()
      .min(0)
      .max(MAX_TILE_PROBABILITY)
      .nullable()
      .optional(),
    className: mapClassNameSchema
      .refine((value) => value.length > 0, {
        message:
          "className must be a non-empty string; use null to remove the class",
      })
      .nullable()
      .optional(),
    animation: z
      .array(tileAnimationFrameSchema)
      .min(1)
      .max(MAX_TILE_ANIMATION_FRAMES_PER_TILE)
      .nullable()
      .optional(),
    collision: tileCollisionPatchSchema
      .nullable()
      .optional(),
    properties:
      tilePropertiesPatchSchema.optional(),
  })
  .strict()
  .refine(
    (patch) => Object.keys(patch).length > 0,
    {
      message:
        "Tile update patch must contain at least one field",
    },
  );

/**
 * Tileset-level members. Everything but `name` and `properties` is nullable,
 * because removing the member and setting it to Tiled's default value are
 * distinguishable in the file and so must be distinguishable here.
 */
const tilesetPropertyPatchSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_TILESET_NAME_CODE_POINTS)
      .optional(),
    className: z
      .string()
      .min(1)
      .max(MAX_TILESET_CLASS_NAME_CODE_POINTS)
      .nullable()
      .optional(),
    tileOffset: z
      .object({
        x: z
          .number()
          .int()
          .min(-MAX_TILESET_OFFSET)
          .max(MAX_TILESET_OFFSET),
        y: z
          .number()
          .int()
          .min(-MAX_TILESET_OFFSET)
          .max(MAX_TILESET_OFFSET),
      })
      .strict()
      .nullable()
      .optional(),
    objectAlignment: z
      .enum([...TILESET_OBJECT_ALIGNMENTS])
      .nullable()
      .optional(),
    tileRenderSize: z
      .enum([...TILESET_RENDER_SIZES])
      .nullable()
      .optional(),
    fillMode: z
      .enum([...TILESET_FILL_MODES])
      .nullable()
      .optional(),
    transformations: z
      .object({
        hFlip: z.boolean(),
        vFlip: z.boolean(),
        rotate: z.boolean(),
        preferUntransformed: z.boolean(),
      })
      .strict()
      .nullable()
      .optional(),
    grid: z
      .object({
        orientation: z.enum([
          ...TILESET_GRID_ORIENTATIONS,
        ]),
        width: z
          .number()
          .int()
          .min(1)
          .max(MAX_TILESET_GRID_EDGE),
        height: z
          .number()
          .int()
          .min(1)
          .max(MAX_TILESET_GRID_EDGE),
      })
      .strict()
      .nullable()
      .optional(),
    properties:
      tilePropertiesPatchSchema.optional(),
  })
  .strict()
  .refine(
    (patch) => Object.keys(patch).length > 0,
    {
      message:
        "Tileset patch must contain at least one field",
    },
  );

const tileMetadataUpdateSchema = z.union([
  z
    .object({
      tileId: z
        .number()
        .int()
        .min(0)
        .max(0x0fffffff),
      patch: tileMetadataPatchSchema,
    })
    .strict(),
  z
    .object({
      tileId: z
        .number()
        .int()
        .min(0)
        .max(0x0fffffff),
      createCollectionTile: z
        .object({
          image: z.string().min(1).max(4_096),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      tileId: z
        .number()
        .int()
        .min(0)
        .max(0x0fffffff),
      removeCollectionTile: z.literal(true),
    })
    .strict(),
]);

const mapEditSchema = z.discriminatedUnion("type", [
  updateMapSchema,
  resizeMapSchema,
  transcodeTileLayerSchema,
  removeTilesetFromMapSchema,
  setTilesSchema,
  fillRegionSchema,
  stampPatternSchema,
  floodFillSchema,
  copyRegionSchema,
  replaceTilesSchema,
  createObjectSchema,
  updateObjectSchema,
  deleteObjectsSchema,
  updateLayerSchema,
  deleteLayerSchema,
  moveLayerSchema,
  duplicateLayerSchema,
]);
export const TILED_MCP_PROTOCOL_BASELINE =
  "2025-11-25" as const;
export const TILED_MCP_CORE_TOOL_NAMES =
  Object.freeze([
    "tiled_get_capabilities",
    "tiled_list_files",
    "tiled_list_world_maps",
    "tiled_list_property_types",
    "tiled_list_checkpoints",
    "tiled_create_checkpoint",
    "tiled_preview_prepared_checkpoint_discard",
    "tiled_preview_prepared_checkpoint_commit",
    "tiled_preview_prepared_checkpoint_abandon",
    "tiled_preview_checkpoint_prune_batch",
    "tiled_preview_checkpoint_restore",
    "tiled_get_map_summary",
    "tiled_get_tileset",
    "tiled_find_tiles",
    "tiled_get_region",
    "tiled_render_tileset_sheet",
    "tiled_render_tiles",
    "tiled_render_preview",
    "tiled_render_diff",
    "tiled_list_objects",
    "tiled_get_object",
    "tiled_validate",
    "tiled_analyze_usage",
    "tiled_check_connectivity",
    "tiled_convert_coordinates",
    "tiled_create_map",
    "tiled_create_tileset",
    "tiled_delete_file",
    "tiled_add_tileset_to_map",
    "tiled_replace_tileset_in_map",
    "tiled_preview_merge_map",
    "tiled_update_tile",
    "tiled_update_tileset",
    "tiled_update_wangsets",
    "tiled_create_layer",
    "tiled_preview_edits",
    "tiled_preview_shape",
    "tiled_preview_generate",
    "tiled_preview_scatter",
    "tiled_preview_import_image",
    "tiled_preview_prefab",
    "tiled_preview_template",
    "tiled_preview_write_xml",
    "tiled_select",
    "tiled_list_tile_names",
    "tiled_preview_tile_names",
    "tiled_preview_validation_fixes",
    "tiled_preview_property_types",
    "tiled_preview_world_edits",
    "tiled_preview_transaction",
    "tiled_preview_terrain",
    "tiled_apply_change_set",
  ] as const);
export const TILED_MCP_OPTIONAL_TOOL_NAMES =
  Object.freeze([
    "tiled_render_map",
    "tiled_preview_export",
  ] as const);
/** Every tool name this server may advertise, core or CLI-gated. */
export type AdvertisedToolName =
  | (typeof TILED_MCP_CORE_TOOL_NAMES)[number]
  | (typeof TILED_MCP_OPTIONAL_TOOL_NAMES)[number];

const capabilityIssueOutputSchema = z
  .object({
    code: z.enum(
      TILED_MCP_CAPABILITY_ISSUE_CODES,
    ),
    message: z.string(),
  })
  .strict();
const cliCapabilitiesOutputSchema = z
  .object({
    tiled: z
      .object({
        executable: z.string(),
        available: z.boolean(),
        version: z.string().nullable(),
        mapExportFormats: z.array(z.string()),
        tilesetExportFormats: z.array(z.string()),
        issues: z.array(
          capabilityIssueOutputSchema,
        ),
      })
      .strict(),
    rasterizer: z
      .object({
        executable: z.string(),
        available: z.boolean(),
        version: z.string().nullable(),
        issues: z.array(
          capabilityIssueOutputSchema,
        ),
      })
      .strict(),
  })
  .strict();

function immutableCliCapabilitiesSnapshot(
  value: TiledCliCapabilities,
): TiledCliCapabilities {
  const parsed =
    cliCapabilitiesOutputSchema.parse(value);
  const freezeIssues = (
    issues: typeof parsed.tiled.issues,
  ) =>
    Object.freeze(
      issues.map((issue) =>
        Object.freeze({
          code: issue.code,
          message:
            issue.code === "INTERNAL_ERROR"
              ? "Tiled capability probe failed internally."
              : issue.message,
        }),
      ),
    );
  return Object.freeze({
    tiled: Object.freeze({
      executable: parsed.tiled.executable,
      available: parsed.tiled.available,
      version: parsed.tiled.version,
      mapExportFormats: Object.freeze([
        ...parsed.tiled.mapExportFormats,
      ]),
      tilesetExportFormats: Object.freeze([
        ...parsed.tiled.tilesetExportFormats,
      ]),
      issues: freezeIssues(
        parsed.tiled.issues,
      ),
    }),
    rasterizer: Object.freeze({
      executable:
        parsed.rasterizer.executable,
      available: parsed.rasterizer.available,
      version: parsed.rasterizer.version,
      issues: freezeIssues(
        parsed.rasterizer.issues,
      ),
    }),
  }) as unknown as TiledCliCapabilities;
}

const registeredToolNamesOutputSchema = z.union([
  exactJsonValueOutputSchema(
    [...TILED_MCP_CORE_TOOL_NAMES],
  ),
  exactJsonValueOutputSchema(
    [
      ...TILED_MCP_CORE_TOOL_NAMES,
      "tiled_render_map",
    ],
  ),
  exactJsonValueOutputSchema(
    [
      ...TILED_MCP_CORE_TOOL_NAMES,
      "tiled_preview_export",
    ],
  ),
  exactJsonValueOutputSchema(
    [
      ...TILED_MCP_CORE_TOOL_NAMES,
      ...TILED_MCP_OPTIONAL_TOOL_NAMES,
    ],
  ),
]);

const READ_ONLY: ToolAnnotations = {
  title: "Read local Tiled project data",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const PREVIEW_ONLY: ToolAnnotations = {
  title: "Preview a local Tiled map change",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};


const CHECKPOINT_PRUNE_BATCH_PREVIEW: ToolAnnotations = {
  title:
    "Preview pruning recovery checkpoints in a batch",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const PREPARED_CHECKPOINT_DISCARD_PREVIEW: ToolAnnotations =
  {
    title:
      "Preview discarding a prepared recovery checkpoint",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };

const PREPARED_CHECKPOINT_COMMIT_PREVIEW: ToolAnnotations =
  {
    title:
      "Preview committing an ambiguous prepared recovery checkpoint",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };

const PREPARED_CHECKPOINT_ABANDON_PREVIEW: ToolAnnotations =
  {
    title:
      "Preview abandoning an ambiguous prepared recovery checkpoint",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };

export interface TiledMcpServerDependencies {
  resolver: ProjectPathResolver;
  store: DocumentStore;
  maps: MapService;
  cli: TiledCliAdapter;
}

export interface CreatedTiledMcpServer {
  server: McpServer;
  cliCapabilities: TiledCliCapabilities;
  registeredTools: string[];
}

export async function createTiledMcpServer(
  dependencies: TiledMcpServerDependencies,
): Promise<CreatedTiledMcpServer> {
  await dependencies.maps.initializeAssetRegistry();
  const cliCapabilities =
    await dependencies.cli.probeCapabilities();
  return await createTiledMcpServerFromCapabilitySnapshot(
    dependencies,
    cliCapabilities,
  );
}

export async function createTiledMcpServerFromCapabilitySnapshot(
  dependencies: TiledMcpServerDependencies,
  cliCapabilitiesInput: TiledCliCapabilities,
): Promise<CreatedTiledMcpServer> {
  await dependencies.maps.initializeAssetRegistry();
  const cliCapabilities =
    immutableCliCapabilitiesSnapshot(
      cliCapabilitiesInput,
    );
  const { resolver, store, maps, cli } = dependencies;
  const changeSets = new ChangeSetRegistry();
  const renderMutex = new KeyedMutex();
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: SERVER_TITLE,
      description: SERVER_DESCRIPTION,
      version: SERVER_VERSION,
    },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions:
        TILED_MCP_SERVER_INSTRUCTIONS,
    },
  );
  const registeredTools: string[] = [];

  registerGuideResource(server);
  registerApplicationErrorResource(server);
  registerTiledMcpPrompts(server);

  const advertisedToolNames = [
    ...TILED_MCP_CORE_TOOL_NAMES,
    ...(cliCapabilities.rasterizer.available
      ? (["tiled_render_map"] as const)
      : []),
    ...(cliCapabilities.tiled.available
      ? (["tiled_preview_export"] as const)
      : []),
  ];
  const capabilitiesResult = {
        protocolBaseline:
          TILED_MCP_PROTOCOL_BASELINE,
        serverVersion: SERVER_VERSION,
        resourceCapabilities: {
          direct: [
            GUIDE_RESOURCE_URI,
            APPLICATION_ERROR_RESOURCE_URI,
          ],
          templates: [],
          subscriptions: false,
          listChanged: true,
        },
        editProfiles: ["finite-orthogonal-tmj-external-atlas-tsj"],
        mapOperations: ["updateMap", "resizeMap"],
        mapResizeCapabilities: {
          offsetUnit: "tiles",
          offsetMeaning:
            "old-content-position-in-new-map",
          cellMapping:
            "destination-equals-source-plus-offset",
          tileLayerRequirement:
            "map-aligned-zero-origin-finite-numeric-data-only",
          croppedGidValidation:
            "every-scanned-source-cell-fail-closed",
          objectPolicy:
            "shift-anchor-only-never-delete",
          outOfBoundsObjectMetric:
            "shifted-anchor-outside-closed-pixel-bounds",
          templateObjects:
            "fail-closed-when-shifting",
          imageLayerPolicy:
            "shift-changed-offset-members-only",
          groupLayerPolicy:
            "recurse-children-untouched-self",
          idCounters: "unchanged",
          operationOrdering:
            "exclusive-single-operation-change-set",
          sourcePatch:
            "root-dimensions-and-affected-layer-members-local",
        },
        tileMetadataUpdateCapabilities: {
          fields: [
            "probability",
            "className",
            "animation",
            "collision",
            "properties",
          ],
          collisionShapes: [
            "rectangle",
            "point",
            "ellipse",
            "capsule",
            "polygon",
            "polyline",
          ],
          collisionReplacement:
            "whole-objects-array-null-removes-member",
          collisionContainer:
            "preserve-existing-members-create-canonical-index-draworder",
          collisionIds:
            "continue-after-existing-maximum",
          maxCollisionShapesPerTile:
            MAX_TILE_COLLISION_SHAPES_PER_TILE,
          maxCollisionPointsPerChangeSet:
            MAX_TILE_COLLISION_POINTS_PER_CHANGE_SET,
          propertyWriteTypes: [
            ...TILE_PROPERTY_WRITE_TYPES,
          ],
          propertyOrdering:
            "tiled-name-sorted-insert-fail-closed-on-unsorted",
          complexPropertyTargets: "fail-closed",
          untouchedComplexProperties: "preserved",
          propertyTypeMember: "always-written",
          propertyColorInput:
            "rrggbb-or-aarrggbb-stored-verbatim",
          addressing:
            "map-scoped-tileset-asset-id",
          planner:
            "dedicated-single-tileset-preview",
          probabilityDefaultRemoval:
            "one-or-null-removes-member",
          classMemberPolicy:
            "update-existing-class-else-tiled-1-12-type-member",
          ambiguousClassMembers: "fail-closed",
          animationReplacement: "whole-array",
          animationSerialization:
            "tiled-tileid-duration-members",
          entryLifecycle:
            "insert-ascending-remove-when-only-id",
          structuralUpdates:
            "exclusive-single-update-change-set",
          unorderedTilesInsertion: "fail-closed",
          sourcePatch:
            "tiles-entry-member-local",
        },
        mapUpdateCapabilities: {
          fields: [
            "renderOrder",
            "backgroundColor",
            "className",
          ],
          renderOrders: [
            "right-down",
            "right-up",
            "left-down",
            "left-up",
          ],
          backgroundColorNullDeletes: true,
          maxClassNameCodePoints:
            MAX_MAP_CLASS_NAME_CODE_POINTS,
          operationOrdering:
            "sequential-change-set-order-last-write-wins",
          sourcePatch: "root-object-member-local",
        },
        tileOperations: [
          "setTiles",
          "fillRegion",
          "stampPattern",
          "floodFill",
          "replaceTiles",
          "copyRegion",
        ],
        tileStampCapabilities: {
          pattern:
            "dense-non-empty-rectangular-row-major",
          origin: "absolute-tile-coordinates",
          nullSemantics: "clear-target-cell",
          skipSentinel: false,
          clipping: false,
          transformEncoding:
            "standard-tile-ref-encoded-gid",
          operationOrdering:
            "sequential-change-set-order-last-write-wins",
          sourcePatch: "tile-layer-data-member-local",
        },
        tileFloodFillCapabilities: {
          seedSourceMatch: "exact-encoded-gid",
          connectivity: "fixed-four-way",
          nullableTarget: true,
          coordinates: "absolute-tile-coordinates",
          operationOrdering:
            "sequential-change-set-order-last-write-wins",
          scanAccounting: "actual-gid-reads",
          scanBudget:
            "shared-with-replaceTiles-and-copyRegion-per-change-set",
          sourcePatch: "tile-layer-data-member-local",
        },
        tileCopyCapabilities: {
          coordinates: "absolute-tile-coordinates",
          clipping: false,
          overlap: "snapshot-source-memmove",
          emptySource: "overwrites-and-clears",
          gidCopy: "exact-encoded-gid",
          observedGidValidation:
            "source-and-destination-fail-closed",
          operationOrdering:
            "sequential-change-set-order-last-write-wins",
          scanBudget:
            "shared-with-replaceTiles-and-floodFill-per-change-set",
          sourcePatch:
            "destination-tile-layer-data-member-local",
        },
        tileReplacementCapabilities: {
          match: "exact-encoded-gid",
          transformMatch: "exact",
          mappingEvaluation: "simultaneous-single-pass",
          emptySource: false,
          nullableTarget: true,
          defaultRegion: "target-layer-bounds",
        },
        objectOperations: ["createObject", "updateObject", "deleteObjects"],
        objectShapeCapabilities: {
          creatable: [
            "rectangle",
            "point",
            "ellipse",
            "capsule",
            "polygon",
            "polyline",
            "text",
          ],
          shapeMutation: false,
          ellipseAndCapsuleDimensions:
            "optional-nonnegative-default-zero",
          polygonAndPolylinePoints: {
            coordinateSpace:
              "object-local-pixels-relative-to-x-y",
            polygonMinimum:
              MIN_POLYGON_OBJECT_POINTS,
            polylineMinimum:
              MIN_POLYLINE_OBJECT_POINTS,
            maximum: MAX_OBJECT_SHAPE_POINTS,
            maximumPerChangeSet:
              MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET,
            replacement: "whole-array",
            budgetScope:
              "create-and-update-points-per-operation-summed",
            order: "preserved",
            polygonClosure: "implicit",
            polylineClosure: "open",
          },
          polygonAndPolylineUpdates:
            "common-fields-and-complete-points-replacement-no-dimensions",
          textObject: {
            wireLayout:
              "flat-on-create-object-and-update-patch",
            fields: [
              "text",
              "fontFamily",
              "pixelSize",
              "wrap",
              "color",
              "bold",
              "italic",
              "underline",
              "strikeout",
              "kerning",
              "horizontalAlignment",
              "verticalAlignment",
            ],
            dimensions:
              "optional-nonnegative-default-zero",
            content: {
              field: "text",
              required: true,
              emptyAllowed: true,
              lengthUnit: "unicode-code-points",
              maximum:
                MAX_TEXT_OBJECT_CONTENT_CODE_POINTS,
              maximumUtf8Bytes:
                MAX_TEXT_OBJECT_CONTENT_UTF8_BYTES,
              unicode:
                "well-formed-no-unpaired-surrogates",
              allowedControlCodePoints: [
                "U+0009",
                "U+000A",
                "U+000D",
              ],
            },
            fontFamily: {
              minimum: 1,
              maximum:
                MAX_TEXT_OBJECT_FONT_FAMILY_CODE_POINTS,
              maximumUtf8Bytes:
                MAX_TEXT_OBJECT_FONT_FAMILY_UTF8_BYTES,
              lengthUnit: "unicode-code-points",
              default:
                TEXT_OBJECT_DEFAULTS.fontFamily,
              unicode:
                "well-formed-no-unpaired-surrogates",
              allowedControlCodePoints: [],
            },
            pixelSize: {
              integer: true,
              minimum: MIN_TEXT_OBJECT_PIXEL_SIZE,
              maximum: MAX_TEXT_OBJECT_PIXEL_SIZE,
              default:
                TEXT_OBJECT_DEFAULTS.pixelSize,
            },
            color: {
              formats: ["#RRGGBB", "#AARRGGBB"],
              default: TEXT_OBJECT_DEFAULTS.color,
            },
            horizontalAlignment: {
              values: [
                ...TEXT_OBJECT_HORIZONTAL_ALIGNMENTS,
              ],
              default:
                TEXT_OBJECT_DEFAULTS.horizontalAlignment,
            },
            verticalAlignment: {
              values: [
                ...TEXT_OBJECT_VERTICAL_ALIGNMENTS,
              ],
              default:
                TEXT_OBJECT_DEFAULTS.verticalAlignment,
            },
            booleanDefaults: {
              wrap: TEXT_OBJECT_DEFAULTS.wrap,
              bold: TEXT_OBJECT_DEFAULTS.bold,
              italic: TEXT_OBJECT_DEFAULTS.italic,
              underline:
                TEXT_OBJECT_DEFAULTS.underline,
              strikeout:
                TEXT_OBJECT_DEFAULTS.strikeout,
              kerning:
                TEXT_OBJECT_DEFAULTS.kerning,
            },
            payloadBudget: {
              measure:
                "canonical-json-utf8-bytes",
              scope:
                "all-present-flat-text-fields-per-operation-summed",
              maximumPerChangeSet:
                MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET,
            },
            updates:
              "common-fields-dimensions-and-partial-flat-text-fields",
            serialization:
              "nested-tmj-text-with-tiled-default-elision",
          },
          sourcePatch:
            "object-layer-objects-member-local",
        },
        objectPropertyUpdateCapabilities: {
          operation: "updateObject-patch-properties",
          writeTypes: [
            ...TILE_PROPERTY_WRITE_TYPES,
          ],
          sharedProfile:
            "identical-to-tileMetadataUpdateCapabilities-property-semantics",
          propertyOrdering:
            "tiled-name-sorted-insert-fail-closed-on-unsorted",
          complexPropertyTargets: "fail-closed",
          untouchedComplexProperties: "preserved",
          propertyTypeMember: "always-written",
          propertyColorInput:
            "rrggbb-or-aarrggbb-stored-verbatim",
          emptiedPropertiesMember: "removed",
          templateAndTileObjects: "fail-closed",
          maxSetsPerUpdate:
            MAX_TILE_PROPERTY_SETS_PER_TILE,
          maxRemovesPerUpdate:
            MAX_TILE_PROPERTY_REMOVES_PER_TILE,
          maxPropertiesPerObject:
            MAX_TILE_PROPERTIES_PER_TILE,
          payloadBudget: {
            measure: "canonical-json-utf8-bytes",
            scope:
              "all-updateObject-property-writes-per-change-set-summed",
            maximumPerChangeSet:
              MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET,
          },
        },
        layerOperations: [
          "updateLayer",
          "deleteLayer",
          "moveLayer",
          "duplicateLayer",
        ],
        layerUpdateCapabilities: {
          layerTypes: [
            "tilelayer",
            "objectgroup",
            "imagelayer",
            "group",
          ],
          fields: [
            "name",
            "className",
            "visible",
            "opacity",
            "offsetX",
            "offsetY",
            "parallaxX",
            "parallaxY",
            "tintColor",
            "locked",
            "blendMode",
          ],
          tintColorNullDeletes: true,
          lockedSemantics: "advisory-metadata",
          sourcePatch: "object-member-local",
        },
        layerDeletionCapabilities: {
          planner: "generic-exclusive-operation-change-set",
          layerTypes: [
            "tilelayer",
            "objectgroup",
            "imagelayer",
            "group",
          ],
          nonEmptyGroupConfirmation:
            "deleteDescendants-true",
          objectReferencePolicy:
            "reject-surviving-typed-references",
          lockedSemantics: "advisory-metadata",
          idHighWaterMarks: "preserved",
          sourcePatch: "array-element-local",
        },
        layerMoveCapabilities: {
          planner: "generic-exclusive-operation-change-set",
          layerTypes: [
            "tilelayer",
            "objectgroup",
            "imagelayer",
            "group",
          ],
          target: "root-or-group",
          indexSemantics:
            "zero-based-final-index-after-move",
          cycleProtection: true,
          depthLimit: 64,
          lockedSemantics: "advisory-metadata",
          idHighWaterMarks: "preserved",
          sourcePatch: "exact-byte-array-element-move",
        },
        layerDuplicationCapabilities: {
          planner: "generic-exclusive-operation-change-set",
          layerTypes: [
            "tilelayer",
            "objectgroup",
            "imagelayer",
            "group",
          ],
          defaultDestination:
            "same-parent-adjacent-above-source",
          indexSemantics:
            "zero-based-final-insertion-index",
          idAllocation:
            "preorder-layer-and-object-ids-from-high-water-marks",
          objectReferencePolicy:
            "rewire-within-copy-retain-external",
          typedReferenceSafety:
            "class-and-template-fail-closed",
          externalFilePolicy: "shared-references",
          lockedSemantics: "advisory-metadata",
          sourcePatch:
            "compact-new-element-existing-bytes-preserved",
          maxSerializedDuplicateBytes:
            MAX_DUPLICATE_LAYER_BYTES,
        },
        checkpointCapabilities: {
          automaticBeforeWrite: true,
          startupPreparedReconciliation: true,
          preparedCreateExactMatch:
            "conflict-provenance-ambiguous",
          boundedListing: true,
          exactByteRestoreKernel: true,
          previewAndApplyRestore: true,
          restoreScope: "single-existing-json-document",
          restoresReferencedDependencies: false,
          preparedDiscard: {
            scope:
              "single-explicit-prepared-checkpoint",
            workflow: "preview-then-apply",
            eligibility:
              "current-target-equals-checkpoint-before-state",
            existingFileEligibility:
              "target-raw-revision-and-size-equal-before",
            createEligibility: "target-missing",
            expectedRevision:
              "sha256-of-raw-manifest-bytes",
            targetObservationCas:
              "required-at-apply",
            lockOrder:
              "target-then-checkpoint-store",
            commitPoint:
              "manifest-unlink-then-checkpoint-directory-fsync",
            garbageCollection:
              "post-commit-fail-closed-unreferenced-objects-and-private-crash-temporaries",
            storedBeforeValidation:
              "not-read-for-discard",
            operatorForcedCommit:
              "dedicated-prepared-adjudication-workflow",
            forceAbandon:
              "dedicated-prepared-adjudication-workflow",
            automaticDeletion: "never",
            projectAssetMutation: false,
            tombstones: false,
          },
          preparedAdjudication: {
            scope:
              "single-explicit-ambiguous-prepared-checkpoint",
            workflow:
              "separate-commit-or-abandon-preview-then-apply",
            genericForceBoolean: "unsupported",
            supportedConflicts: [
              "create-target-matches-after",
              "create-target-unrelated",
              "existing-target-missing",
              "existing-target-unrelated",
            ],
            commitEligibility:
              "create-target-matches-after-only",
            abandonEligibility:
              "ambiguous-conflict-only-machine-reconcilable-states-rejected",
            expectedRevision:
              "action-domain-separated-sha256-of-full-manifest-and-target-evidence",
            targetObservationCas:
              "required-at-apply",
            manifestCas:
              "raw-bytes-and-full-semantic-metadata",
            lockOrder:
              "target-then-checkpoint-store",
            commitPoint:
              "prepared-to-committed-atomic-manifest-rename",
            commitDurability:
              "checkpoint-directory-fsync-after-rename",
            commitPostPointFailure:
              "bounded-success-durability-unconfirmed-without-garbage-collection",
            abandonPoint:
              "prepared-manifest-unlink",
            abandonDurability:
              "checkpoint-directory-fsync-after-unlink",
            abandonPostPointFailure:
              "bounded-success-manifest-deleted-with-fail-closed-garbage-collection",
            abandonGarbageCollection:
              "post-commit-fail-closed-unreferenced-objects-and-private-crash-temporaries",
            projectAssetMutation: false,
            standingApproval: false,
            tombstones: false,
          },
          prune: {
            scope: "single-explicit-committed-checkpoint",
            workflow: "preview-then-apply",
            expectedRevision:
              "sha256-of-raw-manifest-bytes",
            lockOrder:
              "target-then-checkpoint-store",
            commitPoint:
              "manifest-unlink-then-checkpoint-directory-fsync",
            garbageCollection:
              "post-commit-fail-closed-unreferenced-objects-and-private-crash-temporaries",
            preparedCheckpoints:
              "unsupported-reconcile-first",
            automaticRetention:
              "separate-opt-in-post-commit-policy",
            tombstones: false,
          },
          pruneBatch: {
            scope:
              "1-to-32-explicit-committed-checkpoints",
            minCheckpointCount:
              MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
            maxCheckpointCount:
              MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
            workflow: "preview-then-apply",
            ordering:
              "canonical-checkpoint-id",
            lockOrder:
              "sorted-unique-targets-then-checkpoint-store",
            preflight:
              "all-pins-before-first-unlink",
            commitMode:
              "sequential-manifest-unlink-per-item-directory-fsync",
            atomic: false,
            stopOnFirstFailure: true,
            partialResult:
              "cached-final-no-resume",
            garbageCollection:
              CHECKPOINT_PRUNE_BATCH_GARBAGE_COLLECTION,
            storedBeforeValidation:
              "not-read",
            automaticSelection: "none",
            tombstones: false,
          },
          retention: {
            enabled:
              store.checkpoints
                .retainCommittedPerTarget !== undefined,
            retainCommittedPerTarget:
              store.checkpoints
                .retainCommittedPerTarget ?? null,
            minimumRetainedPerTarget:
              MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT,
            mode:
              "rolling-per-target-count-v1",
            defaultMode: "disabled",
            standingApproval:
              "process-startup-config",
            eligibleManifests:
              "v2-rolling-committed-existing-file-only",
            legacyManifests: "always-retained",
            protectedManifests:
              "always-retained",
            preparedManifests: "always-retained",
            ordering:
              "durable-monotonic-ordinal",
            maxManifestDeletionsPerCommit: 1,
            backlogConvergence:
              "one-add-one-delete-does-not-reduce-existing-excess-explicit-prune-required",
            trigger:
              "successful-checkpoint-commit-only",
            targetDurability:
              "required-no-post-replace-warning",
            startupSweep: false,
            periodicSweep: false,
            lockOrder:
              "target-then-checkpoint-store",
            targetValidation:
              "current-target-equals-newest-rolling-after-revision",
            incompleteInventory:
              "block-before-first-manifest-unlink",
            quotaPressure:
              "orphan-gc-only-no-valid-manifest-deletion",
            resultChannel:
              "commit-result-checkpointRetention",
            previewLease:
              "unsupported-apply-may-be-invalidated",
          },
          storagePolicy: {
            ...CHECKPOINT_STORAGE_POLICY,
            maxBytes:
              store.checkpoints.maxBytes,
            maxEntries:
              store.checkpoints.maxEntries,
            garbageCollectionTrigger:
              "quota-pressure-approved-checkpoint-prune-approved-prepared-discard-approved-prepared-abandon-automatic-rolling-post-commit-or-explicit-internal-call",
            quotaFailureCode:
              "CHECKPOINT_QUOTA_EXCEEDED",
          },
        },
        mapCreationCapabilities: {
          profile:
            "finite-orthogonal-empty-tmj",
          mapFormatVersion: "1.10",
          tiledCompatibilityBaseline:
            "1.12.2",
          commitMode:
            "direct-additive-no-preview-no-replace",
          approvalBoundary:
            "client-tool-call",
          destinationPrecondition:
            "must-not-exist",
          contentEquality:
            "existing-identical-bytes-still-file-already-exists",
          parentDirectory:
            "must-already-exist",
          retrySemantics:
            "non-idempotent-reinspect-target-before-retry",
          failedAttemptCheckpoint:
            "may-remain-prepared",
          atomicPromotion:
            "same-directory-hard-link-no-replace",
          checkpointBeforeState:
            "existed-false",
          checkpointRestore:
            "revert-would-delete-not-supported",
        },
        tilesetCreationCapabilities: {
          profile:
            "external-atlas-tsj-from-project-image",
          tilesetFormatVersion: "1.10",
          tiledCompatibilityBaseline: "1.12.2",
          commitMode:
            "preview-approve-apply-no-replace",
          expectedRevisionSemantics:
            "sha256-of-approved-prospective-bytes",
          beforeRevision: "null-on-apply",
          destinationPrecondition:
            "must-not-exist-at-preview-and-apply",
          contentEquality:
            "existing-identical-bytes-still-file-already-exists",
          parentDirectory: "must-already-exist",
          gridFormula:
            "tiled-1-12-2-single-margin-integer-division",
          imagePin: "path-and-raw-revision",
          memberOrder:
            "tiled-qjson-alphabetical",
          nameDefault:
            "tileset-file-stem",
          maxTileEdge:
            MAX_CREATE_TILESET_TILE_EDGE,
          maxMargin: MAX_CREATE_TILESET_MARGIN,
          maxSpacing: MAX_CREATE_TILESET_SPACING,
          directCreationException:
            "tiled_create_map-only-clause-unchanged",
        },
        fileDeletionCapabilities: {
          form: "preview-approve-apply",
          targets: [".tmj", ".tsj"],
          referenceScan: {
            coverage: [
              "tmj-map-tileset-sources",
              "json-world-map-members",
              "json-template-tileset-sources",
              "tmx-map-tileset-sources",
              "xml-template-tileset-sources",
            ],
            xmlAssets:
              "scanned-via-bounded-fail-closed-xml-reader",
            patternWorlds: "fail-closed",
            malformedReferrers: "fail-closed",
            reruns: "preview-and-apply",
            maxCandidateReferrers:
              MAX_DELETE_REFERENCE_SCAN_ASSETS,
            maxScannedBytes:
              MAX_DELETE_REFERENCE_SCAN_BYTES,
            referencedBySample:
              MAX_DELETE_REFERRER_SAMPLE,
          },
          checkpointPolicy:
            "committed-before-unlink",
          recovery:
            "checkpoint-restore-recreates-missing-target",
          missingTargetRestoreRevision:
            "sha256-of-restorable-content",
          expectedRevisionSemantics:
            "sha256-of-current-target-bytes",
        },
        transactionCapabilities: {
          form: "compose-approved-change-sets",
          previewTool:
            "tiled_preview_transaction",
          memberKinds: [
            "mapEdit",
            "tilesetEdit",
            "tilesetCreate",
            "fileDelete",
          ],
          minMembers: MIN_TRANSACTION_MEMBERS,
          maxMembers: MAX_TRANSACTION_MEMBERS,
          maxPendingTransactions:
            MAX_PENDING_TRANSACTIONS,
          maxStagedBytes:
            MAX_TRANSACTION_STAGED_BYTES,
          memberTargets:
            "pairwise-distinct-paths",
          memberOwnership:
            "locked-against-individual-apply-while-pending",
          expectedRevisionSemantics:
            "sha256-of-ordered-target-pins",
          journal:
            "redo-journal-content-addressed-staging",
          commitPoint:
            "manifest-committed-atomic-rename",
          crashBeforeCommitPoint:
            "rolled-back-on-startup",
          crashAfterCommitPoint:
            "rolled-forward-on-startup",
          divergedTargetRecovery:
            "single-target-conflict-others-roll-forward",
          perTargetCheckpoints:
            "committed-before-promotion",
          memberCoupling:
            "pre-state-consistent-pins-allowed-mismatched-pins-rejected",
          createAttachCoupling:
            "add-tileset-preview-accepts-pending-create-change-set",
        },
        tileDataReadCapabilities: {
          readTools: [
            "tiled_get_region",
            "tiled_render_preview",
            "tiled_analyze_usage",
            "tiled_render_map",
          ],
          arrayEncoding: "csv-or-absent",
          encodedEncoding: "base64",
          compressions: [
            ...TILE_DATA_READ_COMPRESSIONS,
          ],
          base64: "strict-canonical",
          decodedSize:
            "exact-width-height-4-bytes",
          cellLayout:
            "little-endian-uint32-row-major",
          maxDecodedBytesPerLayer:
            MAX_DECODED_TILE_DATA_BYTES,
          chunkedLayers:
            "summary-region-usage-preview-reads-set-tiles-stamp-writes",
          chunkCoordinates:
            "absolute-tile-space-negative-allowed",
          chunkOverlap: "fail-closed",
          outsideChunkCells: "empty",
          maxChunksPerLayer:
            MAX_TILE_LAYER_CHUNKS,
          infiniteMaps:
            "all-tile-operations-editable-except-resize",
          chunkedWriteProfile:
            "tiled-canonical-rebucket-chunksize-drop-empty-sort-y-x-bounds-union",
          chunkedWriteOperations: [
            "setTiles",
            "fillRegion",
            "stampPattern",
            "floodFill",
            "copyRegion",
            "replaceTiles",
            "transcodeTileLayer",
          ],
          chunkedReplaceScan:
            "stored-nonzero-cells-only",
          chunkedFloodFillBounds:
            "used-chunk-union-seed-outside-fills-nothing",
          collectionTilesets:
            "summary-region-object-details-search-sheet-preview-reads-metadata-updates-sparse-ids-fail-closed",
          collectionTileEntryEdits:
            "create-from-verified-image-and-remove-unreferenced-exclusive-structural-updates-last-entry-fail-closed",
          collectionPreviewTiles:
            "own-size-bottom-left-cell-anchor-upward-overflow-each-used-tile-counts-as-one-atlas-source",
          writeProfile:
            "arrays-editable-encoded-rewritten-in-kind",
          writeCompression:
            "same-encoding-and-compression-as-stored-no-implicit-transcoding",
          explicitTranscode:
            "exclusive-transcode-tile-layer-operation-chunked-layers-normalize",
          unwrittenEncodedLayers:
            "exact-original-bytes",
          netNoOpEncodedWrites:
            "exact-original-bytes",
          encodedResize: "fail-closed",
          validateDiagnostics:
            "encoded-data-still-reported-as-uneditable",
        },
        objectTemplateCapabilities: {
          readProfile:
            "tiled-sync-with-template-v1",
          tools: ["tiled_get_object"],
          format: "json-tj-only",
          tileTemplates: "fail-closed",
          nestedTemplates: "fail-closed",
          propertiesSource: "instance-only",
          listProjection:
            "template-shape-marker-unexpanded",
          templatePin: "path-and-raw-revision",
        },
        wangEditCapabilities: {
          tool: "tiled_update_wangsets",
          operations: [
            "addWangSet",
            "addWangColor",
            "setWangTiles",
          ],
          maxOperations:
            MAX_WANG_EDIT_OPERATIONS,
          maxAssignmentsPerOperation:
            MAX_WANG_ASSIGNMENTS_PER_OPERATION,
          maxWangSetsPerTileset:
            MAX_WANG_SETS_PER_TILESET,
          maxColorsPerSet:
            MAX_TILESET_WANG_COLORS_PER_SET,
          assignmentSemantics:
            "tiled-set-wang-id-all-zero-removes",
          saveOrder: "ascending-tile-id",
          collectionTilesets: "fail-closed",
          legacyColorSets: "fail-closed",
        },
        embeddedTilesetCapabilities: {
          readTools: [
            "tiled_get_map_summary",
            "tiled_get_region",
            "tiled_get_tileset",
            "tiled_render_preview",
          ],
          detailLocator:
            "map-path-plus-embedded-index",
          profile: "embedded-atlas-only",
          imageCollections: "fail-closed",
          legacyTerrains: "fail-closed",
          pin: "map-revision-only",
          editable:
            "per-tile-metadata-via-map-patch-structural-fail-closed",
          editTools: ["tiled_update_tile"],
          renderable:
            "tile-layers-only-map-relative-image",
          tileObjects: "fail-closed",
        },
        tilesetSheetCapabilities: {
          supportedFormats: ["png", "jpeg", "webp", "simple-svg"],
          pageIndexBase: 0,
          defaultPageSize: DEFAULT_TILESET_SHEET_PAGE_SIZE,
          defaultScale: DEFAULT_TILESET_SHEET_SCALE,
          consecutiveLocalIds: true,
          collectionPages:
            "ascending-sparse-ids-max-64-per-tile-images-verified-revision-pinned",
          collectionCellLayout:
            "largest-page-tile-sized-cells",
          semanticNames: false,
        },
        tileRenderCapabilities: {
          locator:
            "map-path-plus-tileset-asset-id",
          renderProfile:
            "explicit-local-id-atlas-selection-v1",
          collectionRenderProfile:
            "explicit-local-id-collection-selection-v1",
          collectionTiles:
            "per-tile-images-verified-revision-pinned-sparse-ids-fail-closed",
          collectionCellLayout:
            "largest-selected-tile-sized-cells",
          atlasProfile:
            "root-atlas-no-per-tile-images",
          supportedFormats: [
            "png",
            "jpeg",
            "webp",
            "simple-svg",
          ],
          selection: "explicit-local-ids",
          localIdOrder: "input-preserved",
          duplicateLocalIds: "reject",
          selectionReduction: "never",
          layout: "row-major",
          columnsSemantics: "maximum-per-row",
          labels: "local-id",
          defaultColumns:
            DEFAULT_TILE_RENDER_COLUMNS,
          defaultScale: DEFAULT_TILE_RENDER_SCALE,
          revisionPins: "independent-optional",
          animation: false,
          wangGrouping: false,
          semanticNames: false,
        },
        tilesetDetailCapabilities: {
          locator: "map-path-plus-tileset-asset-id",
          tileMetadataOrder: "local-id",
          tileClassField: "type-with-class-compatibility-fallback",
          defaultLimit: DEFAULT_TILESET_METADATA_LIMIT,
          returnsAllDependencyRevisions: false,
          returnsPropertyValues: false,
          returnsCollisionGeometry: false,
          returnsWangAssignments: false,
          validatesRenderingEnums: true,
        },
        tileFindCapabilities: {
          locator: "map-path-plus-tileset-asset-id",
          queryModes: ["all", "any"],
          defaultQueryMode: "all",
          queryKinds: ["class", "propertyExists", "propertyEquals"],
          propertyEqualsTypes: TILE_FIND_PROPERTY_EQUALS_TYPES,
          customOrComplexPropertyEquals: "reject-query",
          comparison: "case-sensitive-exact",
          tileClassField: "type-with-class-compatibility-fallback",
          candidates: "explicit-tiles-metadata-only",
          returnsTileRefs: true,
          returnsPropertyValues: false,
          resolvesInheritedProperties: false,
          wangAssignments: false,
          nextPageIncludesRevisionPins: true,
          inputRevisionPins: "optional",
        },
        usageAnalysisCapabilities: {
          profile:
            "finite-orthogonal-tmj-external-atlas-tsj",
          includesTileLayerCells: true,
          includesTileObjects: true,
          visibility: "all-serialized-layers",
          transformAggregation: "base-tile",
          unusedLocalIdDomain:
            "zero-to-tilecount-exclusive",
          output: "bounded-summary-and-samples",
          optionalExactReadSetPins: true,
          snapshotConsistency: "non-atomic-read-set",
          defaultTopTileLimit:
            DEFAULT_USAGE_TOP_TILE_LIMIT,
        },
        tilesetReferenceCapabilities: {
          planner: "dedicated-single-operation-change-set",
          targetProfile: "project-local-external-root-atlas-tsj",
          firstGidAllocation: "after-highest-occupied-range",
          existingDependencyPins: "required-exact",
          targetRevisionPin: "optional-capture-current",
          writeTarget: "map-only",
          removalPlanner:
            "generic-exclusive-operation-change-set",
          removalPolicy: "unused-only",
          removalLocator: "tileset-asset-id",
          removalSourcePatch: "array-element-local",
        },
        layerCreationCapabilities: {
          planner: "dedicated-single-operation-change-set",
          mapProfile: "finite-orthogonal-tmj",
          types: [
            "tilelayer",
            "objectgroup",
            "imagelayer",
            "group",
          ],
          placement: "root-or-group-zero-based-index",
          idAllocation: "current-nextlayerid",
          imageSource:
            "project-local-revision-pinned-safe-image",
          writeTarget: "map-only",
        },
        nativePreviewCapabilities: {
          renderProfile:
            "finite-orthogonal-static-atlas-tilelayers-v1",
          supportedFormats: ["png", "jpeg", "webp", "simple-svg"],
          defaultScale: DEFAULT_NATIVE_PREVIEW_SCALE,
          layerSelection: ["visible", "explicit"],
          overlays: [
            "grid",
            "coordinates",
            "highlights",
            "objectIds",
            "tileObjectCollision",
          ],
          regionCoordinates: "absolute-map-tiles",
          highlightRectangles: {
            coordinateSpace: "absolute-map-tiles",
            maxRectangles: MAX_NATIVE_PREVIEW_HIGHLIGHTS,
            intersectionPolicy:
              "require-intersection-and-clip-to-tile-region",
            style: NATIVE_PREVIEW_HIGHLIGHT_STYLE,
            color: NATIVE_PREVIEW_HIGHLIGHT_COLOR,
            blendMode:
              NATIVE_PREVIEW_HIGHLIGHT_BLEND_MODE,
            overlapMode:
              NATIVE_PREVIEW_HIGHLIGHT_OVERLAP_MODE,
            border: "none",
            drawOrder:
              "after-tile-layers-before-grid-and-coordinates",
            workBudget:
              "included-in-native-preview-pixel-blend-limit",
          },
          objectDebug: {
            selection: "explicit-object-ids",
            maxObjects: MAX_NATIVE_PREVIEW_OBJECTS,
            maxAggregatePoints:
              MAX_NATIVE_PREVIEW_OBJECT_POINTS,
            pointBudget:
              "selected-polygon-and-polyline-points",
            duplicateObjectIds: "reject",
            supportedShapes: [
              "rectangle",
              "point",
              "ellipse",
              "capsule",
              "polygon",
              "polyline",
              "text",
              "tile",
            ],
            representations: [
              "geometry-outline",
              "text-box-only",
              "tile-frame-only",
              "tile-frame-and-collision",
            ],
            profile: NATIVE_PREVIEW_OBJECT_PROFILE,
            style: NATIVE_PREVIEW_OBJECT_STYLE,
            color: NATIVE_PREVIEW_OBJECT_COLOR,
            strokeWidth:
              NATIVE_PREVIEW_OBJECT_STROKE_WIDTH,
            originMarker:
              NATIVE_PREVIEW_OBJECT_ORIGIN_MARKER,
            idLabels: false,
            visibilityPolicy:
              NATIVE_PREVIEW_OBJECT_VISIBILITY_POLICY,
            drawOrder:
              NATIVE_PREVIEW_OBJECT_DRAW_ORDER,
            quantization:
              NATIVE_PREVIEW_OBJECT_QUANTIZATION,
            curveTessellation: {
              algorithm:
                NATIVE_PREVIEW_OBJECT_CURVE_TESSELLATION,
              maximumChordErrorPixels:
                NATIVE_PREVIEW_OBJECT_CURVE_MAX_ERROR_PIXELS,
              minimumSegments:
                MIN_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
              maximumSegmentsPerObject:
                MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
              maximumAggregateSegments:
                MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS_AGGREGATE,
              segmentMultiple: 4,
              errorSpace:
                "continuous-output-before-quantization",
              overflowPolicy:
                "reject-whole-preview",
              offscreenPolicy:
                "conservative-rotated-bounds-skip-before-tessellation",
              capsuleConstruction:
                "two-semicircles-plus-two-straight-segments",
              degenerateExtent:
                "tiled-1.12-single-zero-line-double-zero-anchor-centered-20-map-pixel-circle",
            },
            tileObjectFrames:
              NATIVE_PREVIEW_TILE_OBJECT_FRAMES,
            tileObjectCollision:
              NATIVE_PREVIEW_TILE_OBJECT_COLLISION,
            workBudget:
              "included-in-native-preview-pixel-blend-limit",
            limitations: [
              "explicit-selection-only",
              "tile-frame-only-no-image-or-collision-rendering",
              "text-box-only-no-glyph-rendering",
              "template-objects-unsupported",
              "non-default-selected-layer-or-ancestor-positioning-unsupported",
            ],
          },
          reportsOmittedVisibleLayers: true,
        },
        rasterMapCapabilities: {
          registration:
            "when-tmxrasterizer-version-probe-succeeds",
          artifactMetadata:
            "traceable-inline-png-v1",
          rendererVersionSource:
            "startup-capability-probe",
          sourceRevisionCoverage:
            "map-and-external-tsj-only",
          inputImageRevisionCoverage:
            "validated-before-and-after-not-reported",
          snapshotValidation:
            "before-and-after-render",
          snapshotConsistency:
            "non-atomic-read-set",
          effectiveOptionsReturned: true,
        },
        limits: {
          maxDocumentBytes: 64 * 1024 * 1024,
          maxAggregateTilesetDependencyBytes: 64 * 1024 * 1024,
          maxCreateMapDimension:
            MAX_CREATE_MAP_DIMENSION,
          maxCreateMapTileEdge:
            MAX_CREATE_MAP_TILE_EDGE,
          maxRegionCells: 20_000,
          maxChangeSetCellWrites: MAX_CELL_WRITES,
          maxPendingChangeSetCellWrites: DEFAULT_MAX_PENDING_CELL_WRITES,
          maxPendingObjectShapePoints:
            DEFAULT_MAX_PENDING_OBJECT_SHAPE_POINTS,
          maxPendingTextObjectPayloadBytes:
            DEFAULT_MAX_PENDING_TEXT_OBJECT_PAYLOAD_BYTES,
          maxStampPatternEdge: MAX_STAMP_PATTERN_EDGE,
          maxStampPatternCells:
            MAX_STAMP_PATTERN_CELLS,
          maxTileUpdatesPerChangeSet:
            MAX_TILE_UPDATES_PER_CHANGE_SET,
          maxTileAnimationFramesPerTile:
            MAX_TILE_ANIMATION_FRAMES_PER_TILE,
          maxTileAnimationFrameDurationMs:
            MAX_TILE_ANIMATION_FRAME_DURATION_MS,
          maxTileClassNameCodePoints:
            MAX_TILE_CLASS_NAME_CODE_POINTS,
          maxTileProbability: MAX_TILE_PROBABILITY,
          maxTilePropertySetsPerTile:
            MAX_TILE_PROPERTY_SETS_PER_TILE,
          maxTilePropertyRemovesPerTile:
            MAX_TILE_PROPERTY_REMOVES_PER_TILE,
          maxTilePropertiesPerTile:
            MAX_TILE_PROPERTIES_PER_TILE,
          maxTilePropertyNameCodePoints:
            MAX_TILE_PROPERTY_NAME_CODE_POINTS,
          maxTilePropertyValueCodePoints:
            MAX_TILE_PROPERTY_VALUE_CODE_POINTS,
          maxResizeMapDimension:
            MAX_RESIZE_MAP_DIMENSION,
          maxResizeOffsetMagnitude:
            MAX_RESIZE_OFFSET_MAGNITUDE,
          maxResizeSourceCellScans:
            MAX_RESIZE_SOURCE_CELL_SCANS,
          maxResizeCroppedCellSample:
            MAX_RESIZE_CROPPED_CELL_SAMPLE,
          maxObjectMutationsPerChangeSet: 10_000,
          maxEditedSubtreesPerChangeSet: 128,
          maxListedObjects: 10_000,
          maxInlineImageBytes: MAX_INLINE_IMAGE_BYTES,
          maxRenderEdge:
            MAX_RASTER_RENDER_EDGE,
          maxRasterInputImages:
            MAX_RASTER_INPUT_IMAGES,
          maxRasterInputAggregateBytes:
            MAX_RASTER_INPUT_AGGREGATE_BYTES,
          maxRasterInputAggregatePixels:
            MAX_RASTER_INPUT_AGGREGATE_PIXELS,
          maxRasterInputEdge:
            MAX_RASTER_INPUT_EDGE,
          maxTilesetImageBytes: MAX_TILESET_IMAGE_BYTES,
          maxSimpleSvgBytes: MAX_SIMPLE_SVG_BYTES,
          maxTilesetImageEdge: MAX_TILESET_INPUT_EDGE,
          maxTilesetDecodedPixels: MAX_TILESET_INPUT_PIXELS,
          maxTilesetSheetBytes: MAX_TILESET_SHEET_BYTES,
          maxTilesetSheetEdge: MAX_TILESET_SHEET_EDGE,
          maxTilesetSheetPixels: MAX_TILESET_SHEET_PIXELS,
          maxTilesetSheetPageSize: MAX_TILESET_SHEET_PAGE_SIZE,
          maxTilesetSheetColumns: MAX_TILESET_SHEET_COLUMNS,
          maxTilesetSheetScale: MAX_TILESET_SHEET_SCALE,
          maxTileRenderLocalIds:
            MAX_TILE_RENDER_LOCAL_IDS,
          maxTileRenderColumns:
            MAX_TILE_RENDER_COLUMNS,
          maxTileRenderScale:
            MAX_TILE_RENDER_SCALE,
          maxTileRenderBytes:
            MAX_TILE_RENDER_BYTES,
          maxTileRenderEdge: MAX_TILE_RENDER_EDGE,
          maxTileRenderPixels:
            MAX_TILE_RENDER_PIXELS,
          maxTilesetMetadataLimit: MAX_TILESET_METADATA_LIMIT,
          maxTilesetMetadataEntries: MAX_TILESET_METADATA_ENTRIES,
          maxTilesetAnimationFrames: MAX_TILESET_ANIMATION_FRAMES,
          maxTilesetAnimationFrameSample:
            MAX_TILESET_ANIMATION_FRAME_SAMPLE,
          maxTilesetCollisionObjects: MAX_TILESET_COLLISION_OBJECTS,
          maxTilesetPropertyEntries: MAX_TILESET_PROPERTY_ENTRIES,
          maxTilesetWangSets: MAX_TILESET_WANG_SETS,
          maxTilesetWangSetSummaries:
            MAX_TILESET_WANG_SET_SUMMARIES,
          maxTilesetWangColorsPerSet:
            MAX_TILESET_WANG_COLORS_PER_SET,
          maxTilesetWangColors:
            MAX_TILESET_WANG_COLORS,
          maxTilesetWangTiles:
            MAX_TILESET_WANG_TILES,
          maxTilesetWangTileSample:
            MAX_TILESET_WANG_TILE_SAMPLE,
          wangIdIndexCount: WANG_ID_INDEX_COUNT,
          maxTilesetDetailDisplayCodePoints:
            MAX_TILESET_DETAIL_DISPLAY_CODE_POINTS,
          maxTilesetDetailResultBytes:
            MAX_TILESET_DETAIL_RESULT_BYTES,
          maxTileFindLimit: MAX_TILE_FIND_LIMIT,
          maxTileFindClauses: MAX_TILE_FIND_CLAUSES,
          maxTileFindQueryBytes: MAX_TILE_FIND_QUERY_BYTES,
          maxTileFindQueryCodePoints:
            MAX_TILE_FIND_QUERY_CODE_POINTS,
          maxTileFindValueCodePoints:
            MAX_TILE_FIND_VALUE_CODE_POINTS,
          maxTileFindEvaluations: MAX_TILE_FIND_EVALUATIONS,
          maxTileFindResultBytes: MAX_TILE_FIND_RESULT_BYTES,
          maxAddTilesetGidScans: MAX_ADD_TILESET_GID_SCANS,
          maxRemoveTilesetGidScans:
            MAX_REMOVE_TILESET_GID_SCANS,
          maxSerializedDuplicateBytes:
            MAX_DUPLICATE_LAYER_BYTES,
          maxReplaceTileMappings: MAX_REPLACE_TILE_MAPPINGS,
          maxTileOperationScans:
            MAX_TILE_OPERATION_SCANS,
          maxFloodFillScans: MAX_FLOOD_FILL_SCANS,
          maxReplaceTileScans: MAX_REPLACE_TILE_SCANS,
          maxUsageScanValues: MAX_USAGE_SCAN_VALUES,
          maxUsageDistinctTiles:
            MAX_USAGE_DISTINCT_TILES,
          maxUsageTopTileLimit:
            MAX_USAGE_TOP_TILE_LIMIT,
          maxUsageLayerSummaries:
            MAX_USAGE_LAYER_SUMMARIES,
          maxUsageTilesetSummaries:
            MAX_USAGE_TILESET_SUMMARIES,
          maxUsageUnusedLocalIdSample:
            MAX_USAGE_UNUSED_LOCAL_ID_SAMPLE,
          maxUsageResultBytes: MAX_USAGE_RESULT_BYTES,
          maxCreateTileLayerCells:
            MAX_CREATE_TILE_LAYER_CELLS,
          maxLayerNameLength: MAX_LAYER_NAME_LENGTH,
          maxNativePreviewBytes: MAX_NATIVE_PREVIEW_BYTES,
          maxNativePreviewEdge: MAX_NATIVE_PREVIEW_EDGE,
          maxNativePreviewPixels: MAX_NATIVE_PREVIEW_PIXELS,
          maxNativePreviewScale: MAX_NATIVE_PREVIEW_SCALE,
          maxNativePreviewHighlights:
            MAX_NATIVE_PREVIEW_HIGHLIGHTS,
          maxNativePreviewObjects:
            MAX_NATIVE_PREVIEW_OBJECTS,
          maxNativePreviewObjectCurveSegments:
            MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
          maxNativePreviewObjectCurveSegmentsAggregate:
            MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS_AGGREGATE,
          maxNativePreviewTileCollisionShapes:
            MAX_NATIVE_PREVIEW_TILE_COLLISION_SHAPES,
          maxNativePreviewTileCollisionShapesAggregate:
            MAX_NATIVE_PREVIEW_TILE_COLLISION_SHAPES_AGGREGATE,
          maxNativePreviewRegionCells: MAX_PREVIEW_REGION_CELLS,
          maxNativePreviewLayers: MAX_PREVIEW_LAYERS,
          maxNativePreviewTileDraws: MAX_PREVIEW_TILE_DRAWS,
          maxNativePreviewPixelBlends: MAX_NATIVE_PREVIEW_PIXEL_BLENDS,
          maxNativePreviewAtlases: MAX_PREVIEW_ATLASES,
          maxNativePreviewOmittedLayers: MAX_PREVIEW_OMITTED_LAYERS,
          maxNativePreviewLayerLabelLength:
            MAX_PREVIEW_LAYER_LABEL_LENGTH,
          maxNativePreviewAggregateImageBytes:
            MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES,
          maxNativePreviewAggregateDecodedPixels:
            MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS,
        },
        safetyStatus: {
          jsonLexicalPreservation: {
            outsideEditedRanges: true,
            editedRangesReformatted: true,
          },
        },
        filesystemThreatModelContract:
          TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT,
        textContentContract: {
          name: TEXT_CONTENT_CONTRACT_NAME,
          version: TEXT_CONTENT_CONTRACT_VERSION,
          encoding: "compact-json",
          maxBytes: MAX_TEXT_CONTENT_BYTES,
          fullResult: "structuredContent.result",
          structuredByteMeasure: "utf8-json-stringify",
          sdkInputErrors: "sdk-owned-text-only",
        },
        applicationErrorContract: {
          name:
            TILED_MCP_APPLICATION_ERROR_REGISTRY.name,
          registryVersion:
            TILED_MCP_APPLICATION_ERROR_REGISTRY.registryVersion,
          resourceUri:
            APPLICATION_ERROR_RESOURCE_URI,
          revision:
            APPLICATION_ERROR_RESOURCE_META.revision,
          size:
            APPLICATION_ERROR_RESOURCE_META.size,
          wireLocation:
            TILED_MCP_APPLICATION_ERROR_REGISTRY.wireLocation,
          fallbackCode:
            TILED_MCP_APPLICATION_ERROR_REGISTRY.fallbackCode,
          codeSetPolicy:
            TILED_MCP_APPLICATION_ERROR_REGISTRY.compatibility.additions,
          clientUnknownCodePolicy:
            TILED_MCP_APPLICATION_ERROR_REGISTRY.compatibility.clientUnknownCodePolicy,
          messages:
            TILED_MCP_APPLICATION_ERROR_REGISTRY.messages,
          details:
            TILED_MCP_APPLICATION_ERROR_REGISTRY.details,
          sdkInputErrors:
            "excluded-sdk-owned-text-only",
        },
        assetIdentityContract: {
          name: "tiled-mcp-asset-identity",
          version: 2,
          idFormat:
            "asset_<24-lowercase-hex>",
          clientTreatment: "opaque",
          scope: "configured-project-root",
          coveredKinds: [
            "external-tileset",
            "image-layer",
          ],
          registryFormat: ASSET_REGISTRY_FORMAT,
          registryFormatVersion:
            ASSET_REGISTRY_FORMAT_VERSION,
          restartPersistence:
            "same-project-internal-state",
          initialAssignment:
            "legacy-path-hash-compatible",
          samePathContinuity:
            "preserve-across-content-replacement",
          resolutionOrder:
            "same-kind-canonical-path-before-file-identity",
          renameContinuity:
            "best-effort-unique-stable-file-identity",
          renameEvidence:
            "unique-same-kind-device-inode-nonzero-birthtime-old-path-absent",
          registeredPathSwap:
            "keep-path-ids-refresh-identity",
          weakIdentityEvidence:
            "inode-zero-or-birthtime-zero-does-not-rebind",
          unobservedHardlinkThenOldPathRemoved:
            "indistinguishable-from-rename-may-inherit-old-id",
          contentEquality: "not-identity",
          unmatchedOrCrossFilesystemMove:
            "allocate-new-id",
          corruptionPolicy:
            "startup-fatal-runtime-application-error-fail-closed",
          loadLimitPolicy:
            "startup-fatal-as-corrupt",
          mutationLimitPolicy:
            "runtime-application-error-fail-closed",
          registryLossPolicy:
            "ids-may-be-reassigned",
          crashDurability:
            "not-guaranteed-first-internal-directory-parent-not-fsynced",
          readOnlyToolEffect: "none",
          identityPersistenceBoundary:
            "write-tool-paths-only-reads-and-previews-resolve-lock-free",
        },
        cli: cliCapabilities,
        registeredTools: advertisedToolNames,
      };
  const capabilitiesToolOutputSchema =
    toolOutputSchema(
      exactJsonValueOutputSchema(
        capabilitiesResult,
        (jsonPointer) => {
          if (
            jsonPointer ===
              "/checkpointCapabilities/storagePolicy/maxBytes" ||
            jsonPointer ===
              "/checkpointCapabilities/storagePolicy/maxEntries"
          ) {
            return z
              .number()
              .int()
              .min(1)
              .max(Number.MAX_SAFE_INTEGER);
          }
          if (
            jsonPointer ===
            "/checkpointCapabilities/retention/enabled"
          ) {
            return z.boolean();
          }
          if (
            jsonPointer ===
            "/checkpointCapabilities/retention/retainCommittedPerTarget"
          ) {
            return z
              .number()
              .int()
              .min(
                MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT,
              )
              .max(MAX_CHECKPOINT_OBSERVED_ENTRIES)
              .nullable();
          }
          if (jsonPointer === "/cli") {
            return cliCapabilitiesOutputSchema;
          }
          if (jsonPointer === "/serverVersion") {
            return z.string().min(1);
          }
          if (jsonPointer === "/registeredTools") {
            return registeredToolNamesOutputSchema;
          }
          return undefined;
        },
      ),
    );

  /**
   * Registrars keyed by tool name.
   *
   * Registration is driven by `advertisedToolNames` below, so the advertised
   * order IS the registration order by construction. The frozen name list and
   * the registration sequence can no longer drift apart, which previously was
   * only caught by a runtime comparison after every tool had been registered.
   * Optional tools define a registrar only when their CLI probe succeeded --
   * exactly the condition under which they are advertised.
   */
  const toolRegistrars: Partial<
    Record<AdvertisedToolName, () => void>
  > = {};

  toolRegistrars["tiled_get_capabilities"] = () =>
  register(
    server,
    registeredTools,
    "tiled_get_capabilities",
    {
      title: "Inspect TiledMCP capabilities",
      description:
        "Returns the implemented edit profile, frozen direct-filesystem threat model and operational requirements, and locally available Tiled command-line adapters.",
      inputSchema: z.object({}).strict(),
      outputSchema:
        capabilitiesToolOutputSchema,
      annotations: READ_ONLY,
    },
    async () =>
      toolResult(capabilitiesResult),
  );

  toolRegistrars["tiled_list_files"] = () =>
  register(
    server,
    registeredTools,
    "tiled_list_files",
    {
      title: "List Tiled project files",
      description:
        "Lists map, tileset, template, world and project assets under the configured project root.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(10_000).default(10_000) }).strict(),
      outputSchema: listFilesToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ limit }) => executeTool(() => resolver.listAssets(limit)),
  );

  toolRegistrars["tiled_list_world_maps"] = () =>
  register(
    server,
    registeredTools,
    "tiled_list_world_maps",
    {
      title: "List JSON world map members",
      description:
        "Reads one project-local JSON .world file and returns its explicit map members with world coordinates, declared sizes, per-member existence and pinned revisions, plus world custom properties. Pattern-based members are counted only by default; pass expandPatterns to match them with World::allMaps semantics — every pattern partially matches project-asset file names in exactly the world's own directory, two capture groups become x/y through the multipliers and offsets, sizes default to the absolute multipliers, and expanded members append after explicit ones without deduplication, marked fromPattern with their patternIndex.",
      inputSchema: z
        .object({
          worldPath: projectPathSchema,
          expandPatterns: z
            .boolean()
            .optional(),
        })
        .strict(),
      outputSchema:
        worldListToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ worldPath, expandPatterns }) =>
      executeTool(() =>
        maps.listWorldMaps({
          worldPath,
          expandPatterns,
        }),
      ),
  );


  toolRegistrars["tiled_list_property_types"] = () =>
  register(
    server,
    registeredTools,
    "tiled_list_property_types",
    {
      title: "List project property types",
      description:
        "Reads one project-local .tiled-project file and returns its propertyTypes definitions verbatim — the authoritative source of class member and enum type annotations that TMJ documents themselves never carry. Read-only; malformed entries fail closed.",
      inputSchema: z
        .object({
          projectFilePath: projectPathSchema,
        })
        .strict(),
      outputSchema:
        listPropertyTypesToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ projectFilePath }) =>
      executeTool(() =>
        maps.listPropertyTypes(projectFilePath),
      ),
  );

  toolRegistrars["tiled_list_checkpoints"] = () =>
  register(
    server,
    registeredTools,
    "tiled_list_checkpoints",
    {
      title: "List recovery checkpoints",
      description:
        "Lists bounded checkpoint manifests and separately reports corrupt entries. This tool never restores or deletes files.",
      inputSchema: z
        .object({
          status: z.enum(["prepared", "committed"]).optional(),
          limit: z.number().int().min(1).max(1_000).default(100),
          scanLimit: z.number().int().min(1).max(10_000).default(1_000),
        })
        .strict(),
      outputSchema:
        checkpointListToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ status, limit, scanLimit }) =>
      executeTool(() =>
        store.checkpoints.list({
          limit,
          scanLimit,
          ...(status === undefined ? {} : { status }),
        }),
      ),
  );

  toolRegistrars["tiled_create_checkpoint"] = () =>
  register(
    server,
    registeredTools,
    "tiled_create_checkpoint",
    {
      title: "Create explicit checkpoints",
      description:
        "Creates committed recovery checkpoints of the exact current bytes of 1 to 32 project files, without modifying any project asset — an explicit save point before risky work, on top of the automatic checkpoints every net-changing apply already takes. Restoring one of these checkpoints reproduces the snapshotted state byte for byte.",
      inputSchema: z
        .object({
          paths: z
            .array(projectPathSchema)
            .min(1)
            .max(32)
            .superRefine((paths, context) => {
              const seen = new Set<string>();
              for (const [
                index,
                path,
              ] of paths.entries()) {
                if (seen.has(path)) {
                  context.addIssue({
                    code: "custom",
                    message: `Duplicate path ${path}`,
                    path: [index],
                  });
                }
                seen.add(path);
              }
            }),
          label: z
            .string()
            .max(1_024)
            .optional(),
        })
        .strict(),
      outputSchema: toolOutputSchema(
        z
          .object({
            checkpoints: z
              .array(
                z
                  .object({
                    checkpointId: z
                      .string()
                      .min(1),
                    path: projectPathSchema,
                    revision: revisionSchema,
                    size: z
                      .number()
                      .int()
                      .nonnegative(),
                  })
                  .strict(),
              )
              .min(1)
              .max(32),
            checkpointCount: z
              .number()
              .int()
              .min(1)
              .max(32),
          })
          .strict(),
      ),
      annotations: {
        title: "Create explicit checkpoints",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ paths, label }) =>
      executeTool(async () => {
        const checkpoints =
          await store.createExplicitCheckpoints(
            paths,
            label ?? "explicit checkpoint",
          );
        return {
          checkpoints,
          checkpointCount: checkpoints.length,
        };
      }),
  );

  toolRegistrars["tiled_preview_prepared_checkpoint_discard"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_prepared_checkpoint_discard",
    {
      title:
        "Preview discarding a prepared recovery checkpoint",
      description:
        "Pins one prepared checkpoint manifest and proves that the current target still equals its pre-write state: an existing target must match the exact before revision and size, while a create target must still be missing. It returns a destructive discard proposal without deleting the manifest or changing the project asset. Conflicting, exact-after, ambiguous, committed, unsafe, or unrelated states are rejected.",
      inputSchema: z
        .object({
          checkpointId: z
            .string()
            .regex(CHECKPOINT_ID_PATTERN),
        })
        .strict(),
      outputSchema:
        preparedCheckpointDiscardPreviewToolOutputSchema,
      annotations:
        PREPARED_CHECKPOINT_DISCARD_PREVIEW,
    },
    async ({ checkpointId }) =>
      executeTool(async () =>
        changeSets.put(
          await planPreparedCheckpointDiscard(
            store,
            checkpointId,
          ),
        ),
      ),
  );

  toolRegistrars["tiled_preview_prepared_checkpoint_commit"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_prepared_checkpoint_commit",
    {
      title:
        "Preview committing an ambiguous prepared recovery checkpoint",
      description:
        "For an ambiguous create checkpoint only, pins the full prepared manifest and current target evidence and requires the target to exactly match the after revision. It returns an explicit operator-decision proposal without changing either the manifest or project asset. Applying the proposal commits only the internal audit checkpoint record; because its before state is target absence, it still cannot be restored as deletion. It does not run garbage collection, and there is no generic force flag.",
      inputSchema: z
        .object({
          checkpointId: z
            .string()
            .regex(CHECKPOINT_ID_PATTERN),
        })
        .strict(),
      outputSchema:
        preparedCheckpointCommitPreviewToolOutputSchema,
      annotations:
        PREPARED_CHECKPOINT_COMMIT_PREVIEW,
    },
    async ({ checkpointId }) =>
      executeTool(async () =>
        changeSets.put(
          await planPreparedCheckpointCommit(
            store,
            checkpointId,
          ),
        ),
      ),
  );

  toolRegistrars["tiled_preview_prepared_checkpoint_abandon"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_prepared_checkpoint_abandon",
    {
      title:
        "Preview abandoning an ambiguous prepared recovery checkpoint",
      description:
        "Pins the full manifest, target observation, and one of four machine-classified ambiguous prepared-checkpoint conflicts. It returns an explicit destructive operator-decision proposal without changing the project asset. Applying it permanently deletes only the recovery manifest and then runs fail-closed garbage collection; safe-discard states and machine-reconcilable existing-file exact-after states are rejected. A create exact-after conflict remains eligible because its provenance is ambiguous. There is no generic force flag.",
      inputSchema: z
        .object({
          checkpointId: z
            .string()
            .regex(CHECKPOINT_ID_PATTERN),
        })
        .strict(),
      outputSchema:
        preparedCheckpointAbandonPreviewToolOutputSchema,
      annotations:
        PREPARED_CHECKPOINT_ABANDON_PREVIEW,
    },
    async ({ checkpointId }) =>
      executeTool(async () =>
        changeSets.put(
          await planPreparedCheckpointAbandon(
            store,
            checkpointId,
          ),
        ),
      ),
  );

  toolRegistrars["tiled_preview_checkpoint_prune_batch"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_checkpoint_prune_batch",
    {
      title:
        "Preview pruning recovery checkpoints in a batch",
      description:
        "Pins 1 to 32 explicit committed recovery checkpoint manifests, canonicalizes their UUIDs to lowercase, and orders them by checkpoint ID. The destructive proposal is non-atomic: apply preflights every pin, removes manifests sequentially with per-item directory durability, stops on the first failure, caches any partial result without resume, and runs fail-closed garbage collection once only after all selected manifests are removed. Prepared checkpoints and duplicate normalized IDs are rejected.",
      inputSchema: z
        .object({
          checkpointIds: z
            .array(
              z
                .string()
                .regex(
                  CHECKPOINT_ID_INPUT_PATTERN,
                ),
            )
            .min(
              MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
            )
            .max(
              MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
            ),
        })
        .strict(),
      outputSchema:
        checkpointPruneBatchPreviewToolOutputSchema,
      annotations:
        CHECKPOINT_PRUNE_BATCH_PREVIEW,
    },
    async ({ checkpointIds }) =>
      executeTool(async () =>
        changeSets.put(
          await planCheckpointPruneBatch(
            store,
            checkpointIds,
          ),
        ),
      ),
  );

  toolRegistrars["tiled_preview_checkpoint_restore"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_checkpoint_restore",
    {
      title: "Preview restoring a recovery checkpoint",
      description:
        "Validates one checkpoint and its exact pre-write JSON bytes, pins the current target revision, and returns a destructive restore proposal without writing. When the target file is missing (deleted through tiled_delete_file or externally), expectedRevision must equal the checkpoint's restorable content revision and the approved restore recreates the file with no-replace semantics. Only that document is restored; referenced tilesets, images and other files are not.",
      inputSchema: z
        .object({
          checkpointId: z
            .string()
            .regex(CHECKPOINT_ID_PATTERN),
          expectedRevision: revisionSchema,
        })
        .strict(),
      outputSchema:
        checkpointRestorePreviewToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({ checkpointId, expectedRevision }) =>
      executeTool(async () =>
        changeSets.put(
          await planCheckpointRestore(
            store,
            checkpointId,
            expectedRevision,
          ),
        ),
      ),
  );

  toolRegistrars["tiled_get_map_summary"] = () =>
  register(
    server,
    registeredTools,
    "tiled_get_map_summary",
    {
      title: "Read a Tiled map summary",
      description:
        "Reads dimensions, normalized root render/background/class metadata, revision, layer tree and external tileset identities before editing. Embedded (inline) atlas tilesets are listed separately with their tilesets[] index and GID range; they are pinned by the map revision and stay read-only. Infinite maps are readable too: the summary reports infinite:true, chunked tile-layer content bounds with startX/startY, and a read-only profile marker; isometric maps likewise return a read-only profile (tile data and GIDs are storage-identical to orthogonal), while staggered and hexagonal maps stay rejected. XML maps (.tmx) return a bounded read-only summary through a fail-closed XML subset reader — layer tree with data encodings, external tileset references resolved with per-file existence and revision pins, and an editable:false marker; TMX never reaches any edit planner.",
      inputSchema: z.object({ mapPath: projectPathSchema }).strict(),
      outputSchema: mapSummaryToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ mapPath }) => executeTool(() => maps.getSummary(mapPath)),
  );

  toolRegistrars["tiled_get_tileset"] = () =>
  register(
    server,
    registeredTools,
    "tiled_get_tileset",
    {
      title: "Read referenced tileset details",
      description:
        "Returns a bounded semantic summary of one tileset referenced by a map — an external TSJ selected by tilesetAssetId, or an embedded (inline) atlas tileset selected by its original tilesets[] index via embeddedIndex (exactly one selector is required; embedded content is pinned by the map revision itself). Includes sparse tile metadata with per-tile custom-property values (scalars, enums, object references, and bounded raw nested class/list values; only oversized entries carry an explicit valueOmitted marker), animation, exact collision shape geometry (gid/template objects and oversized paths carry omission markers), and expanded Wang sets (full color projections plus a bounded wangtile sample; wangid slots run clockwise from the top edge). Image-collection tilesets project a collection block instead of atlas geometry, with each returned page tile's image verified and revision-pinned; collection Wang sets, per-tile sub-rectangles, and embedded image-collection tilesets fail closed.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          tilesetAssetId: z
            .string()
            .min(1)
            .max(128)
            .optional(),
          embeddedIndex: z
            .number()
            .int()
            .min(0)
            .max(MAX_TILESET_COUNT - 1)
            .optional(),
          startTileId: z
            .number()
            .int()
            .min(0)
            .max(0x0fffffff)
            .default(0),
          limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_TILESET_METADATA_LIMIT)
            .default(DEFAULT_TILESET_METADATA_LIMIT),
        })
        .strict(),
      outputSchema:
        tilesetDetailToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({
      mapPath,
      tilesetAssetId,
      embeddedIndex,
      startTileId,
      limit,
    }) =>
      executeTool(() =>
        maps.getTileset({
          mapPath,
          ...(tilesetAssetId === undefined
            ? {}
            : { tilesetAssetId }),
          ...(embeddedIndex === undefined
            ? {}
            : { embeddedIndex }),
          startTileId,
          limit,
        }),
      ),
  );

  toolRegistrars["tiled_find_tiles"] = () =>
  register(
    server,
    registeredTools,
    "tiled_find_tiles",
    {
      title: "Find tiles by explicit semantics",
      description:
        "Searches one referenced external TSJ (atlas or image-collection) for exact tile classes or explicitly serialized scalar properties and returns bounded TileRefs ordered by local ID.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          tilesetAssetId: z.string().min(1).max(128),
          query: tileFindQuerySchema,
          startTileId: z
            .number()
            .int()
            .min(0)
            .max(0x0fffffff)
            .default(0),
          limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_TILE_FIND_LIMIT)
            .default(DEFAULT_TILE_FIND_LIMIT),
          expectedMapRevision: revisionSchema.optional(),
          expectedTilesetRevision: revisionSchema.optional(),
        })
        .strict(),
      outputSchema: tileFindToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({
      mapPath,
      tilesetAssetId,
      query,
      startTileId,
      limit,
      expectedMapRevision,
      expectedTilesetRevision,
    }) =>
      executeTool(() =>
        maps.findTiles({
          mapPath,
          tilesetAssetId,
          query,
          startTileId,
          limit,
          ...(expectedMapRevision === undefined
            ? {}
            : { expectedMapRevision }),
          ...(expectedTilesetRevision === undefined
            ? {}
            : { expectedTilesetRevision }),
        }),
      ),
  );

  toolRegistrars["tiled_get_region"] = () =>
  register(
    server,
    registeredTools,
    "tiled_get_region",
    {
      title: "Read a tile region",
      description:
        "Returns a bounded rectangular tile region using tileset asset IDs and local tile IDs. Cells referencing an embedded (inline) tileset return a read-only {kind:\"embedded\", sourceIndex} reference instead of an asset ID. On infinite maps the rectangle uses absolute tile coordinates (negatives allowed) and cells outside every chunk are empty. XML maps (.tmx) return raw encoded GIDs (flip bits included) plus the map's tileset ranges so callers attribute cells by firstgid themselves; finite csv and base64 layers only — plain tile elements and chunks fail closed.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          layerId: z.number().int(),
          x: z.number().int(),
          y: z.number().int(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .strict(),
      outputSchema: regionToolOutputSchema,
      annotations: READ_ONLY,
    },
    async (input) => executeTool(() => maps.getRegion(input)),
  );

  toolRegistrars["tiled_render_tileset_sheet"] = () =>
  register(
    server,
    registeredTools,
    "tiled_render_tileset_sheet",
    {
      title: "Render a labeled tileset sheet",
      description:
        "Renders one bounded page of a referenced tileset (atlas or image-collection), with every tile labeled by its local ID. Collection pages walk sparse local ids ascending, read each tile's own verified, revision-pinned image, and are limited to 64 tiles per page.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          tilesetAssetId: z.string().min(1).max(128),
          page: z
            .number()
            .int()
            .min(0)
            .default(0)
            .describe("Zero-based tileset sheet page index"),
          pageSize: z
            .number()
            .int()
            .min(1)
            .max(MAX_TILESET_SHEET_PAGE_SIZE)
            .default(DEFAULT_TILESET_SHEET_PAGE_SIZE),
          columns: z
            .number()
            .int()
            .min(1)
            .max(MAX_TILESET_SHEET_COLUMNS)
            .describe("Maximum number of tile columns on a sheet page")
            .optional(),
          scale: z
            .number()
            .int()
            .min(1)
            .max(MAX_TILESET_SHEET_SCALE)
            .default(DEFAULT_TILESET_SHEET_SCALE),
        })
        .strict(),
      outputSchema:
        tilesetSheetToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ mapPath, tilesetAssetId, page, pageSize, columns, scale }) =>
      renderMutex.runExclusive("sharp-render", async () => {
        try {
          const rendered = await maps.renderTilesetSheet({
            mapPath,
            tilesetAssetId,
            page,
            pageSize,
            scale,
            ...(columns === undefined ? {} : { columns }),
          });
          return imageToolResult(rendered.result, rendered.png);
        } catch (error) {
          return toolError(error);
        }
      }),
  );

  toolRegistrars["tiled_render_tiles"] = () =>
  register(
    server,
    registeredTools,
    "tiled_render_tiles",
    {
      title: "Render selected tiles",
      description:
        "Renders an explicit bounded, input-ordered selection of local tile IDs from one referenced external tileset (atlas or image-collection). Every selected tile is labeled with its local ID; the selection is never sorted, reduced or paginated. Collection selections read each tile's own image verified and revision-pinned; missing sparse ids fail closed.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          tilesetAssetId: z.string().min(1).max(128),
          localIds: z
            .array(
              z
                .number()
                .int()
                .min(0)
                .max(0x0fffffff),
            )
            .min(1)
            .max(MAX_TILE_RENDER_LOCAL_IDS)
            .meta({ uniqueItems: true })
            .superRefine((localIds, context) => {
              const seen = new Set<number>();
              for (const [
                index,
                localId,
              ] of localIds.entries()) {
                if (seen.has(localId)) {
                  context.addIssue({
                    code: "custom",
                    message: `Duplicate local tile ID ${localId}`,
                    path: [index],
                  });
                }
                seen.add(localId);
              }
            }),
          columns: z
            .number()
            .int()
            .min(1)
            .max(MAX_TILE_RENDER_COLUMNS)
            .describe(
              `Maximum tile columns per row; defaults to ${DEFAULT_TILE_RENDER_COLUMNS} when omitted`,
            )
            .optional(),
          scale: z
            .number()
            .int()
            .min(1)
            .max(MAX_TILE_RENDER_SCALE)
            .default(DEFAULT_TILE_RENDER_SCALE),
          expectedMapRevision:
            revisionSchema.optional(),
          expectedTilesetRevision:
            revisionSchema.optional(),
        })
        .strict(),
      outputSchema: tileRenderToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({
      mapPath,
      tilesetAssetId,
      localIds,
      columns,
      scale,
      expectedMapRevision,
      expectedTilesetRevision,
    }) =>
      renderMutex.runExclusive(
        "sharp-render",
        async () => {
          try {
            const rendered = await maps.renderTiles({
              mapPath,
              tilesetAssetId,
              localIds,
              scale,
              ...(columns === undefined
                ? {}
                : { columns }),
              ...(expectedMapRevision === undefined
                ? {}
                : { expectedMapRevision }),
              ...(expectedTilesetRevision === undefined
                ? {}
                : { expectedTilesetRevision }),
            });
            return imageToolResult(
              rendered.result,
              rendered.png,
            );
          } catch (error) {
            return toolError(error);
          }
        },
      ),
  );

  toolRegistrars["tiled_render_preview"] = () =>
  register(
    server,
    registeredTools,
    "tiled_render_preview",
    {
      title: "Render a native tile-layer map preview",
      description:
        "Renders a bounded orthogonal TMJ region without invoking TmxRasterizer; infinite chunked maps require an explicit absolute-coordinate region (negatives allowed, cells outside chunks are empty). The native v1 profile supports static external and embedded (inline) atlas tile layers — embedded images resolve relative to the map file and their source entry carries {embedded: {sourceIndex}} pinned by the map revision; tile objects backed by embedded tilesets fail closed — plus fixed-style absolute tile-rectangle highlights and explicit basic-object geometry debugging. The v2 object debug profile supports rectangles, points, ellipses, Tiled 1.12 capsules, polygons, polylines, and text boxes; it ignores object and layer visibility/opacity and does not render text glyphs. Every highlight must intersect the effective tileRegion; partial overlap is clipped and reported.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          region: z
            .object({
              x: z
                .number()
                .int()
                .min(-1_000_000_000)
                .max(1_000_000_000),
              y: z
                .number()
                .int()
                .min(-1_000_000_000)
                .max(1_000_000_000),
              width: z.number().int().positive(),
              height: z.number().int().positive(),
            })
            .strict()
            .optional(),
          layerIds: z
            .array(positiveIdSchema)
            .min(1)
            .max(MAX_PREVIEW_LAYERS)
            .superRefine((layerIds, context) => {
              const seen = new Set<number>();
              for (const [index, layerId] of layerIds.entries()) {
                if (seen.has(layerId)) {
                  context.addIssue({
                    code: "custom",
                    message: `Duplicate layer id ${layerId}`,
                    path: [index],
                  });
                }
                seen.add(layerId);
              }
            })
            .optional(),
          scale: z
            .number()
            .int()
            .min(1)
            .max(MAX_NATIVE_PREVIEW_SCALE)
            .default(DEFAULT_NATIVE_PREVIEW_SCALE),
          overlays: z
            .object({
              grid: z.boolean().optional(),
              coordinates: z.boolean().optional(),
              highlights: z
                .array(
                  nativePreviewHighlightRectInputSchema,
                )
                .min(1)
                .max(
                  MAX_NATIVE_PREVIEW_HIGHLIGHTS,
                )
                .optional(),
              objectIds:
                nativePreviewObjectIdsInputSchema.optional(),
              tileObjectCollision: z
                .boolean()
                .optional(),
            })
            .strict()
            .superRefine((value, context) => {
              if (
                value.tileObjectCollision === true &&
                value.objectIds === undefined
              ) {
                context.addIssue({
                  code: "custom",
                  message:
                    "overlays.tileObjectCollision requires overlays.objectIds",
                  path: ["tileObjectCollision"],
                });
              }
            })
            .optional(),
        })
        .strict(),
      outputSchema:
        renderPreviewToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ mapPath, region, layerIds, scale, overlays }) =>
      renderMutex.runExclusive("sharp-render", async () => {
        try {
          // Dispatch on the map's own orientation rather than making the
          // caller pick a projection-specific tool. The probe read and the
          // renderer's read are separate, but each renderer re-asserts the
          // orientation it requires, so a map that changes projection between
          // the two fails closed instead of rendering through the wrong
          // placement math.
          const { orientation } =
            await maps.getSummary(mapPath);
          if (orientation !== "orthogonal") {
            if (overlays !== undefined) {
              throw new TiledMcpError(
                "INVALID_ARGUMENT",
                `overlays are implemented for orthogonal maps only; ${mapPath} is ${orientation}.`,
              );
            }
            if (region === undefined) {
              throw new TiledMcpError(
                "INVALID_ARGUMENT",
                `region is required for ${orientation} maps; only orthogonal rendering may default it.`,
              );
            }
            const projected =
              orientation === "isometric"
                ? await maps.renderIsometric({
                    mapPath,
                    region,
                    layerIds,
                    scale,
                  })
                : await maps.renderHexagonal({
                    mapPath,
                    region,
                    layerIds,
                    scale,
                  });
            return imageToolResult(
              projected.result,
              projected.png,
            );
          }
          const normalizedOverlays =
            overlays === undefined
              ? undefined
              : {
                  ...(overlays.grid === undefined
                    ? {}
                    : { grid: overlays.grid }),
                  ...(overlays.coordinates === undefined
                    ? {}
                    : { coordinates: overlays.coordinates }),
                  ...(overlays.highlights === undefined
                    ? {}
                    : { highlights: overlays.highlights }),
                  ...(overlays.objectIds === undefined
                    ? {}
                    : { objectIds: overlays.objectIds }),
                  ...(overlays.tileObjectCollision ===
                  undefined
                    ? {}
                    : {
                        tileObjectCollision:
                          overlays.tileObjectCollision,
                      }),
                };
          const rendered = await maps.renderPreview({
            mapPath,
            scale,
            ...(region === undefined ? {} : { region }),
            ...(layerIds === undefined ? {} : { layerIds }),
            ...(normalizedOverlays === undefined
              ? {}
              : { overlays: normalizedOverlays }),
          });
          return imageToolResult(rendered.result, rendered.png);
        } catch (error) {
          return toolError(error);
        }
      }),
  );

  toolRegistrars["tiled_render_diff"] = () =>
  register(
    server,
    registeredTools,
    "tiled_render_diff",
    {
      title: "Render a visual map diff",
      description:
        "Renders the same bounded region of two maps through the native preview and compares them pixel by pixel: differing pixels paint solid red over a faded copy of the first render, matching pixels keep the first render at reduced opacity, and differences also aggregate to tile-cell granularity (bounded sample). Both renders must agree on pixel size; layer selections may differ per side, so the same map can be diffed against itself with different layers visible. Read-only.",
      inputSchema: z
        .object({
          mapPathA: projectPathSchema,
          mapPathB: projectPathSchema,
          region: z
            .object({
              x: z.number().int(),
              y: z.number().int(),
              width: z
                .number()
                .int()
                .positive(),
              height: z
                .number()
                .int()
                .positive(),
            })
            .strict(),
          layerIdsA: z
            .array(
              z.number().int().positive(),
            )
            .min(1)
            .max(1_000)
            .optional(),
          layerIdsB: z
            .array(
              z.number().int().positive(),
            )
            .min(1)
            .max(1_000)
            .optional(),
          scale: z
            .number()
            .int()
            .min(1)
            .max(MAX_NATIVE_PREVIEW_SCALE)
            .optional(),
        })
        .strict(),
      outputSchema: renderDiffToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({
      mapPathA,
      mapPathB,
      region,
      layerIdsA,
      layerIdsB,
      scale,
    }) =>
      executeTool(async () => {
        const rendered = await maps.renderDiff({
          mapPathA,
          mapPathB,
          region,
          layerIdsA,
          layerIdsB,
          scale,
        });
        return imageToolResult(
          rendered.result,
          rendered.png,
        );
      }),
  );

  toolRegistrars["tiled_list_objects"] = () =>
  register(
    server,
    registeredTools,
    "tiled_list_objects",
    {
      title: "List map objects",
      description:
        "Returns a bounded list of objects from all object layers or one selected object layer.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          layerId: positiveIdSchema.optional(),
          limit: z.number().int().min(1).max(10_000).default(1_000),
        })
        .strict(),
      outputSchema: objectListToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ mapPath, layerId, limit }) =>
      executeTool(() =>
        maps.listObjects({
          mapPath,
          limit,
          ...(layerId === undefined ? {} : { layerId }),
        }),
      ),
  );

  toolRegistrars["tiled_get_object"] = () =>
  register(
    server,
    registeredTools,
    "tiled_get_object",
    {
      title: "Get map object",
      description:
        "Returns one supported object with complete shape-specific geometry, effective text styling, and its custom properties in document order: scalar, enum, and object-reference values verbatim, nested class and list values as bounded raw JSON (class member types live in the project's class definitions, not in the TMJ), and only oversized entries carry an explicit valueOmitted marker. A JSON (.tj) template instance expands with Tiled 1.12.2 syncWithTemplate merge rules and reports its revision-pinned template source; tile templates, XML templates, and template property merging fail closed.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          objectId: positiveIdSchema,
        })
        .strict(),
      outputSchema: objectDetailsToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ mapPath, objectId }) =>
      executeTool(() =>
        maps.getObject({
          mapPath,
          objectId,
        }),
      ),
  );

  toolRegistrars["tiled_validate"] = () =>
  register(
    server,
    registeredTools,
    "tiled_validate",
    {
      title: "Validate a Tiled map",
      description:
        "Performs structural and MVP-profile validation without modifying the map, tilesets, or images.",
      inputSchema: z.object({ mapPath: projectPathSchema }).strict(),
      outputSchema:
        validationToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ mapPath }) => executeTool(() => maps.validate(mapPath)),
  );

  toolRegistrars["tiled_analyze_usage"] = () =>
  register(
    server,
    registeredTools,
    "tiled_analyze_usage",
    {
      title: "Analyze tile usage",
      description:
        "Returns bounded whole-map tile frequency, layer density, transform, used-tileset, and unused-local-ID summaries. Hidden layers and tile objects are included.",
      inputSchema: usageAnalysisInputSchema,
      outputSchema:
        usageAnalysisToolOutputSchema,
      annotations: READ_ONLY,
    },
    async (input) =>
      executeTool(() =>
        maps.analyzeUsage(input as AnalyzeUsageInput),
      ),
  );

  toolRegistrars["tiled_check_connectivity"] = () =>
  register(
    server,
    registeredTools,
    "tiled_check_connectivity",
    {
      title: "Check tile layer connectivity",
      description:
        "Bounded four-way connectivity analysis over one finite tile layer with explicit passability: either empty cells walk (mode empty-cells) or a listed tile set walks (mode listed-tiles, with includeEmpty opting empty cells in); flip bits never affect matching. Returns passable/blocked counts, connected components ranked by size with one representative cell each, and — when from/to are both given — whether they share a component. Read-only; endpoints on blocked cells fail closed.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          layerId: z.number().int().positive(),
          passable: z.discriminatedUnion(
            "mode",
            [
              z
                .object({
                  mode: z.literal(
                    "empty-cells",
                  ),
                })
                .strict(),
              z
                .object({
                  mode: z.literal(
                    "listed-tiles",
                  ),
                  tiles: z
                    .array(tileRefSchema)
                    .min(1)
                    .max(64),
                  includeEmpty: z
                    .boolean()
                    .optional(),
                })
                .strict(),
            ],
          ),
          from: z
            .object({
              x: z.number().int().min(0),
              y: z.number().int().min(0),
            })
            .strict()
            .optional(),
          to: z
            .object({
              x: z.number().int().min(0),
              y: z.number().int().min(0),
            })
            .strict()
            .optional(),
        })
        .strict(),
      outputSchema: connectivityToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({
      mapPath,
      layerId,
      passable,
      from,
      to,
    }) =>
      executeTool(() =>
        maps.checkConnectivity({
          mapPath,
          layerId,
          passable: passable as
            | { mode: "empty-cells" }
            | {
                mode: "listed-tiles";
                tiles: TileRef[];
                includeEmpty?: boolean;
              },
          from,
          to,
        }),
      ),
  );

  toolRegistrars["tiled_convert_coordinates"] = () =>
  register(
    server,
    registeredTools,
    "tiled_convert_coordinates",
    {
      title: "Convert between tile, screen and pixel coordinates",
      description:
        "Read-only batch of the official Tiled 1.12.2 renderer transforms between the three coordinate spaces (tile, screen, pixel) for orthogonal, isometric, staggered and hexagonal maps. Use this instead of deriving placement by hand: the spaces coincide only for orthogonal maps, isometric pixel coordinates are expressed in tile-height units on both axes, and the isometric screen origin is offset by the map height. Each conversion reports the raw transform output plus, when converting into tile space, the whole cell that contains it. The result also declares whether tile space is discrete (hexagonal and staggered snap to the nearest of four hexagon centres, so there is no sub-cell remainder) or continuous, and whether pixel space differs from screen space. Reads only the map header, so it still answers when tilesets are missing or broken.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          conversions: z
            .array(
              z
                .object({
                  from: coordinateSpaceSchema,
                  to: coordinateSpaceSchema,
                  x: coordinateOrdinateSchema,
                  y: coordinateOrdinateSchema,
                })
                .strict(),
            )
            .min(1)
            .max(MAX_COORDINATE_CONVERSIONS),
        })
        .strict(),
      outputSchema: coordinateToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ mapPath, conversions }) =>
      executeTool(() =>
        maps.convertCoordinates({
          mapPath,
          conversions: conversions.map(
            (conversion) => ({
              from: conversion.from,
              to: conversion.to,
              point: {
                x: conversion.x,
                y: conversion.y,
              },
            }),
          ),
        }),
      ),
  );

  toolRegistrars["tiled_create_map"] = () =>
  register(
    server,
    registeredTools,
    "tiled_create_map",
    {
      title: "Create a finite orthogonal TMJ map",
      description:
        "Directly creates a new empty TMJ as the sole additive no-preview mutation exception. The caller must confirm the target path; parent directories must exist, and any existing destination—including identical bytes—is never overwritten or treated as success.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          width: z
            .number()
            .int()
            .positive()
            .max(MAX_CREATE_MAP_DIMENSION),
          height: z
            .number()
            .int()
            .positive()
            .max(MAX_CREATE_MAP_DIMENSION),
          tileWidth: z
            .number()
            .int()
            .positive()
            .max(MAX_CREATE_MAP_TILE_EDGE),
          tileHeight: z
            .number()
            .int()
            .positive()
            .max(MAX_CREATE_MAP_TILE_EDGE),
          backgroundColor: z
            .string()
            .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u)
            .optional(),
        })
        .strict(),
      outputSchema: toolOutputSchema(
        commitResultOutputSchema,
      ),
      annotations: {
        title: "Create a local TMJ map",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ mapPath, width, height, tileWidth, tileHeight, backgroundColor }) =>
      executeTool(() =>
        maps.createMap({
          mapPath,
          width,
          height,
          tileWidth,
          tileHeight,
          ...(backgroundColor === undefined ? {} : { backgroundColor }),
        }),
      ),
  );

  toolRegistrars["tiled_create_tileset"] = () =>
  register(
    server,
    registeredTools,
    "tiled_create_tileset",
    {
      title: "Preview creating an external TSJ tileset",
      description:
        "Plans one new external atlas TSJ from an existing project image, computing columns and tilecount with the Tiled 1.12.2 margin/spacing grid formula, and returns an expiring change set without modifying project assets. The approved expectedRevision is the SHA-256 of the exact prospective TSJ bytes; apply refuses to overwrite any existing destination. tiled_create_map remains the sole direct creation exception.",
      inputSchema: z
        .object({
          tilesetPath: projectPathSchema,
          imagePath: projectPathSchema,
          tileWidth: z
            .number()
            .int()
            .positive()
            .max(MAX_CREATE_TILESET_TILE_EDGE),
          tileHeight: z
            .number()
            .int()
            .positive()
            .max(MAX_CREATE_TILESET_TILE_EDGE),
          margin: z
            .number()
            .int()
            .min(0)
            .max(MAX_CREATE_TILESET_MARGIN)
            .optional(),
          spacing: z
            .number()
            .int()
            .min(0)
            .max(MAX_CREATE_TILESET_SPACING)
            .optional(),
          name: z
            .string()
            .min(1)
            .max(
              MAX_CREATE_TILESET_NAME_CODE_POINTS *
                2,
            )
            .optional(),
          className: z
            .string()
            .min(1)
            .max(
              MAX_CREATE_TILESET_NAME_CODE_POINTS *
                2,
            )
            .optional(),
        })
        .strict(),
      outputSchema:
        createTilesetPreviewToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async (input) =>
      executeTool(async () => {
        const plan =
          await maps.planCreateTileset({
            tilesetPath: input.tilesetPath,
            imagePath: input.imagePath,
            tileWidth: input.tileWidth,
            tileHeight: input.tileHeight,
            ...(input.margin === undefined
              ? {}
              : { margin: input.margin }),
            ...(input.spacing === undefined
              ? {}
              : { spacing: input.spacing }),
            ...(input.name === undefined
              ? {}
              : { name: input.name }),
            ...(input.className === undefined
              ? {}
              : { className: input.className }),
          });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_delete_file"] = () =>
  register(
    server,
    registeredTools,
    "tiled_delete_file",
    {
      title: "Preview deleting a project document",
      description:
        "Plans the permanent deletion of one project-local TMJ map or TSJ tileset. The bounded fail-closed reference scan (TMJ maps, JSON worlds, JSON templates, plus TMX maps and XML templates through the bounded fail-closed XML reader; pattern-based worlds still reject the scan) must prove the target unreferenced, and it re-runs on apply. Apply commits a checkpoint of the exact current bytes before unlinking, so restoring that checkpoint recreates the file; the tool itself modifies nothing.",
      inputSchema: z
        .object({
          path: projectPathSchema,
        })
        .strict(),
      outputSchema:
        deleteFilePreviewToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({ path }) =>
      executeTool(async () => {
        const plan = await maps.planDeleteFile({
          path,
        });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_add_tileset_to_map"] = () =>
  register(
    server,
    registeredTools,
    "tiled_add_tileset_to_map",
    {
      title: "Preview adding a tileset to a map",
      description:
        "Validates one project-local external atlas TSJ, assigns its GID range after all current ranges, and returns an expiring map change set without modifying project assets. With createChangeSetId, a pending tileset-create change set's replayed prospective content stands in for a TSJ that does not exist yet; the attachment pins that prospective revision, so it applies after the create commits or atomically with it in one transaction.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          tilesetPath: projectPathSchema,
          expectedMapRevision: revisionSchema,
          expectedDependencyRevisions: dependencyRevisionsSchema,
          expectedTilesetRevision: revisionSchema.optional(),
          createChangeSetId: z
            .string()
            .regex(/^changeset:[0-9a-f]{64}$/u)
            .optional(),
        })
        .strict(),
      outputSchema:
        addTilesetPreviewToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      mapPath,
      tilesetPath,
      expectedMapRevision,
      expectedDependencyRevisions,
      expectedTilesetRevision,
      createChangeSetId,
    }) =>
      executeTool(async () => {
        const plan = await maps.planAddTilesetToMap({
          mapPath,
          tilesetPath,
          expectedMapRevision,
          expectedDependencyRevisions,
          ...(expectedTilesetRevision === undefined
            ? {}
            : { expectedTilesetRevision }),
          ...(createChangeSetId === undefined
            ? {}
            : {
                createPlan:
                  changeSets.getTilesetCreatePlan(
                    createChangeSetId,
                  ),
              }),
        });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_preview_merge_map"] = () =>
    register(
      server,
      registeredTools,
      "tiled_preview_merge_map",
      {
        title: "Preview merging another map in",
        description:
          "Stamps the tile layers of another project-local map into this one at an optional tile offset, matching layers by name, and returns an expiring map change set without modifying either map. GIDs are translated, not copied: each source cell is decoded against the source map's own firstgid table and re-expressed against this map's binding for the same tileset file, so two maps that order their tilesets differently still merge correctly. Empty source cells are skipped, so the destination shows through wherever the source has nothing. Fails closed when the two grids differ in orientation or tile size, when the source uses a tileset this map does not already reference (attach it with tiled_add_tileset_to_map first), when a source tile layer has no same-named tile layer here (create it with tiled_create_layer first), or when the source is infinite.",
        inputSchema: z
          .object({
            mapPath: projectPathSchema,
            sourceMapPath: projectPathSchema,
            expectedMapRevision: revisionSchema,
            expectedDependencyRevisions:
              dependencyRevisionsSchema,
            expectedSourceMapRevision:
              revisionSchema.optional(),
            offsetX: z
              .number()
              .int()
              .min(-MAX_MERGE_OFFSET)
              .max(MAX_MERGE_OFFSET)
              .optional(),
            offsetY: z
              .number()
              .int()
              .min(-MAX_MERGE_OFFSET)
              .max(MAX_MERGE_OFFSET)
              .optional(),
          })
          .strict(),
        outputSchema: previewEditsToolOutputSchema,
        annotations: PREVIEW_ONLY,
      },
      async ({
        mapPath,
        sourceMapPath,
        expectedMapRevision,
        expectedDependencyRevisions,
        expectedSourceMapRevision,
        offsetX,
        offsetY,
      }) =>
        executeTool(async () => {
          const plan = await maps.planMergeMap({
            mapPath,
            sourceMapPath,
            expectedMapRevision,
            expectedDependencyRevisions,
            ...(expectedSourceMapRevision ===
            undefined
              ? {}
              : { expectedSourceMapRevision }),
            ...(offsetX === undefined
              ? {}
              : { offsetX }),
            ...(offsetY === undefined
              ? {}
              : { offsetY }),
          });
          return changeSets.put(plan);
        }),
    );

  toolRegistrars["tiled_replace_tileset_in_map"] =
    () =>
      register(
        server,
        registeredTools,
        "tiled_replace_tileset_in_map",
        {
          title:
            "Preview repointing a tileset reference",
          description:
            "Repoints one currently bound external tileset at a different project-local atlas TSJ, keeping its firstgid, and returns an expiring map change set without modifying project assets. Use this to change the art a finished map is drawn with: every GID keeps its value and its slot, so no cell is rewritten and each one now shows the tile at the same local id in the replacement. Removing and re-adding cannot do this — removal refuses any tileset a cell still references. Fails closed when a local id still in use does not exist in the replacement, and when the replacement's GID span would overlap the tileset bound after it; a smaller replacement is allowed only while nothing refers to the tiles it drops. The two tilesets are not compared for visual similarity, so a replacement laid out differently silently remaps every cell — read both before approving.",
          inputSchema: z
            .object({
              mapPath: projectPathSchema,
              tilesetAssetId: z
                .string()
                .regex(/^asset_[0-9a-f]{24}$/u),
              tilesetPath: projectPathSchema,
              expectedMapRevision: revisionSchema,
              expectedDependencyRevisions:
                dependencyRevisionsSchema,
              expectedTilesetRevision:
                revisionSchema.optional(),
            })
            .strict(),
          outputSchema:
            replaceTilesetPreviewToolOutputSchema,
          annotations: PREVIEW_ONLY,
        },
        async ({
          mapPath,
          tilesetAssetId,
          tilesetPath,
          expectedMapRevision,
          expectedDependencyRevisions,
          expectedTilesetRevision,
        }) =>
          executeTool(async () => {
            const plan =
              await maps.planReplaceTilesetInMap({
                mapPath,
                tilesetAssetId,
                tilesetPath,
                expectedMapRevision,
                expectedDependencyRevisions,
                ...(expectedTilesetRevision ===
                undefined
                  ? {}
                  : { expectedTilesetRevision }),
              });
            return changeSets.put(plan);
          }),
      );

  toolRegistrars["tiled_update_tile"] = () =>
  register(
    server,
    registeredTools,
    "tiled_update_tile",
    {
      title: "Preview per-tile metadata updates",
      description:
        "Validates bounded probability, class, animation, scalar custom-property, and collision-shape updates for tiles of one currently referenced external TSJ (atlas or image-collection), then returns an expiring tileset change set without modifying project assets. Collision replaces the whole objectgroup objects array with basic shapes (null removes it); tile geometry, atlas images, and referencing maps are never touched. Image-collection tilesets additionally accept structural updates, each exclusive to its change set: createCollectionTile adds a new sparse tile entry from a verified project image (the planner reads the image and pins its actual pixel size; tilecount and the maximum tile size follow), and removeCollectionTile (destructive) deletes an existing entry after proving the current map holds no reference to it and no other project asset references the tileset — a shrinking GID span must not strand references. Removing the last entry fails closed. An embedded (inline) map tileset is addressed by its original tilesets[] index via embeddedIndex instead (exactly one selector; expectedTilesetRevision must then be omitted — the map revision is the only pin) and returns an embeddedTilesetEdit change set that patches the map itself; structural collection updates are impossible there because embedded tilesets are atlas-only.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          tilesetAssetId: z
            .string()
            .regex(/^asset_[0-9a-f]{24}$/u)
            .optional(),
          embeddedIndex: z
            .number()
            .int()
            .min(0)
            .max(MAX_TILESET_COUNT - 1)
            .optional(),
          expectedMapRevision: revisionSchema,
          expectedTilesetRevision:
            revisionSchema.optional(),
          updates: z
            .array(tileMetadataUpdateSchema)
            .min(1)
            .max(MAX_TILE_UPDATES_PER_CHANGE_SET)
            .superRefine((updates, context) => {
              const seen = new Set<number>();
              for (const [
                index,
                update,
              ] of updates.entries()) {
                if (seen.has(update.tileId)) {
                  context.addIssue({
                    code: "custom",
                    message: `updates[${index}] repeats tile ID ${update.tileId}`,
                    path: [index, "tileId"],
                  });
                }
                seen.add(update.tileId);
              }
            }),
        })
        .strict(),
      outputSchema:
        updateTilePreviewToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      mapPath,
      tilesetAssetId,
      embeddedIndex,
      expectedMapRevision,
      expectedTilesetRevision,
      updates,
    }) =>
      executeTool(async () => {
        if (
          (tilesetAssetId === undefined) ===
          (embeddedIndex === undefined)
        ) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            "Provide exactly one of tilesetAssetId or embeddedIndex.",
          );
        }
        if (embeddedIndex !== undefined) {
          if (
            expectedTilesetRevision !== undefined
          ) {
            throw new TiledMcpError(
              "INVALID_ARGUMENT",
              "Embedded tilesets have no independent revision; omit expectedTilesetRevision and pin expectedMapRevision only.",
            );
          }
          const plan =
            await maps.planEmbeddedTileUpdate({
              mapPath,
              embeddedIndex,
              expectedMapRevision,
              updates,
            });
          return changeSets.put(plan);
        }
        if (expectedTilesetRevision === undefined) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            "expectedTilesetRevision is required when addressing an external tileset.",
          );
        }
        const plan = await maps.planUpdateTile({
          mapPath,
          tilesetAssetId: tilesetAssetId as string,
          expectedMapRevision,
          expectedTilesetRevision,
          updates,
        });
        return changeSets.put(plan);
      }),
  );

  const wangColorInputSchema = z
    .object({
      name: z
        .string()
        .min(1)
        .max(MAX_WANG_NAME_CODE_POINTS * 2),
      color: z
        .string()
        .regex(/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu),
      probability: z
        .number()
        .finite()
        .min(0)
        .optional(),
      imageTileId: z
        .number()
        .int()
        .min(-1)
        .max(0x0fffffff)
        .optional(),
    })
    .strict();

  toolRegistrars["tiled_update_wangsets"] = () =>
  register(
    server,
    registeredTools,
    "tiled_update_wangsets",
    {
      title: "Preview Wang terrain edits",
      description:
        "Validates sequential Wang edits on one currently referenced external atlas TSJ — addWangSet appends a new set (name, corner/edge/mixed type, optional colors up to Tiled's 254-color limit), addWangColor appends one 1-based color to an existing set, and setWangTiles applies Tiled setWangId semantics per assignment (an all-zero 8-slot wangId removes the tile's entry, an identical one is a no-op, anything else upserts; slots run clockwise from the top edge and reference 1-based color indexes valid at that point in the sequence). The touched wangtiles member is rewritten in Tiled's canonical ascending-tileId save order. Returns an expiring wangEdit change set without modifying project assets; image-collection tilesets and pre-1.5 edgecolors/cornercolors sets fail closed.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          tilesetAssetId: z
            .string()
            .min(1)
            .max(128),
          expectedMapRevision: revisionSchema,
          expectedTilesetRevision: revisionSchema,
          operations: z
            .array(
              z.discriminatedUnion("type", [
                z
                  .object({
                    type: z.literal("addWangSet"),
                    name: z
                      .string()
                      .min(1)
                      .max(
                        MAX_WANG_NAME_CODE_POINTS *
                          2,
                      ),
                    wangSetType: z.enum([
                      "corner",
                      "edge",
                      "mixed",
                    ]),
                    className: z
                      .string()
                      .min(1)
                      .max(
                        MAX_WANG_NAME_CODE_POINTS *
                          2,
                      )
                      .optional(),
                    imageTileId: z
                      .number()
                      .int()
                      .min(-1)
                      .max(0x0fffffff)
                      .optional(),
                    colors: z
                      .array(wangColorInputSchema)
                      .max(254)
                      .optional(),
                  })
                  .strict(),
                z
                  .object({
                    type: z.literal(
                      "addWangColor",
                    ),
                    wangSetIndex: z
                      .number()
                      .int()
                      .min(0)
                      .max(
                        MAX_WANG_SETS_PER_TILESET -
                          1,
                      ),
                    color: wangColorInputSchema,
                  })
                  .strict(),
                z
                  .object({
                    type: z.literal(
                      "setWangTiles",
                    ),
                    wangSetIndex: z
                      .number()
                      .int()
                      .min(0)
                      .max(
                        MAX_WANG_SETS_PER_TILESET -
                          1,
                      ),
                    assignments: z
                      .array(
                        z
                          .object({
                            tileId: z
                              .number()
                              .int()
                              .min(0)
                              .max(0x0fffffff),
                            wangId: z
                              .array(
                                z
                                  .number()
                                  .int()
                                  .min(0)
                                  .max(254),
                              )
                              .length(8),
                          })
                          .strict(),
                      )
                      .min(1)
                      .max(
                        MAX_WANG_ASSIGNMENTS_PER_OPERATION,
                      ),
                  })
                  .strict(),
              ]),
            )
            .min(1)
            .max(MAX_WANG_EDIT_OPERATIONS),
        })
        .strict(),
      outputSchema:
        wangEditPreviewToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      mapPath,
      tilesetAssetId,
      expectedMapRevision,
      expectedTilesetRevision,
      operations,
    }) =>
      executeTool(async () => {
        const plan = await maps.planWangsetEdits({
          mapPath,
          tilesetAssetId,
          expectedMapRevision,
          expectedTilesetRevision,
          operations,
        });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_update_tileset"] = () =>
  register(
    server,
    registeredTools,
    "tiled_update_tileset",
    {
      title: "Preview tileset-level property updates",
      description:
        "Validates tileset-level members of one currently referenced external TSJ — name, class, tileOffset, objectAlignment, tileRenderSize, fillMode, transformations, grid, scalar custom properties, and atlas (re-cutting the tile grid over the same image) — then returns an expiring tilesetPropertyEdit change set without modifying project assets. atlas takes tileWidth/tileHeight plus optional margin/spacing and recomputes columns and tilecount with Tiled's own formula from the image read at plan time, never from the declared imagewidth. Because tilecount sets the GID span every referencing map decodes against, a cut that changes it is refused unless the pinned map still resolves under the new count and no other project asset references the tileset; a cut that leaves the count alone is unrestricted. Every member except name and properties accepts null, which removes it and so restores Tiled's own default rather than writing that default explicitly. Geometry is deliberately not editable here: tilewidth, tileheight, spacing, margin, columns, tilecount and image all re-slice the atlas or move the GID span, which would silently invalidate referencing maps. Tiles, wangsets and referencing maps are never touched. A patch that matches the tileset's current values fails closed instead of returning an empty change set.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          tilesetAssetId: z
            .string()
            .regex(/^asset_[0-9a-f]{24}$/u),
          expectedMapRevision: revisionSchema,
          expectedTilesetRevision: revisionSchema,
          patch: tilesetPropertyPatchSchema,
        })
        .strict(),
      outputSchema:
        tilesetPropertyEditPreviewToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      mapPath,
      tilesetAssetId,
      expectedMapRevision,
      expectedTilesetRevision,
      patch,
    }) =>
      executeTool(async () => {
        const plan =
          await maps.planTilesetPropertyEdit({
            mapPath,
            tilesetAssetId,
            expectedMapRevision,
            expectedTilesetRevision,
            patch: patch as TilesetPropertyPatch,
          });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_create_layer"] = () =>
  register(
    server,
    registeredTools,
    "tiled_create_layer",
    {
      title: "Preview creating a map layer",
      description:
        "Plans one empty tile, object, image or group layer at a root/group insertion index, pins map/dependency revisions, and returns an expiring change set without modifying project assets. Image layers require imagePath and may pin expectedImageRevision; other layer types reject both image fields.",
      inputSchema: createLayerInputSchema,
      outputSchema:
        createLayerPreviewToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async (input) =>
      executeTool(async () => {
        const plan = await maps.planCreateLayer({
          mapPath: input.mapPath,
          layerType: input.type,
          name: input.name,
          expectedMapRevision:
            input.expectedMapRevision,
          expectedDependencyRevisions:
            input.expectedDependencyRevisions,
          ...(input.parentGroupId === undefined
            ? {}
            : { parentGroupId: input.parentGroupId }),
          ...(input.index === undefined
            ? {}
            : { index: input.index }),
          ...(input.type !== "imagelayer"
            ? {}
            : {
                imagePath: input.imagePath as string,
                ...(input.expectedImageRevision === undefined
                  ? {}
                  : {
                      expectedImageRevision:
                        input.expectedImageRevision,
                    }),
              }),
        });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_preview_edits"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_edits",
    {
      title: "Preview map edits",
      description:
        "Plans a batch of map edits without modifying project assets, then returns an expiring changeSetId bound to the exact map and current dependency revisions; nothing is written until tiled_apply_change_set commits it. Batchable operations, by the \"type\" field: setTiles (direct cell writes), fillRegion (dense rectangle), stampPattern, floodFill (bounded four-way), copyRegion (snapshot-based), replaceTiles (exact swaps), updateMap (root map properties), updateLayer (common layer properties), createObject, updateObject, deleteObjects (including bounded scalar custom-property patches). These six must each be the only operation in their change set: resizeMap, removeTilesetFromMap, deleteLayer, moveLayer, duplicateLayer, transcodeTileLayer. A shape:\"tile\" draft encodes its external TileRef into gid exactly like a tile-layer cell and requires explicit width/height; updateObject can retarget an existing tile object, and shape objects never become tile objects.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          expectedRevision: revisionSchema,
          expectedDependencyRevisions: dependencyRevisionsSchema,
          operations: z
            .array(mapEditSchema)
            .min(1)
            .max(128)
            .superRefine((operations, context) => {
              let pathPointCount = 0;
              let textObjectPayloadBytes = 0;
              let propertyPatchBytes = 0;
              for (const operation of operations) {
                if (
                  operation.type ===
                    "createObject" &&
                  (operation.object.shape ===
                    "polygon" ||
                    operation.object.shape ===
                      "polyline")
                ) {
                  pathPointCount +=
                    operation.object.points.length;
                } else if (
                  operation.type ===
                    "updateObject" &&
                  operation.patch.points !==
                    undefined
                ) {
                  pathPointCount +=
                    operation.patch.points.length;
                }
                if (
                  operation.type ===
                  "createObject"
                ) {
                  try {
                    textObjectPayloadBytes +=
                      measureTextObjectPayloadBytes(
                        operation.object,
                      );
                  } catch {
                    // Nested schemas report invalid text fields.
                  }
                } else if (
                  operation.type ===
                  "updateObject"
                ) {
                  try {
                    textObjectPayloadBytes +=
                      measureTextObjectPayloadBytes(
                        operation.patch,
                      );
                  } catch {
                    // Nested schemas report invalid text fields.
                  }
                  if (
                    operation.patch.properties !==
                    undefined
                  ) {
                    propertyPatchBytes +=
                      measurePropertiesPatchBytes(
                        operation.patch.properties,
                      );
                  }
                }
              }
              if (
                pathPointCount >
                MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET
              ) {
                context.addIssue({
                  code: "custom",
                  message:
                    `Polygon and polyline create and update operations may contain at most ${MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET} total points per change set`,
                });
              }
              if (
                textObjectPayloadBytes >
                MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET
              ) {
                context.addIssue({
                  code: "custom",
                  message:
                    `Text object fields may contain at most ${MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET} canonical JSON UTF-8 bytes per change set`,
                });
              }
              if (
                propertyPatchBytes >
                MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET
              ) {
                context.addIssue({
                  code: "custom",
                  message:
                    `Object property writes may contain at most ${MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET} canonical JSON UTF-8 bytes per change set`,
                });
              }
            }),
        })
        .strict(),
      outputSchema:
        previewEditsToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      mapPath,
      expectedRevision,
      expectedDependencyRevisions,
      operations,
    }) =>
      executeTool(async () => {
        const plan = await maps.planEdits(
          mapPath,
          expectedRevision,
          expectedDependencyRevisions,
          operations as MapEditOperation[],
        );
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_preview_shape"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_shape",
    {
      title: "Preview drawing a tile shape",
      description:
        "Rasterizes one deterministic geometric shape — a Bresenham line, a rectangle outline or fill, or a midpoint ellipse inscribed in its bounding rectangle — into exact tile cells and returns an ordinary mapEdit change set carrying the setTiles writes. Pure bounded computation: no randomness, no clipping (a shape that leaves the map fails closed), at most 10,000 cells, and a null tile erases along the shape. Every preview, revision-pin, and transaction rule applies unchanged.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          layerId: z.number().int().positive(),
          draw: z.discriminatedUnion("shape", [
            z
              .object({
                shape: z.literal("line"),
                from: z
                  .object({
                    x: z.number().int(),
                    y: z.number().int(),
                  })
                  .strict(),
                to: z
                  .object({
                    x: z.number().int(),
                    y: z.number().int(),
                  })
                  .strict(),
              })
              .strict(),
            z
              .object({
                shape: z.literal("rectangle"),
                x: z.number().int(),
                y: z.number().int(),
                width: z
                  .number()
                  .int()
                  .positive(),
                height: z
                  .number()
                  .int()
                  .positive(),
                fill: z.boolean(),
              })
              .strict(),
            z
              .object({
                shape: z.literal("ellipse"),
                x: z.number().int(),
                y: z.number().int(),
                width: z
                  .number()
                  .int()
                  .positive(),
                height: z
                  .number()
                  .int()
                  .positive(),
                fill: z.boolean(),
              })
              .strict(),
          ]),
          tile: namedTileRefSchema.nullable(),
          expectedMapRevision: revisionSchema,
          expectedDependencyRevisions:
            dependencyRevisionsSchema,
        })
        .strict(),
      outputSchema: previewShapeToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      mapPath,
      layerId,
      draw,
      tile,
      expectedMapRevision,
      expectedDependencyRevisions,
    }) =>
      executeTool(async () => {
        const [resolvedTile] =
          await maps.resolveNamedTiles(mapPath, [
            tile as
              | TileRef
              | { name: string }
              | null,
          ]);
        const plan = await maps.planDrawShape({
          mapPath,
          layerId,
          draw,
          tile: resolvedTile ?? null,
          expectedMapRevision,
          expectedDependencyRevisions,
        });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_preview_generate"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_generate",
    {
      title:
        "Preview seeded procedural generation",
      description:
        "Computes a deterministic seeded value field over one bounded region — smooth value noise (stateless coordinate hash, so the same seed always reproduces the same output and results are translation-stable), a cellular cave automaton yielding exactly 0 (open) and 1 (wall), or a rooms-and-corridors dungeon yielding exactly 0 (floor) and 1 (wall) with every floor cell connected (sequential seeded stream drawn region-relative, so a shifted region reproduces the same layout) — then maps values to tiles through explicit [min, max) intervals (max 1 inclusive; unmatched cells are skipped for sparse generation) and returns an ordinary mapEdit change set carrying the setTiles writes. Math.random is never involved; a mapping that matches no cells fails closed, as does a dungeon region too small for one minimum room plus its wall ring.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          layerId: z.number().int().positive(),
          region: z
            .object({
              x: z.number().int().min(0),
              y: z.number().int().min(0),
              width: z
                .number()
                .int()
                .positive(),
              height: z
                .number()
                .int()
                .positive(),
            })
            .strict(),
          seed: z
            .number()
            .int()
            .min(Number.MIN_SAFE_INTEGER)
            .max(Number.MAX_SAFE_INTEGER),
          generator: z.discriminatedUnion(
            "algorithm",
            [
              z
                .object({
                  algorithm: z.literal("noise"),
                  scale: z
                    .number()
                    .int()
                    .min(1)
                    .max(256)
                    .optional(),
                })
                .strict(),
              z
                .object({
                  algorithm:
                    z.literal("cellular"),
                  fillProbability: z
                    .number()
                    .min(0)
                    .max(1)
                    .optional(),
                  iterations: z
                    .number()
                    .int()
                    .min(0)
                    .max(16)
                    .optional(),
                  birthLimit: z
                    .number()
                    .int()
                    .min(1)
                    .max(8)
                    .optional(),
                })
                .strict(),
              z
                .object({
                  algorithm:
                    z.literal("dungeon"),
                  maxRooms: z
                    .number()
                    .int()
                    .min(1)
                    .max(64)
                    .optional(),
                  roomAttempts: z
                    .number()
                    .int()
                    .min(1)
                    .max(256)
                    .optional(),
                  minRoomSize: z
                    .number()
                    .int()
                    .min(2)
                    .max(64)
                    .optional(),
                  maxRoomSize: z
                    .number()
                    .int()
                    .min(2)
                    .max(64)
                    .optional(),
                })
                .strict(),
            ],
          ),
          mapping: z
            .array(
              z
                .object({
                  min: z.number().min(0).max(1),
                  max: z.number().min(0).max(1),
                  tile: namedTileRefSchema.nullable(),
                })
                .strict(),
            )
            .min(1)
            .max(16),
          expectedMapRevision: revisionSchema,
          expectedDependencyRevisions:
            dependencyRevisionsSchema,
        })
        .strict(),
      outputSchema: previewEditsToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      mapPath,
      layerId,
      region,
      seed,
      generator,
      mapping,
      expectedMapRevision,
      expectedDependencyRevisions,
    }) =>
      executeTool(async () => {
        const mappingTiles =
          await maps.resolveNamedTiles(
            mapPath,
            mapping.map(
              (entry) =>
                entry.tile as
                  | TileRef
                  | { name: string }
                  | null,
            ),
          );
        const plan = await maps.planGenerate({
          mapPath,
          layerId,
          region,
          seed,
          generator,
          mapping: mapping.map(
            (entry, index) => ({
              min: entry.min,
              max: entry.max,
              tile: mappingTiles[index] ?? null,
            }),
          ),
          expectedMapRevision,
          expectedDependencyRevisions,
        });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_preview_scatter"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_scatter",
    {
      title:
        "Preview seeded decoration scatter",
      description:
        "Scatters decoration tiles over one bounded region with a deterministic density roll per cell: a stateless coordinate hash gates each cell against the density and a second salted hash picks one weighted tile from the choice list, so the same seed always reproduces the same picks and results are translation-stable. Math.random is never involved. With skipOccupied, cells already holding a tile are left untouched; a null choice erases where it lands. Returns an ordinary mapEdit change set carrying the setTiles writes; a scatter that matches no cells fails closed.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          layerId: z.number().int().positive(),
          region: z
            .object({
              x: z.number().int().min(0),
              y: z.number().int().min(0),
              width: z
                .number()
                .int()
                .positive(),
              height: z
                .number()
                .int()
                .positive(),
            })
            .strict(),
          seed: z
            .number()
            .int()
            .min(Number.MIN_SAFE_INTEGER)
            .max(Number.MAX_SAFE_INTEGER),
          density: z
            .number()
            .gt(0)
            .max(1),
          choices: z
            .array(
              z
                .object({
                  tile: namedTileRefSchema.nullable(),
                  weight: z
                    .number()
                    .positive()
                    .max(1_000_000),
                })
                .strict(),
            )
            .min(1)
            .max(16),
          skipOccupied: z.boolean().optional(),
          expectedMapRevision: revisionSchema,
          expectedDependencyRevisions:
            dependencyRevisionsSchema,
        })
        .strict(),
      outputSchema: previewEditsToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      mapPath,
      layerId,
      region,
      seed,
      density,
      choices,
      skipOccupied,
      expectedMapRevision,
      expectedDependencyRevisions,
    }) =>
      executeTool(async () => {
        const choiceTiles =
          await maps.resolveNamedTiles(
            mapPath,
            choices.map(
              (choice) =>
                choice.tile as
                  | TileRef
                  | { name: string }
                  | null,
            ),
          );
        const plan = await maps.planScatter({
          mapPath,
          layerId,
          region,
          seed,
          density,
          choices: choices.map(
            (choice, index) => ({
              tile: choiceTiles[index] ?? null,
              weight: choice.weight,
            }),
          ),
          skipOccupied,
          expectedMapRevision,
          expectedDependencyRevisions,
        });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_preview_import_image"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_import_image",
    {
      title:
        "Preview importing a reference image",
      description:
        "Resamples one project reference image onto a bounded cell grid — each cell averages its alpha-weighted pixel block — maps every cell to the nearest palette color by squared RGB distance (ties resolve to palette order), and returns an ordinary mapEdit change set carrying the setTiles writes. Fully transparent blocks are skipped, a null palette tile erases where its color wins, and palette tiles accept semantic {name} references. Pure integer arithmetic: the same image and palette always produce the same plan; a fully transparent region fails closed.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          layerId: z.number().int().positive(),
          imagePath: projectPathSchema,
          region: z
            .object({
              x: z.number().int().min(0),
              y: z.number().int().min(0),
              width: z
                .number()
                .int()
                .positive(),
              height: z
                .number()
                .int()
                .positive(),
            })
            .strict(),
          palette: z
            .array(
              z
                .object({
                  color: z
                    .string()
                    .regex(
                      /^#[0-9a-fA-F]{6}$/u,
                    ),
                  tile: namedTileRefSchema.nullable(),
                })
                .strict(),
            )
            .min(1)
            .max(32),
          expectedMapRevision: revisionSchema,
          expectedDependencyRevisions:
            dependencyRevisionsSchema,
        })
        .strict(),
      outputSchema: previewEditsToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      mapPath,
      layerId,
      imagePath,
      region,
      palette,
      expectedMapRevision,
      expectedDependencyRevisions,
    }) =>
      executeTool(async () => {
        const paletteTiles =
          await maps.resolveNamedTiles(
            mapPath,
            palette.map(
              (entry) =>
                entry.tile as
                  | TileRef
                  | { name: string }
                  | null,
            ),
          );
        const plan = await maps.planImportImage({
          mapPath,
          layerId,
          imagePath,
          region,
          palette: palette.map(
            (entry, index) => ({
              color: entry.color,
              tile: paletteTiles[index] ?? null,
            }),
          ),
          expectedMapRevision,
          expectedDependencyRevisions,
        });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_preview_prefab"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_prefab",
    {
      title: "Preview stamping a prefab region",
      description:
        "Stamps one source-map region as a prefab: tiles from one source tile layer — carried as tileset+localId references, so a target map missing the tileset fails closed — and optionally objects anchored inside the region's pixel bounds from one source object layer, materialized at planning time into ordinary setTiles and createObject operations against the target map (the plan itself is the frozen prefab; nothing re-reads the source at apply, and an optional expectedSourceRevision asserts the source up front). Empty source cells are skipped unless copyEmpty stamps the rectangle verbatim as erasure; extraTileLayers stamps additional source-to-target tile-layer pairs over the same region in one plan, and flipHorizontal mirrors the tile stamp with official TileLayer::flip bit semantics (tile layers only — combining it with objects fails closed). Objects outside the supported draft profile — custom properties, template instances, unknown members — fail closed rather than being silently dropped, as do cross-map object stamps between maps with differing tile sizes.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          sourceMapPath: projectPathSchema,
          source: z
            .object({
              layerId: z
                .number()
                .int()
                .positive(),
              x: z.number().int().min(0),
              y: z.number().int().min(0),
              width: z
                .number()
                .int()
                .positive(),
              height: z
                .number()
                .int()
                .positive(),
            })
            .strict(),
          target: z
            .object({
              layerId: z
                .number()
                .int()
                .positive(),
              x: z.number().int().min(0),
              y: z.number().int().min(0),
            })
            .strict(),
          objects: z
            .object({
              sourceLayerId: z
                .number()
                .int()
                .positive(),
              targetLayerId: z
                .number()
                .int()
                .positive(),
            })
            .strict()
            .optional(),
          extraTileLayers: z
            .array(
              z
                .object({
                  sourceLayerId: z
                    .number()
                    .int()
                    .positive(),
                  targetLayerId: z
                    .number()
                    .int()
                    .positive(),
                })
                .strict(),
            )
            .min(1)
            .max(16)
            .optional(),
          flipHorizontal: z
            .boolean()
            .optional(),
          copyEmpty: z.boolean().optional(),
          expectedMapRevision: revisionSchema,
          expectedDependencyRevisions:
            dependencyRevisionsSchema,
          expectedSourceRevision:
            revisionSchema.optional(),
        })
        .strict(),
      outputSchema: previewEditsToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      mapPath,
      sourceMapPath,
      source,
      target,
      objects,
      extraTileLayers,
      flipHorizontal,
      copyEmpty,
      expectedMapRevision,
      expectedDependencyRevisions,
      expectedSourceRevision,
    }) =>
      executeTool(async () => {
        const plan = await maps.planStampPrefab({
          mapPath,
          sourceMapPath,
          source,
          target,
          objects,
          extraTileLayers,
          flipHorizontal,
          copyEmpty,
          expectedMapRevision,
          expectedDependencyRevisions,
          expectedSourceRevision,
        });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_preview_template"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_template",
    {
      title:
        "Preview placing a template instance",
      description:
        "Places one JSON object template instance in Tiled's minimal serialized form — {id, template, x, y}, with every other member inherited from the template at load time. The template is read and validated through the same fail-closed profile as template expansion (tile and nested templates reject), its revision is pinned into the plan, and apply re-verifies both the pin and that the map-relative reference still resolves to the pinned path. Returns an ordinary mapEdit change set.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          layerId: z.number().int().positive(),
          templatePath: projectPathSchema,
          x: z
            .number()
            .finite()
            .min(-1_000_000_000)
            .max(1_000_000_000),
          y: z
            .number()
            .finite()
            .min(-1_000_000_000)
            .max(1_000_000_000),
          expectedMapRevision: revisionSchema,
          expectedDependencyRevisions:
            dependencyRevisionsSchema,
          expectedTemplateRevision:
            revisionSchema.optional(),
        })
        .strict(),
      outputSchema: previewEditsToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      mapPath,
      layerId,
      templatePath,
      x,
      y,
      expectedMapRevision,
      expectedDependencyRevisions,
      expectedTemplateRevision,
    }) =>
      executeTool(async () => {
        const plan =
          await maps.planInstantiateTemplate({
            mapPath,
            layerId,
            templatePath,
            x,
            y,
            expectedMapRevision,
            expectedDependencyRevisions,
            expectedTemplateRevision,
          });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_preview_write_xml"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_write_xml",
    {
      title: "Preview a native XML write",
      description:
        "Serializes one restricted-profile project document to Tiled 1.12.2's own XML bytes, byte for byte, choosing the writer from the source extension: .tmj -> TMX, .tsj -> TSX, .tj -> TX. Any other extension fails closed. TMX covers finite orthogonal maps, external tileset references, CSV tile layers, and top-level tile/object layers the serializer fully understands; embedded tilesets, image and group layers, custom properties, template instances, unknown members, and floats whose six-significant-digit rendering would lose precision all fail closed. TSX requires the declared grid to be derivable from the declared image size, margin, and spacing (the official exporter recomputes it, so a disagreeing declaration fails closed rather than drifting); per-tile metadata, wang sets, custom properties, and unknown members also fail closed. TX follows Tiled's writeObjectTemplate exactly. References and GIDs carry verbatim in every case, so the target must be a new file in the source document's directory. Returns an expiring fileExport change set whose producer is the native serializer; apply re-serializes under the pinned source revision and fails closed unless the bytes exactly match the approved content hash. No Tiled CLI is involved.",
      inputSchema: z
        .object({
          sourcePath: projectPathSchema,
          targetPath: projectPathSchema,
          expectedRevision: revisionSchema,
          projectFilePath:
            projectPathSchema.optional(),
        })
        .strict(),
      outputSchema:
        fileExportPreviewToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      sourcePath,
      targetPath,
      expectedRevision,
      projectFilePath,
    }) =>
      executeTool(async () => {
        // The writer is chosen by source extension rather than by three
        // separate tools: those took identical shapes and differed only in
        // what their path and revision fields were named.
        if (sourcePath.endsWith(".tmj")) {
          return changeSets.put(
            await maps.planWriteTmx({
              mapPath: sourcePath,
              targetPath,
              expectedMapRevision: expectedRevision,
              projectFilePath,
            }),
          );
        }
        if (sourcePath.endsWith(".tsj")) {
          return changeSets.put(
            await maps.planWriteTsx({
              tilesetPath: sourcePath,
              targetPath,
              expectedTilesetRevision:
                expectedRevision,
              projectFilePath,
            }),
          );
        }
        if (sourcePath.endsWith(".tj")) {
          return changeSets.put(
            await maps.planWriteTx({
              templatePath: sourcePath,
              targetPath,
              expectedTemplateRevision:
                expectedRevision,
              projectFilePath,
            }),
          );
        }
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `sourcePath must end in .tmj, .tsj, or .tj; got ${sourcePath}.`,
        );
      }),
  );

  const selectBaseMatchSchemas = [
    z
      .object({
        kind: z.literal("tiles"),
        tiles: z
          .array(namedTileRefSchema)
          .min(1)
          .max(16),
      })
      .strict(),
    z
      .object({
        kind: z.literal("empty"),
      })
      .strict(),
    z
      .object({
        kind: z.literal("nonEmpty"),
      })
      .strict(),
    z
      .object({
        kind: z.literal("magicWand"),
        seed: z
          .object({
            x: z.number().int().min(0),
            y: z.number().int().min(0),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("polygon"),
        points: z
          .array(
            z
              .object({
                x: z
                  .number()
                  .min(-1e9)
                  .max(1e9),
                y: z
                  .number()
                  .min(-1e9)
                  .max(1e9),
              })
              .strict(),
          )
          .min(3)
          .max(64),
      })
      .strict(),
  ] as const;

  toolRegistrars["tiled_select"] = () =>
  register(
    server,
    registeredTools,
    "tiled_select",
    {
      title: "Select cells by predicate",
      description:
        "Evaluates one stateless selection predicate over a bounded tile-layer region — a tile set matched by tileset+localId (flip bits ignored), empty cells, or non-empty cells — and returns the selection as plain data: exact cell count, tight bounding box, and a bounded coordinate sample (at most 2,048 cells, with truncation disclosed). No selection id or server-side selection state exists; feed the result into region- or cell-based tools explicitly. Works on orthogonal, isometric, staggered, and hexagonal maps. Read-only.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          layerId: z.number().int().positive(),
          region: z
            .object({
              x: z.number().int().min(0),
              y: z.number().int().min(0),
              width: z
                .number()
                .int()
                .positive(),
              height: z
                .number()
                .int()
                .positive(),
            })
            .strict()
            .optional(),
          match: z.discriminatedUnion("kind", [
            ...selectBaseMatchSchemas,
            z
              .object({
                kind: z.literal("compose"),
                steps: z
                  .array(
                    z
                      .object({
                        op: z.enum([
                          "union",
                          "intersect",
                          "subtract",
                        ]),
                        match:
                          z.discriminatedUnion(
                            "kind",
                            selectBaseMatchSchemas,
                          ),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(8),
              })
              .strict(),
          ]),
          sampleLimit: z
            .number()
            .int()
            .min(1)
            .max(10_000)
            .optional(),
        })
        .strict(),
      outputSchema: selectCellsToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({
      mapPath,
      layerId,
      region,
      match,
      sampleLimit,
    }) =>
      executeTool(async () => {
        type BaseMatch =
          | { kind: "tiles"; tiles: TileRef[] }
          | { kind: "empty" }
          | { kind: "nonEmpty" }
          | {
              kind: "magicWand";
              seed: { x: number; y: number };
            }
          | {
              kind: "polygon";
              points: Array<{
                x: number;
                y: number;
              }>;
            };
        const resolveBase = async (
          base: unknown,
        ): Promise<BaseMatch> => {
          const candidate = base as BaseMatch;
          if (candidate.kind !== "tiles") {
            return candidate;
          }
          return {
            kind: "tiles",
            tiles: (
              await maps.resolveNamedTiles(
                mapPath,
                candidate.tiles as Array<
                  TileRef | { name: string }
                >,
              )
            ).filter(
              (tile): tile is TileRef =>
                tile !== null,
            ),
          };
        };
        const resolvedMatch =
          match.kind === "compose"
            ? {
                kind: "compose" as const,
                steps: await Promise.all(
                  match.steps.map(
                    async (step) => ({
                      op: step.op,
                      match: await resolveBase(
                        step.match,
                      ),
                    }),
                  ),
                ),
              }
            : await resolveBase(match);
        return maps.selectCells({
          mapPath,
          layerId,
          region,
          match: resolvedMatch,
          sampleLimit,
        });
      }),
  );

  toolRegistrars["tiled_list_tile_names"] = () =>
  register(
    server,
    registeredTools,
    "tiled_list_tile_names",
    {
      title: "List registered tile names",
      description:
        "Reads the server-owned .tiledmcp/tile-names.json registry — a validated name-to-{tileset, localId} map that lets later requests reference tiles by semantic name instead of bare ids. Names are restricted lowercase identifiers (at most 4,096 entries); every referenced tileset must exist and gets its revision pinned into the result. The registry is weak metadata: localId is disclosed verbatim without re-checking tileset contents, and a missing registry file reads as empty rather than failing. Read-only.",
      inputSchema: z.object({}).strict(),
      outputSchema:
        listTileNamesToolOutputSchema,
      annotations: READ_ONLY,
    },
    async () =>
      executeTool(() => maps.listTileNames()),
  );

  toolRegistrars["tiled_preview_tile_names"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_tile_names",
    {
      title: "Preview tile-name registry edits",
      description:
        "Validates upsert/delete edits to the server-owned .tiledmcp/tile-names.json semantic registry and returns an expiring tileNameEdit change set — no Tiled asset is touched. Upserted names are restricted lowercase identifiers whose tilesets must exist as project .tsj files (re-verified at apply); deleting an unregistered name fails closed, the registry is bounded at 4,096 names, and the registry file's revision — or its absence — is pinned so a concurrent registry write fails closed. Apply replays the operations, verifies the result against the approved content hash, and rewrites the registry canonically.",
      inputSchema: z
        .object({
          operations: z
            .array(
              z.discriminatedUnion("type", [
                z
                  .object({
                    type: z.literal(
                      "upsertName",
                    ),
                    name: z
                      .string()
                      .regex(
                        /^[a-z0-9][a-z0-9_-]{0,63}$/u,
                      ),
                    tileset:
                      projectPathSchema,
                    localId: z
                      .number()
                      .int()
                      .min(0)
                      .max(1_000_000),
                  })
                  .strict(),
                z
                  .object({
                    type: z.literal(
                      "deleteName",
                    ),
                    name: z
                      .string()
                      .regex(
                        /^[a-z0-9][a-z0-9_-]{0,63}$/u,
                      ),
                  })
                  .strict(),
              ]),
            )
            .min(1)
            .max(64),
          expectedRegistryRevision:
            revisionSchema.nullable().optional(),
        })
        .strict(),
      outputSchema:
        tileNameEditPreviewToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      operations,
      expectedRegistryRevision,
    }) =>
      executeTool(async () => {
        const plan =
          await maps.planTileNameEdits({
            operations,
            expectedRegistryRevision,
          });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_preview_validation_fixes"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_validation_fixes",
    {
      title:
        "Preview mechanical validation fixes",
      description:
        "Scans every tile layer of one map for cells whose base GID falls outside all bound tileset ranges and returns an ordinary mapEdit change set erasing exactly those dangling cells — nothing applies without the usual preview and approval, and a map with nothing mechanically fixable fails closed instead of returning an empty plan. Dangling tile-object GIDs are reported by tiled_validate but deliberately not auto-fixed: deleting objects is a human decision. More than 10,000 dangling cells also fails closed — that scale points at a broken tileset reference, not at data worth erasing.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          expectedMapRevision: revisionSchema,
          expectedDependencyRevisions:
            dependencyRevisionsSchema,
        })
        .strict(),
      outputSchema: previewEditsToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      mapPath,
      expectedMapRevision,
      expectedDependencyRevisions,
    }) =>
      executeTool(async () => {
        const plan =
          await maps.planValidationFixes({
            mapPath,
            expectedMapRevision,
            expectedDependencyRevisions,
          });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_preview_property_types"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_property_types",
    {
      title:
        "Preview project property type edits",
      description:
        "Validates sequential upsert/delete edits to one .tiled-project file's propertyTypes definitions and returns an expiring propertyTypeEdit change set. upsertClass and upsertEnum replace a same-name definition in place (keeping its id) or append with id = max + 1, exactly like Tiled's own allocation; deleteType (destructive) refuses to remove a type still referenced by another definition's member, but references from maps and tilesets are not scanned — serialized values there keep working and simply lose their annotations. Apply patches only the propertyTypes member under the pinned project-file revision.",
      inputSchema: z
        .object({
          projectFilePath: projectPathSchema,
          expectedRevision: revisionSchema,
          operations: z
            .array(
              z.discriminatedUnion("type", [
                z
                  .object({
                    type: z.literal(
                      "upsertClass",
                    ),
                    name: z
                      .string()
                      .min(1)
                      .max(512),
                    color: z
                      .string()
                      .regex(/^#[0-9a-f]{8}$/iu)
                      .optional(),
                    drawFill: z
                      .boolean()
                      .optional(),
                    useAs: z
                      .array(
                        z.enum([
                          "property",
                          "map",
                          "layer",
                          "object",
                          "tile",
                          "tileset",
                          "wangcolor",
                          "wangset",
                          "project",
                        ]),
                      )
                      .min(1)
                      .max(9)
                      .optional(),
                    members: z
                      .array(
                        z
                          .object({
                            name: z
                              .string()
                              .min(1)
                              .max(512),
                            type: z.enum([
                              "string",
                              "int",
                              "float",
                              "bool",
                              "color",
                              "file",
                              "object",
                            ]),
                            value: z.union([
                              z
                                .string()
                                .max(4_096),
                              z
                                .number()
                                .finite(),
                              z.boolean(),
                            ]),
                            propertyType: z
                              .string()
                              .min(1)
                              .max(512)
                              .optional(),
                          })
                          .strict(),
                      )
                      .max(256),
                  })
                  .strict(),
                z
                  .object({
                    type: z.literal(
                      "upsertEnum",
                    ),
                    name: z
                      .string()
                      .min(1)
                      .max(512),
                    storageType: z.enum([
                      "string",
                      "int",
                    ]),
                    values: z
                      .array(
                        z
                          .string()
                          .min(1)
                          .max(512),
                      )
                      .min(1)
                      .max(256),
                    valuesAsFlags: z
                      .boolean()
                      .optional(),
                  })
                  .strict(),
                z
                  .object({
                    type: z.literal(
                      "deleteType",
                    ),
                    name: z
                      .string()
                      .min(1)
                      .max(512),
                  })
                  .strict(),
              ]),
            )
            .min(1)
            .max(16),
        })
        .strict(),
      outputSchema:
        propertyTypeEditPreviewToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      projectFilePath,
      expectedRevision,
      operations,
    }) =>
      executeTool(async () => {
        const plan =
          await maps.planPropertyTypeEdits({
            projectFilePath,
            expectedRevision,
            operations,
          });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_preview_world_edits"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_world_edits",
    {
      title: "Preview world member edits",
      description:
        "Validates bounded add, move, and remove operations on one JSON world's explicit map members - members addressed by their current array index under the world's revision pin, additions requiring existing project-local .tmj maps - and returns an expiring change set without modifying project assets. Referenced map files are never touched.",
      inputSchema: z
        .object({
          worldPath: projectPathSchema,
          expectedRevision: revisionSchema,
          operations: z
            .array(
              z.discriminatedUnion("type", [
                z
                  .object({
                    type: z.literal("addMap"),
                    fileName: z
                      .string()
                      .min(1)
                      .max(4_096),
                    x: worldCoordinateSchema,
                    y: worldCoordinateSchema,
                    width: worldSizeSchema.optional(),
                    height:
                      worldSizeSchema.optional(),
                  })
                  .strict(),
                z
                  .object({
                    type: z.literal("moveMap"),
                    index: z
                      .number()
                      .int()
                      .min(0)
                      .max(999),
                    x: worldCoordinateSchema,
                    y: worldCoordinateSchema,
                  })
                  .strict(),
                z
                  .object({
                    type: z.literal("removeMap"),
                    index: z
                      .number()
                      .int()
                      .min(0)
                      .max(999),
                  })
                  .strict(),
              ]),
            )
            .min(1)
            .max(MAX_WORLD_EDIT_OPERATIONS),
        })
        .strict(),
      outputSchema:
        worldEditPreviewToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({
      worldPath,
      expectedRevision,
      operations,
    }) =>
      executeTool(async () => {
        const plan = await maps.planWorldEdits({
          worldPath,
          expectedRevision,
          operations: operations as never,
        });
        return changeSets.put(plan);
      }),
  );

  toolRegistrars["tiled_preview_transaction"] = () =>
  register(
    server,
    registeredTools,
    "tiled_preview_transaction",
    {
      title:
        "Preview an atomic multi-file transaction",
      description:
        "Composes between 2 and 16 already previewed, unapplied map edit, tileset edit, tileset creation, or file deletion change sets with pairwise-distinct target paths into one expiring transaction change set, locking each member against individual apply. Applying the transaction commits every member through a crash-recoverable redo journal: all targets land or none do.",
      inputSchema: z
        .object({
          changeSetIds: z
            .array(
              z
                .string()
                .regex(
                  /^changeset:[0-9a-f]{64}$/u,
                ),
            )
            .min(MIN_TRANSACTION_MEMBERS)
            .max(MAX_TRANSACTION_MEMBERS)
            .superRefine(
              (changeSetIds, context) => {
                const seen = new Set<string>();
                for (const [
                  index,
                  changeSetId,
                ] of changeSetIds.entries()) {
                  if (seen.has(changeSetId)) {
                    context.addIssue({
                      code: "custom",
                      message: `changeSetIds[${index}] repeats ${changeSetId}`,
                      path: [index],
                    });
                  }
                  seen.add(changeSetId);
                }
              },
            ),
        })
        .strict(),
      outputSchema:
        previewTransactionToolOutputSchema,
      annotations: PREVIEW_ONLY,
    },
    async ({ changeSetIds }) =>
      executeTool(async () =>
        changeSets.previewTransaction(
          changeSetIds,
        ),
      ),
  );

  const applyTransactionChangeSet = async (
    plan: TransactionPlan,
  ) => {
    const memberPlans =
      changeSets.resolveTransactionMembers(plan);
    const outcome = await maps.applyTransaction(
      plan,
      memberPlans,
    );
    changeSets.completeTransactionMembers(
      plan,
      outcome.memberResults,
    );
    return outcome.result;
  };

  toolRegistrars["tiled_apply_change_set"] = () =>
  register(
    server,
    registeredTools,
    "tiled_apply_change_set",
    {
      title: "Apply an approved change set",
      description:
        "Applies one previously previewed map edit, tileset edit, tileset creation, file deletion, atomic multi-file transaction, checkpoint restore, current-before-verified prepared-checkpoint discard, explicit prepared-checkpoint commit or abandon adjudication, single committed-checkpoint prune, or explicit committed-checkpoint prune batch after checking its approved SHA-256 revision and all plan-specific evidence and dependency pins. Applying a document edit also persists project-internal asset-identity safety metadata.",
      inputSchema: z
        .object({
          changeSetId: z.string().regex(/^changeset:[0-9a-f]{64}$/u),
          expectedRevision: revisionSchema,
        })
        .strict(),
      outputSchema: toolOutputSchema(
        applyResultOutputSchema,
      ),
      annotations: {
        title: "Apply an approved local Tiled change",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ changeSetId, expectedRevision }) =>
      executeTool(() =>
        changeSets.apply(
          changeSetId,
          expectedRevision,
          (plan) =>
            applyChangeSetPlan(plan, {
              store,
              maps,
              exportAsset: (options) =>
                cli.exportAsset(options),
              applyTransaction:
                applyTransactionChangeSet,
            }),
        ),
      ),
  );

  if (cliCapabilities.rasterizer.available) {
    const rasterizerVersion =
      cliCapabilities.rasterizer.version;
    if (
      rasterizerVersion === null ||
      rasterizerVersion.length === 0 ||
      rasterizerVersion.length >
        MAX_RENDERER_VERSION_LENGTH
    ) {
      throw new Error(
        "Available TmxRasterizer capability is missing its probed version.",
      );
    }
    toolRegistrars[TILED_MCP_OPTIONAL_TOOL_NAMES[0]] = () =>
    register(
      server,
      registeredTools,
      TILED_MCP_OPTIONAL_TOOL_NAMES[0],
      {
        title: "Render a Tiled map preview",
        description:
          "Runs the local TmxRasterizer with bounded options and returns an inline PNG plus traceable artifact, renderer, option, map, and external-TSJ metadata.",
        inputSchema: z
          .object({
            mapPath: projectPathSchema,
            size: z
              .number()
              .int()
              .positive()
              .max(MAX_RASTER_RENDER_EDGE)
              .optional(),
            ignoreVisibility: z.boolean().optional(),
          })
          .strict(),
        outputSchema:
          rasterMapToolOutputSchema,
        annotations: READ_ONLY,
      },
      async ({ mapPath, size, ignoreVisibility }) =>
        renderMutex.runExclusive("tmxrasterizer", async () => {
          try {
            const sourceSnapshot =
              await maps.assertRenderSafe(mapPath);
            const inputPath = await resolver.resolveExisting(mapPath);
            const outputDirectory =
              await resolver.ensureInternalDirectory(".tiledmcp/renders");
            const outputPath = join(outputDirectory, `${randomUUID()}.png`);
            try {
              const options = {
                size: size ?? DEFAULT_RASTER_RENDER_EDGE,
                ignoreVisibility:
                  ignoreVisibility ?? false,
              };
              const rendered = await cli.renderPng(
                inputPath,
                outputPath,
                {
                  ...options,
                  maxPngBytes:
                    MAX_RASTER_PNG_BYTES,
                },
              );
              const pixelSize =
                inspectRasterPngResult(
                  rendered,
                  options.size,
                );
              await maps.assertRenderSafe(
                mapPath,
                sourceSnapshot,
              );
              const result = {
                mimeType: "image/png",
                pixelSize,
                byteLength:
                  rendered.png.byteLength,
                sha256:
                  revisionOf(rendered.png),
                map: sourceSnapshot.map,
                dependencyRevisions:
                  sourceSnapshot.dependencyRevisions,
                renderer: {
                  kind: "tmxrasterizer",
                  version:
                    rasterizerVersion,
                  profile:
                    RASTER_RENDER_PROFILE,
                },
                options,
                snapshotConsistency:
                  RASTER_SNAPSHOT_CONSISTENCY,
                truncated: false,
              };
              return imageToolResult(
                result,
                rendered.png,
              );
            } finally {
              await removeRasterOutput(
                outputPath,
              );
            }
          } catch (error) {
            return toolError(error);
          }
        }),
    );
  }

  if (cliCapabilities.tiled.available) {
    toolRegistrars["tiled_preview_export"] = () =>
    register(
      server,
      registeredTools,
      "tiled_preview_export",
      {
        title: "Preview a Tiled CLI export",
        description:
          "Runs the local Tiled CLI's own --export-map/--export-tileset conversion from one project .tmj/.tsj source into a server-owned staging file and returns an expiring fileExport change set carrying the approved output's content hash. The format comes from the probed export-format whitelist (explicit or via the target extension); the target must be a new project file (exports never overwrite), the source is revision-pinned, and apply re-runs the export and fails closed unless the output bytes exactly match the approved hash.",
        inputSchema: z
          .object({
            sourcePath: projectPathSchema,
            targetPath: projectPathSchema,
            format: z
              .string()
              .regex(/^[a-z0-9]{1,16}$/u)
              .optional(),
            expectedSourceRevision:
              revisionSchema.optional(),
          })
          .strict(),
        outputSchema:
          fileExportPreviewToolOutputSchema,
        annotations: PREVIEW_ONLY,
      },
      async ({
        sourcePath,
        targetPath,
        format,
        expectedSourceRevision,
      }) =>
        executeTool(async () => {
          const plan = await maps.planExportFile(
            {
              sourcePath,
              targetPath,
              ...(format === undefined
                ? {}
                : { format }),
              ...(expectedSourceRevision ===
              undefined
                ? {}
                : { expectedSourceRevision }),
            },
            (options) =>
              cli.exportAsset(options),
            {
              map: cliCapabilities.tiled
                .mapExportFormats,
              tileset:
                cliCapabilities.tiled
                  .tilesetExportFormats,
            },
          );
          return changeSets.put(plan);
        }),
    );
  }

  // Terrain painting is core, not CLI-gated: corners are matched natively by
  // `computeWangCornerPaint`. The CLI path stays available to
  // `planTerrainPaint` as the parity reference the Tiled cross-checks drive.
  toolRegistrars["tiled_preview_terrain"] = () =>
    register(
      server,
      registeredTools,
      "tiled_preview_terrain",
      {
        title:
          "Preview terrain painting via Tiled's Wang matcher",
        description:
          "Paints Wang terrain corners through Tiled's own TileLayer.wangEdit() matcher, run headlessly by a server-authored static script against the pinned map (the CLI writes only a staging copy; parameters are embedded as an inert JSON literal, so no user input reaches script code). The service diffs the target finite tile layer and returns an ordinary mapEdit change set carrying the exact setTiles cell writes — apply needs no CLI replay, untouched fragments keep their exact bytes, and every preview, revision-pin, and transaction rule applies unchanged. Corners address the corner grid (0..width, 0..height) with 1-based wang color indexes; the selected Wang set must be corner or mixed type on an external atlas tileset, and a paint that changes nothing fails closed.",
        inputSchema: z
          .object({
            mapPath: projectPathSchema,
            layerId: z.number().int().positive(),
            tilesetAssetId: z
              .string()
              .min(1)
              .max(128),
            wangSetIndex: z
              .number()
              .int()
              .min(0)
              .max(9_999),
            corners: z
              .array(
                z
                  .object({
                    x: z
                      .number()
                      .int()
                      .min(0)
                      .max(100_000),
                    y: z
                      .number()
                      .int()
                      .min(0)
                      .max(100_000),
                    colorIndex: z
                      .number()
                      .int()
                      .min(1)
                      .max(254),
                  })
                  .strict(),
              )
              .min(1)
              .max(64),
            expectedMapRevision: revisionSchema,
            expectedDependencyRevisions:
              dependencyRevisionsSchema,
          })
          .strict(),
        outputSchema:
          previewEditsToolOutputSchema,
        annotations: PREVIEW_ONLY,
      },
      async ({
        mapPath,
        layerId,
        tilesetAssetId,
        wangSetIndex,
        corners,
        expectedMapRevision,
        expectedDependencyRevisions,
      }) =>
        executeTool(async () => {
          const plan = await maps.planTerrainPaint(
            {
              mapPath,
              layerId,
              tilesetAssetId,
              wangSetIndex,
              corners,
              expectedMapRevision,
              expectedDependencyRevisions,
            },
          );
          return changeSets.put(plan);
        }),
    );

  for (const name of advertisedToolNames) {
    const registrar = toolRegistrars[name];
    if (registrar === undefined) {
      throw new Error(
        `No registrar is defined for advertised tool ${name}.`,
      );
    }
    registrar();
  }

  if (
    registeredTools.length !== advertisedToolNames.length ||
    registeredTools.some(
      (toolName, index) =>
        toolName !== advertisedToolNames[index],
    )
  ) {
    throw new Error(
      `Registered tool order does not match the advertised capability snapshot: ${JSON.stringify(
        { advertisedToolNames, registeredTools },
      )}`,
    );
  }

  return { server, cliCapabilities, registeredTools };
}

function trustToolResult(
  result: CallToolResult,
): TrustedToolResult {
  trustedToolResults.add(result);
  return result as TrustedToolResult;
}

function isTrustedToolResult(
  value: unknown,
): value is TrustedToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    trustedToolResults.has(
      value as CallToolResult,
    )
  );
}

function internalToolError(): TrustedToolResult {
  return trustToolResult({
    isError: true,
    content: [
      {
        type: "text",
        text: INTERNAL_ERROR_TEXT,
      },
    ],
    structuredContent:
      INTERNAL_ERROR_STRUCTURED_CONTENT,
  });
}

function register<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
>(
  server: McpServer,
  registeredTools: string[],
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: InputSchema;
    outputSchema: OutputSchema;
    annotations: ToolAnnotations;
  },
  callback: (
    input: z.output<InputSchema>,
  ) => Promise<TrustedToolResult>,
): void {
  const sdkCallback = (async (
    input: z.output<InputSchema>,
  ) => {
    try {
      const result = await callback(input);
      if (!isTrustedToolResult(result)) {
        return internalToolError();
      }
      if (
        !hasConsistentToolErrorSignal(
          result,
        )
      ) {
        return internalToolError();
      }
      const validation =
        config.outputSchema.safeParse(
          result.structuredContent,
        );
      return validation.success
        ? result
        : internalToolError();
    } catch {
      return internalToolError();
    }
  }) as unknown as ToolCallback<InputSchema>;
  server.registerTool(name, config, sdkCallback);
  registeredTools.push(name);
}

function hasConsistentToolErrorSignal(
  result: CallToolResult,
): boolean {
  const structuredContent =
    result.structuredContent;
  const payload =
    structuredContent !== undefined &&
    structuredContent !== null &&
    typeof structuredContent === "object" &&
    !Array.isArray(structuredContent)
      ? structuredContent.result
      : undefined;
  const hasApplicationErrorEnvelope =
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "ok" in payload &&
    payload.ok === false;
  return (
    (result.isError === true) ===
    hasApplicationErrorEnvelope
  );
}

async function executeTool(
  operation: () => Promise<unknown>,
): Promise<TrustedToolResult> {
  try {
    return toolResult(await operation());
  } catch (error) {
    return toolError(error);
  }
}

function toolResult(
  result: unknown,
  image?: {
    mimeType: "image/png";
    bytes: number;
  },
): TrustedToolResult {
  const {
    structuredContent,
    structuredContentBytes,
  } = snapshotStructuredContent(result);
  const text = serializeTextSummary({
    kind: TEXT_CONTENT_CONTRACT_NAME,
    version: TEXT_CONTENT_CONTRACT_VERSION,
    ok: true,
    structuredContentBytes,
    ...(image === undefined ? {} : { image }),
  });
  return trustToolResult({
    content: [
      {
        type: "text",
        text,
      },
    ],
    structuredContent,
  });
}

function snapshotStructuredContent(
  result: unknown,
): {
  structuredContent: Record<
    string,
    unknown
  >;
  structuredContentBytes: number;
} {
  const serialized = JSON.stringify({ result });
  const parsed: unknown =
    JSON.parse(serialized);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      "Tool structured content did not serialize to an object.",
    );
  }
  return {
    structuredContent:
      parsed as Record<string, unknown>,
    structuredContentBytes:
      Buffer.byteLength(
        serialized,
        "utf8",
      ),
  };
}

function imageToolResult(
  result: unknown,
  png: Buffer,
): TrustedToolResult {
  if (png.byteLength > MAX_INLINE_IMAGE_BYTES) {
    return toolError(
      new TiledMcpError(
        "IMAGE_TOO_LARGE",
        `Rendered image is ${png.byteLength} bytes; inline limit is ${MAX_INLINE_IMAGE_BYTES}.`,
        { bytes: png.byteLength, limit: MAX_INLINE_IMAGE_BYTES },
      ),
    );
  }
  const base = toolResult(result, {
    mimeType: "image/png",
    bytes: png.byteLength,
  });
  return trustToolResult({
    ...base,
    content: [
      ...base.content,
      {
        type: "image",
        data: png.toString("base64"),
        mimeType: "image/png",
      },
    ],
  });
}

function inspectRasterPngResult(
  rendered: RenderPngResult,
  requestedSize: number,
): {
  width: number;
  height: number;
} {
  const png = rendered.png;
  if (
    !Buffer.isBuffer(png) ||
    png.byteLength < 24 ||
    !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    png.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new TiledMcpError(
      "TMXRASTERIZER_OUTPUT_INVALID",
      "TmxRasterizer did not return a valid coherent PNG snapshot.",
    );
  }
  if (png.byteLength > MAX_INLINE_IMAGE_BYTES) {
    throw new TiledMcpError(
      "IMAGE_TOO_LARGE",
      `Rendered preview is ${png.byteLength} bytes; inline limit is ${MAX_RASTER_PNG_BYTES}.`,
      {
        bytes: png.byteLength,
        limit: MAX_RASTER_PNG_BYTES,
      },
    );
  }

  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const maxAllowedEdge = Math.min(
    MAX_RASTER_RENDER_EDGE,
    requestedSize,
  );
  if (
    width <= 0 ||
    height <= 0 ||
    width > maxAllowedEdge ||
    height > maxAllowedEdge
  ) {
    throw new TiledMcpError(
      "TMXRASTERIZER_OUTPUT_INVALID",
      `Rendered preview dimensions must be between 1 and ${maxAllowedEdge} pixels per edge for the requested size.`,
      {
        width,
        height,
        maxEdge: maxAllowedEdge,
        requestedSize,
      },
    );
  }
  if (
    rendered.bytes !== png.byteLength ||
    rendered.width !== width ||
    rendered.height !== height
  ) {
    throw new TiledMcpError(
      "TMXRASTERIZER_OUTPUT_INVALID",
      "TmxRasterizer metadata does not match the returned PNG snapshot.",
      {
        reported: {
          bytes: rendered.bytes,
          width: rendered.width,
          height: rendered.height,
        },
        actual: {
          bytes: png.byteLength,
          width,
          height,
        },
      },
    );
  }
  return { width, height };
}

async function removeRasterOutput(
  outputPath: string,
): Promise<void> {
  try {
    await unlink(outputPath);
  } catch (error) {
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    if (errorCode === "ENOENT") {
      return;
    }
    throw new TiledMcpError(
      "RASTER_TEMP_CLEANUP_FAILED",
      "The temporary raster output could not be removed safely.",
      {
        ...(errorCode === undefined
          ? {}
          : { errorCode }),
      },
    );
  }
}

function toolError(
  error: unknown,
): TrustedToolResult {
  try {
    const normalized = asTiledMcpError(error);
    const isPublic =
      isTiledMcpApplicationErrorCode(
        normalized.code,
      );
    const code: TiledMcpApplicationErrorCode =
      isPublic
        ? normalized.code
        : "INTERNAL_ERROR";
    const disclose =
      isPublic && code !== "INTERNAL_ERROR";
    if (!disclose) {
      return internalToolError();
    }
    const message = truncateOutputString(
      normalized.message,
      MAX_ERROR_MESSAGE_CHARS,
    );
    const result = {
      ok: false,
      error: {
        code,
        message,
        details: sanitizeErrorDetails(
          normalized.details,
        ),
      },
    };
    const structuredContent = { result };
    return trustToolResult({
      isError: true,
      content: [
        {
          type: "text",
          text: applicationErrorTextSummary(
            code,
            message,
            structuredContentJsonBytes(
              structuredContent,
            ),
          ),
        },
      ],
      structuredContent,
    });
  } catch {
    return internalToolError();
  }
}

function applicationErrorTextSummary(
  code: TiledMcpApplicationErrorCode,
  message: string,
  structuredContentBytes: number,
): string {
  const normalizedMessage = normalizeTextLine(message) || "Application error.";
  const codePoints = Array.from(normalizedMessage);
  const fullCandidate = serializeTextSummary({
    kind: TEXT_CONTENT_CONTRACT_NAME,
    version: TEXT_CONTENT_CONTRACT_VERSION,
    ok: false,
    error: {
      code,
      message: normalizedMessage,
    },
    structuredContentBytes,
  });
  if (
    codePoints.length <= MAX_ERROR_TEXT_MESSAGE_CODE_POINTS &&
    Buffer.byteLength(fullCandidate, "utf8") <= MAX_TEXT_CONTENT_BYTES
  ) {
    return fullCandidate;
  }

  let lower = 0;
  let upper = Math.min(
    codePoints.length - 1,
    MAX_ERROR_TEXT_MESSAGE_CODE_POINTS,
  );
  let best: string | undefined;

  while (lower <= upper) {
    const length = Math.floor(
      (lower + upper) / 2,
    );
    const preview =
      codePoints.slice(0, length).join("") + "…";
    const candidate = serializeTextSummary({
      kind: TEXT_CONTENT_CONTRACT_NAME,
      version: TEXT_CONTENT_CONTRACT_VERSION,
      ok: false,
      error: {
        code,
        message: preview,
        messageTruncated: true,
      },
      structuredContentBytes,
    });
    if (
      Buffer.byteLength(candidate, "utf8") <=
      MAX_TEXT_CONTENT_BYTES
    ) {
      best = candidate;
      lower = length + 1;
    } else {
      upper = length - 1;
    }
  }

  if (best !== undefined) {
    return best;
  }
  return serializeTextSummary({
    kind: TEXT_CONTENT_CONTRACT_NAME,
    version: TEXT_CONTENT_CONTRACT_VERSION,
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message:
        "Application error; inspect structuredContent.result.error.",
      messageTruncated: true,
    },
    structuredContentBytes,
  });
}

function normalizeTextLine(
  value: string,
): string {
  return value
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]+/gu,
      " ",
    )
    .replace(/\s+/gu, " ")
    .trim();
}

function serializeTextSummary(
  value: Record<string, unknown>,
): string {
  return JSON.stringify(value);
}

function structuredContentJsonBytes(
  structuredContent: Record<string, unknown>,
): number {
  return Buffer.byteLength(JSON.stringify(structuredContent), "utf8");
}

function sanitizeErrorValue(
  value: unknown,
  budget: { remaining: number },
  depth: number,
): unknown {
  if (budget.remaining <= 0) {
    return "[truncated]";
  }
  if (value === null || typeof value === "boolean") {
    budget.remaining -= 5;
    return value;
  }
  if (typeof value === "number") {
    budget.remaining -= 24;
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "string") {
    const output = truncateOutputString(
      value,
      Math.min(1_024, budget.remaining),
    );
    budget.remaining -= output.length;
    return output;
  }
  if (depth >= 8) {
    budget.remaining -= 11;
    return "[max depth]";
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value.slice(0, 32)) {
      if (budget.remaining <= 0) {
        break;
      }
      output.push(sanitizeErrorValue(item, budget, depth + 1));
    }
    if (value.length > output.length) {
      output.push(`[${value.length - output.length} items omitted]`);
    }
    return output;
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, 32);
    for (const [rawKey, item] of entries) {
      if (budget.remaining <= 0) {
        break;
      }
      const key = truncateOutputString(rawKey, 128);
      budget.remaining -= key.length;
      Object.defineProperty(
        output,
        key,
        {
          configurable: true,
          enumerable: true,
          value: sanitizeErrorValue(
            item,
            budget,
            depth + 1,
          ),
          writable: true,
        },
      );
    }
    const totalKeys = Object.keys(value).length;
    if (totalKeys > entries.length && budget.remaining > 0) {
      Object.defineProperty(
        output,
        "__truncated__",
        {
          configurable: true,
          enumerable: true,
          value:
            `${totalKeys - entries.length} keys omitted`,
          writable: true,
        },
      );
    }
    return output;
  }
  const unsupported = "[unsupported]";
  budget.remaining -= unsupported.length;
  return unsupported;
}

function sanitizeErrorDetails(
  value: unknown,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }
  const sanitized = sanitizeErrorValue(
    value,
    { remaining: MAX_ERROR_DETAIL_CHARS },
    0,
  );
  return (
    sanitized !== null &&
    typeof sanitized === "object" &&
    !Array.isArray(sanitized)
  )
    ? sanitized as Record<string, unknown>
    : {};
}

function hasAtMostCodePoints(
  value: string,
  limit: number,
): boolean {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > limit) {
      return false;
    }
  }
  return true;
}

function truncateOutputString(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  if (maximum <= 1) {
    return value.slice(0, maximum);
  }
  return `${value.slice(0, maximum - 1)}…`;
}
