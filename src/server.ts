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
import type { JsonValue } from "./formats/json.js";
import {
  DEFAULT_TILESET_SHEET_PAGE_SIZE,
  DEFAULT_TILESET_SHEET_SCALE,
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
  MAX_NATIVE_PREVIEW_PIXELS,
  MAX_NATIVE_PREVIEW_PIXEL_BLENDS,
  MAX_NATIVE_PREVIEW_SCALE,
} from "./images/mapPreview.js";
import {
  DEFAULT_USAGE_TOP_TILE_LIMIT,
  MAX_ADD_TILESET_GID_SCANS,
  MAX_CELL_WRITES,
  MAX_CREATE_MAP_DIMENSION,
  MAX_CREATE_MAP_TILE_EDGE,
  MAX_CREATE_TILE_LAYER_CELLS,
  MAX_DUPLICATE_LAYER_BYTES,
  MAX_FLOOD_FILL_SCANS,
  MAX_LAYER_NAME_LENGTH,
  MAX_MAP_CLASS_NAME_CODE_POINTS,
  MAX_REMOVE_TILESET_GID_SCANS,
  MAX_REPLACE_TILE_MAPPINGS,
  MAX_REPLACE_TILE_SCANS,
  MAX_STAMP_PATTERN_CELLS,
  MAX_STAMP_PATTERN_EDGE,
  MAX_TILE_OPERATION_SCANS,
  MAX_USAGE_DISTINCT_TILES,
  MAX_USAGE_LAYER_SUMMARIES,
  MAX_USAGE_RESULT_BYTES,
  MAX_USAGE_SCAN_VALUES,
  MAX_USAGE_TILESET_SUMMARIES,
  MAX_USAGE_TOP_TILE_LIMIT,
  MAX_USAGE_UNUSED_LOCAL_ID_SAMPLE,
  type AnalyzeUsageInput,
  type MapService,
} from "./maps/mapService.js";
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
import type { MapEditOperation } from "./maps/types.js";
import {
  applyResultOutputSchema,
  commitResultOutputSchema,
  exactJsonValueOutputSchema,
  toolOutputSchema,
} from "./outputSchemas/common.js";
import {
  addTilesetPreviewToolOutputSchema,
  checkpointRestorePreviewToolOutputSchema,
  createLayerPreviewToolOutputSchema,
  previewEditsToolOutputSchema,
} from "./outputSchemas/changeSets.js";
import {
  checkpointListToolOutputSchema,
  listFilesToolOutputSchema,
  mapSummaryToolOutputSchema,
  nativePreviewToolOutputSchema,
  objectListToolOutputSchema,
  rasterMapToolOutputSchema,
  regionToolOutputSchema,
  tilesetSheetToolOutputSchema,
  validationToolOutputSchema,
} from "./outputSchemas/read.js";
import {
  tileFindToolOutputSchema,
  tilesetDetailToolOutputSchema,
  usageAnalysisToolOutputSchema,
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
import {
  applyCheckpointRestore,
  planCheckpointRestore,
} from "./storage/checkpointRestore.js";
import {
  CHECKPOINT_ID_PATTERN,
  CHECKPOINT_STORAGE_POLICY,
} from "./storage/checkpoints.js";
import type { DocumentStore } from "./storage/documentStore.js";
import { KeyedMutex } from "./storage/keyedMutex.js";
import { revisionOf } from "./storage/revision.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

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

const tileTransformSchema = z
  .object({
    kind: z.literal("orthogonal").optional(),
    flipH: z.boolean().optional(),
    flipV: z.boolean().optional(),
    flipD: z.boolean().optional(),
    rawFlags: uint32Schema.optional(),
  })
  .strict();

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
  .strict();

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

const createObjectSchema = z
  .object({
    type: z.literal("createObject"),
    layerId: positiveIdSchema,
    object: z.discriminatedUnion("shape", [
      rectangleObjectSchema,
      pointObjectSchema,
      ellipseObjectSchema,
      capsuleObjectSchema,
    ]),
  })
  .strict();

const objectPatchSchema = z
  .object({
    x: objectCoordinateSchema.optional(),
    y: objectCoordinateSchema.optional(),
    width: objectExtentSchema.optional(),
    height: objectExtentSchema.optional(),
    name: objectStringSchema.optional(),
    className: objectStringSchema.optional(),
    rotation: objectCoordinateSchema.optional(),
    visible: z.boolean().optional(),
    opacity: objectOpacitySchema.optional(),
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

const mapEditSchema = z.discriminatedUnion("type", [
  updateMapSchema,
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
    "tiled_list_checkpoints",
    "tiled_preview_checkpoint_restore",
    "tiled_get_map_summary",
    "tiled_get_tileset",
    "tiled_find_tiles",
    "tiled_get_region",
    "tiled_render_tileset_sheet",
    "tiled_render_preview",
    "tiled_list_objects",
    "tiled_validate",
    "tiled_analyze_usage",
    "tiled_create_map",
    "tiled_add_tileset_to_map",
    "tiled_create_layer",
    "tiled_preview_edits",
    "tiled_apply_change_set",
  ] as const);
export const TILED_MCP_OPTIONAL_TOOL_NAMES =
  Object.freeze([
    "tiled_render_map",
  ] as const);
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
    [...TILED_MCP_CORE_TOOL_NAMES] as unknown as JsonValue,
  ),
  exactJsonValueOutputSchema(
    [
      ...TILED_MCP_CORE_TOOL_NAMES,
      ...TILED_MCP_OPTIONAL_TOOL_NAMES,
    ] as unknown as JsonValue,
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
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  const registeredTools: string[] = [];

  registerGuideResource(server);
  registerApplicationErrorResource(server);

  const advertisedToolNames = [
    ...TILED_MCP_CORE_TOOL_NAMES,
    ...(cliCapabilities.rasterizer.available
      ? TILED_MCP_OPTIONAL_TOOL_NAMES
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
        mapOperations: ["updateMap"],
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
          ],
          shapeMutation: false,
          ellipseAndCapsuleDimensions:
            "optional-nonnegative-default-zero",
          sourcePatch:
            "object-layer-objects-member-local",
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
          storagePolicy: {
            ...CHECKPOINT_STORAGE_POLICY,
            maxBytes:
              store.checkpoints.maxBytes,
            maxEntries:
              store.checkpoints.maxEntries,
            garbageCollectionTrigger:
              "quota-pressure-or-explicit-internal-call",
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
        tilesetSheetCapabilities: {
          supportedFormats: ["png", "jpeg", "webp", "simple-svg"],
          pageIndexBase: 0,
          defaultPageSize: DEFAULT_TILESET_SHEET_PAGE_SIZE,
          defaultScale: DEFAULT_TILESET_SHEET_SCALE,
          consecutiveLocalIds: true,
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
          overlays: ["grid", "coordinates"],
          regionCoordinates: "absolute-map-tiles",
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
          maxStampPatternEdge: MAX_STAMP_PATTERN_EDGE,
          maxStampPatternCells:
            MAX_STAMP_PATTERN_CELLS,
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
          version: 1,
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
          readOnlyToolEffect:
            "may-update-project-internal-safety-metadata-only",
        },
        cli: cliCapabilities,
        registeredTools: advertisedToolNames,
      };
  const capabilitiesToolOutputSchema =
    toolOutputSchema(
      exactJsonValueOutputSchema(
        capabilitiesResult as unknown as JsonValue,
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

  register(
    server,
    registeredTools,
    "tiled_preview_checkpoint_restore",
    {
      title: "Preview restoring a recovery checkpoint",
      description:
        "Validates one checkpoint and its exact pre-write JSON bytes, pins the current target revision, and returns a destructive restore proposal without writing. Only that document is restored; referenced tilesets, images and other files are not.",
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

  register(
    server,
    registeredTools,
    "tiled_get_map_summary",
    {
      title: "Read a Tiled map summary",
      description:
        "Reads dimensions, normalized root render/background/class metadata, revision, layer tree and external tileset identities before editing. Asset discovery may update project-internal safety metadata.",
      inputSchema: z.object({ mapPath: projectPathSchema }).strict(),
      outputSchema: mapSummaryToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ mapPath }) => executeTool(() => maps.getSummary(mapPath)),
  );

  register(
    server,
    registeredTools,
    "tiled_get_tileset",
    {
      title: "Read referenced tileset details",
      description:
        "Returns a bounded semantic summary of one external atlas TSJ referenced by a map, including sparse tile metadata, animation, collision counts and Wang-set overviews. Asset discovery may update project-internal safety metadata.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          tilesetAssetId: z.string().min(1).max(128),
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
    async ({ mapPath, tilesetAssetId, startTileId, limit }) =>
      executeTool(() =>
        maps.getTileset({
          mapPath,
          tilesetAssetId,
          startTileId,
          limit,
        }),
      ),
  );

  register(
    server,
    registeredTools,
    "tiled_find_tiles",
    {
      title: "Find tiles by explicit semantics",
      description:
        "Searches one referenced external TSJ for exact tile classes or explicitly serialized scalar properties and returns bounded TileRefs ordered by local ID. Asset discovery may update project-internal safety metadata.",
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

  register(
    server,
    registeredTools,
    "tiled_get_region",
    {
      title: "Read a tile region",
      description:
        "Returns a bounded rectangular tile region using tileset asset IDs and local tile IDs. Asset discovery may update project-internal safety metadata.",
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

  register(
    server,
    registeredTools,
    "tiled_render_tileset_sheet",
    {
      title: "Render a labeled tileset sheet",
      description:
        "Renders one bounded page of an atlas tileset referenced by a map, with every tile labeled by its local ID. Asset discovery may update project-internal safety metadata.",
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

  register(
    server,
    registeredTools,
    "tiled_render_preview",
    {
      title: "Render a native tile-layer map preview",
      description:
        "Renders a bounded finite orthogonal TMJ region without invoking TmxRasterizer. The v1 profile supports static external atlas tile layers and reports visible non-tile layers it omits. Asset discovery may update project-internal safety metadata.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          region: z
            .object({
              x: z.number().int().min(0),
              y: z.number().int().min(0),
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
            })
            .strict()
            .optional(),
        })
        .strict(),
      outputSchema:
        nativePreviewToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ mapPath, region, layerIds, scale, overlays }) =>
      renderMutex.runExclusive("sharp-render", async () => {
        try {
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

  register(
    server,
    registeredTools,
    "tiled_list_objects",
    {
      title: "List map objects",
      description:
        "Returns a bounded list of objects from all object layers or one selected object layer. Asset discovery may update project-internal safety metadata.",
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

  register(
    server,
    registeredTools,
    "tiled_validate",
    {
      title: "Validate a Tiled map",
      description:
        "Performs structural and MVP-profile validation without modifying the map, tilesets, or images. Asset discovery may update only the project-internal safety metadata advertised by capabilities.",
      inputSchema: z.object({ mapPath: projectPathSchema }).strict(),
      outputSchema:
        validationToolOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ mapPath }) => executeTool(() => maps.validate(mapPath)),
  );

  register(
    server,
    registeredTools,
    "tiled_analyze_usage",
    {
      title: "Analyze tile usage",
      description:
        "Returns bounded whole-map tile frequency, layer density, transform, used-tileset, and unused-local-ID summaries. Hidden layers and tile objects are included. Asset discovery may update project-internal safety metadata.",
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

  register(
    server,
    registeredTools,
    "tiled_add_tileset_to_map",
    {
      title: "Preview adding a tileset to a map",
      description:
        "Validates one existing project-local external atlas TSJ, assigns its GID range after all current ranges, and returns an expiring map change set without modifying project assets. Asset discovery may update project-internal safety metadata.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          tilesetPath: projectPathSchema,
          expectedMapRevision: revisionSchema,
          expectedDependencyRevisions: dependencyRevisionsSchema,
          expectedTilesetRevision: revisionSchema.optional(),
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
        });
        return changeSets.put(plan);
      }),
  );

  register(
    server,
    registeredTools,
    "tiled_create_layer",
    {
      title: "Preview creating a map layer",
      description:
        "Plans one empty tile, object, image or group layer at a root/group insertion index, pins map/dependency revisions, and returns an expiring change set without modifying project assets. Asset discovery may update project-internal safety metadata. Image layers require imagePath and may pin expectedImageRevision; other layer types reject both image fields.",
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

  register(
    server,
    registeredTools,
    "tiled_preview_edits",
    {
      title: "Preview map edits",
      description:
        "Validates root map-property updates, exclusive unused-tileset-reference removal, direct tile writes, dense rectangular pattern stamps, bounded four-way flood fills, snapshot-based tile-region copies, exact tile replacements, common layer-property updates, exclusive safe layer deletion, movement or duplication, and object operations without modifying project assets, then returns an expiring changeSetId bound to the exact map and current dependency revisions. Asset discovery may update project-internal safety metadata.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          expectedRevision: revisionSchema,
          expectedDependencyRevisions: dependencyRevisionsSchema,
          operations: z.array(mapEditSchema).min(1).max(128),
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

  register(
    server,
    registeredTools,
    "tiled_apply_change_set",
    {
      title: "Apply an approved change set",
      description:
        "Applies one previously previewed map edit or checkpoint restore after checking its approved SHA-256 target revision and all plan-specific dependency pins.",
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
            plan.kind === "checkpointRestore"
              ? applyCheckpointRestore(store, plan)
              : maps.applyEdits(plan),
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
    register(
      server,
      registeredTools,
      TILED_MCP_OPTIONAL_TOOL_NAMES[0],
      {
        title: "Render a Tiled map preview",
        description:
          "Runs the local TmxRasterizer with bounded options and returns an inline PNG plus traceable artifact, renderer, option, map, and external-TSJ metadata. Asset discovery may update project-internal safety metadata.",
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
