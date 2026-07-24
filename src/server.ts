import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  McpServer,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import type { TiledCliAdapter, TiledCliCapabilities } from "./adapters/tiledCli.js";
import {
  ChangeSetRegistry,
  DEFAULT_MAX_PENDING_CELL_WRITES,
} from "./changeSets.js";
import { TiledMcpError, asTiledMcpError } from "./errors.js";
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
import type { ProjectPathResolver } from "./project/pathResolver.js";
import {
  GUIDE_RESOURCE_URI,
  registerGuideResource,
} from "./resources/guide.js";
import {
  applyCheckpointRestore,
  planCheckpointRestore,
} from "./storage/checkpointRestore.js";
import { CHECKPOINT_ID_PATTERN } from "./storage/checkpoints.js";
import type { DocumentStore } from "./storage/documentStore.js";
import { KeyedMutex } from "./storage/keyedMutex.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CONTENT_BYTES = 64 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 4_096;
const MAX_ERROR_DETAIL_CHARS = 8_000;
const DEFAULT_RENDER_EDGE = 1400;
const MAX_RENDER_EDGE = 2048;
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

const createObjectSchema = z
  .object({
    type: z.literal("createObject"),
    layerId: positiveIdSchema,
    object: z.discriminatedUnion("shape", [
      rectangleObjectSchema,
      pointObjectSchema,
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
const resultOutputSchema = z.object({ result: z.unknown() }).strict();

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
  const { resolver, store, maps, cli } = dependencies;
  const cliCapabilities = await cli.probeCapabilities();
  const changeSets = new ChangeSetRegistry();
  const renderMutex = new KeyedMutex();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  const registeredTools: string[] = [];

  registerGuideResource(server);

  register(
    server,
    registeredTools,
    "tiled_get_capabilities",
    {
      title: "Inspect TiledMCP capabilities",
      description:
        "Returns the implemented edit profile and locally available Tiled command-line adapters.",
      inputSchema: z.object({}).strict(),
      outputSchema: resultOutputSchema,
      annotations: READ_ONLY,
    },
    async () =>
      toolResult({
        protocolBaseline: "2025-11-25",
        serverVersion: SERVER_VERSION,
        resourceCapabilities: {
          direct: [GUIDE_RESOURCE_URI],
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
          boundedListing: true,
          exactByteRestoreKernel: true,
          previewAndApplyRestore: true,
          restoreScope: "single-existing-json-document",
          restoresReferencedDependencies: false,
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
        limits: {
          maxDocumentBytes: 64 * 1024 * 1024,
          maxAggregateTilesetDependencyBytes: 64 * 1024 * 1024,
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
          maxRenderEdge: MAX_RENDER_EDGE,
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
          cooperativeWriterLocking: true,
          externalWriterAtomicCompareAndSwap: false,
          staticSymlinkRejection: true,
          hostileParentSwapProtection: false,
          jsonLexicalPreservation: {
            outsideEditedRanges: true,
            editedRangesReformatted: true,
          },
        },
        cli: cliCapabilities,
        registeredTools,
      }),
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
      outputSchema: resultOutputSchema,
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
      outputSchema: resultOutputSchema,
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
      outputSchema: resultOutputSchema,
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
        "Reads dimensions, normalized root render/background/class metadata, revision, layer tree and external tileset identities before editing.",
      inputSchema: z.object({ mapPath: projectPathSchema }).strict(),
      outputSchema: resultOutputSchema,
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
        "Returns a bounded semantic summary of one external atlas TSJ referenced by a map, including sparse tile metadata, animation, collision counts and Wang-set overviews.",
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
      outputSchema: resultOutputSchema,
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
        "Searches one referenced external TSJ for exact tile classes or explicitly serialized scalar properties and returns bounded TileRefs ordered by local ID.",
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
      outputSchema: resultOutputSchema,
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
        "Returns a bounded rectangular tile region using tileset asset IDs and local tile IDs.",
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
      outputSchema: resultOutputSchema,
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
        "Renders one bounded page of an atlas tileset referenced by a map, with every tile labeled by its local ID.",
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
      outputSchema: resultOutputSchema,
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
        "Renders a bounded finite orthogonal TMJ region without invoking TmxRasterizer. The v1 profile supports static external atlas tile layers and reports visible non-tile layers it omits.",
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
      outputSchema: resultOutputSchema,
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
        "Returns a bounded list of objects from all object layers or one selected object layer.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          layerId: positiveIdSchema.optional(),
          limit: z.number().int().min(1).max(10_000).default(1_000),
        })
        .strict(),
      outputSchema: resultOutputSchema,
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
        "Performs read-only structural and MVP-profile validation. It never modifies the file.",
      inputSchema: z.object({ mapPath: projectPathSchema }).strict(),
      outputSchema: resultOutputSchema,
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
        "Returns bounded whole-map tile frequency, layer density, transform, used-tileset, and unused-local-ID summaries. Hidden layers and tile objects are included.",
      inputSchema: usageAnalysisInputSchema,
      outputSchema: resultOutputSchema,
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
        "Creates a new TMJ file and refuses to overwrite an existing path. Parent directories must exist.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          width: z.number().int().positive().max(100_000),
          height: z.number().int().positive().max(100_000),
          tileWidth: z.number().int().positive().max(16_384),
          tileHeight: z.number().int().positive().max(16_384),
          backgroundColor: z
            .string()
            .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u)
            .optional(),
        })
        .strict(),
      outputSchema: resultOutputSchema,
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
        "Validates one existing project-local external atlas TSJ, assigns its GID range after all current ranges, and returns an expiring map change set without writing.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          tilesetPath: projectPathSchema,
          expectedMapRevision: revisionSchema,
          expectedDependencyRevisions: dependencyRevisionsSchema,
          expectedTilesetRevision: revisionSchema.optional(),
        })
        .strict(),
      outputSchema: resultOutputSchema,
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
        "Plans one empty tile, object, image or group layer at a root/group insertion index, pins map/dependency revisions, and returns an expiring change set without writing. Image layers require imagePath and may pin expectedImageRevision; other layer types reject both image fields.",
      inputSchema: createLayerInputSchema,
      outputSchema: resultOutputSchema,
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
        "Validates root map-property updates, exclusive unused-tileset-reference removal, direct tile writes, dense rectangular pattern stamps, bounded four-way flood fills, snapshot-based tile-region copies, exact tile replacements, common layer-property updates, exclusive safe layer deletion, movement or duplication, and object operations without writing, then returns an expiring changeSetId bound to the exact map and current dependency revisions.",
      inputSchema: z
        .object({
          mapPath: projectPathSchema,
          expectedRevision: revisionSchema,
          expectedDependencyRevisions: dependencyRevisionsSchema,
          operations: z.array(mapEditSchema).min(1).max(128),
        })
        .strict(),
      outputSchema: resultOutputSchema,
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
      outputSchema: resultOutputSchema,
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
    register(
      server,
      registeredTools,
      "tiled_render_map",
      {
        title: "Render a Tiled map preview",
        description:
          "Runs the local TmxRasterizer with bounded options and returns an inline PNG preview.",
        inputSchema: z
          .object({
            mapPath: projectPathSchema,
            size: z.number().int().positive().max(MAX_RENDER_EDGE).optional(),
            ignoreVisibility: z.boolean().optional(),
          })
          .strict(),
        outputSchema: resultOutputSchema,
        annotations: READ_ONLY,
      },
      async ({ mapPath, size, ignoreVisibility }) =>
        renderMutex.runExclusive("tmxrasterizer", async () => {
          try {
            await maps.assertRenderSafe(mapPath);
            const inputPath = await resolver.resolveExisting(mapPath);
            const outputDirectory =
              await resolver.ensureInternalDirectory(".tiledmcp/renders");
            const outputPath = join(outputDirectory, `${randomUUID()}.png`);
            try {
              const options = {
                size: size ?? DEFAULT_RENDER_EDGE,
                ...(ignoreVisibility === undefined ? {} : { ignoreVisibility }),
              };
              const rendered = await cli.renderPng(inputPath, outputPath, options);
              if (rendered.bytes > MAX_INLINE_IMAGE_BYTES) {
                throw new TiledMcpError(
                  "IMAGE_TOO_LARGE",
                  `Rendered preview is ${rendered.bytes} bytes; inline limit is ${MAX_INLINE_IMAGE_BYTES}.`,
                  { bytes: rendered.bytes, limit: MAX_INLINE_IMAGE_BYTES },
                );
              }
              const png = await readFile(outputPath);
              const result = {
                mapPath,
                mimeType: "image/png",
                bytes: rendered.bytes,
                width: rendered.width,
                height: rendered.height,
              };
              return {
                content: [
                  { type: "text", text: JSON.stringify({ result }, null, 2) },
                  { type: "image", data: png.toString("base64"), mimeType: "image/png" },
                ],
                structuredContent: { result },
              };
            } finally {
              await unlink(outputPath).catch(() => undefined);
            }
          } catch (error) {
            return toolError(error);
          }
        }),
    );
  }

  return { server, cliCapabilities, registeredTools };
}

function register<InputSchema extends z.ZodType>(
  server: McpServer,
  registeredTools: string[],
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: InputSchema;
    outputSchema: typeof resultOutputSchema;
    annotations: ToolAnnotations;
  },
  callback: (input: z.output<InputSchema>) => Promise<CallToolResult>,
): void {
  const sdkCallback = callback as unknown as ToolCallback<InputSchema>;
  server.registerTool(name, config, sdkCallback);
  registeredTools.push(name);
}

async function executeTool(operation: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return toolResult(await operation());
  } catch (error) {
    return toolError(error);
  }
}

function toolResult(result: unknown): CallToolResult {
  const fullText = JSON.stringify({ result }, null, 2);
  const text =
    Buffer.byteLength(fullText, "utf8") <= MAX_TEXT_CONTENT_BYTES
      ? fullText
      : JSON.stringify(
          {
            result: {
              notice: "The full result is available in structuredContent.",
              structuredBytes: Buffer.byteLength(fullText, "utf8"),
            },
          },
          null,
          2,
        );
  return {
    content: [{ type: "text", text }],
    structuredContent: { result },
  };
}

function imageToolResult(result: unknown, png: Buffer): CallToolResult {
  if (png.byteLength > MAX_INLINE_IMAGE_BYTES) {
    return toolError(
      new TiledMcpError(
        "IMAGE_TOO_LARGE",
        `Rendered image is ${png.byteLength} bytes; inline limit is ${MAX_INLINE_IMAGE_BYTES}.`,
        { bytes: png.byteLength, limit: MAX_INLINE_IMAGE_BYTES },
      ),
    );
  }
  const base = toolResult(result);
  return {
    ...base,
    content: [
      ...base.content,
      {
        type: "image",
        data: png.toString("base64"),
        mimeType: "image/png",
      },
    ],
  };
}

function toolError(error: unknown): CallToolResult {
  const normalized = asTiledMcpError(error);
  const budget = { remaining: MAX_ERROR_DETAIL_CHARS };
  const result = {
    ok: false,
    error: {
      code: normalized.code.slice(0, 128),
      message: truncateOutputString(
        normalized.message,
        MAX_ERROR_MESSAGE_CHARS,
      ),
      details: sanitizeErrorValue(normalized.details, budget, 0),
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ result }, null, 2) }],
    structuredContent: { result },
  };
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
      output[key] = sanitizeErrorValue(item, budget, depth + 1);
    }
    const totalKeys = Object.keys(value).length;
    if (totalKeys > entries.length && budget.remaining > 0) {
      output.__truncated__ = `${totalKeys - entries.length} keys omitted`;
    }
    return output;
  }
  const fallback = String(value);
  const output = truncateOutputString(
    fallback,
    Math.min(1_024, budget.remaining),
  );
  budget.remaining -= output.length;
  return output;
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
