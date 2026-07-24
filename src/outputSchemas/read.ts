import { z } from "zod";

import {
  MAX_NATIVE_PREVIEW_BYTES,
  MAX_NATIVE_PREVIEW_EDGE,
  MAX_NATIVE_PREVIEW_SCALE,
} from "../images/mapPreview.js";
import {
  MAX_TILESET_SHEET_BYTES,
  MAX_TILESET_SHEET_COLUMNS,
  MAX_TILESET_SHEET_EDGE,
  MAX_TILESET_SHEET_PAGE_SIZE,
  MAX_TILESET_SHEET_SCALE,
} from "../images/tilesetSheet.js";
import {
  MAX_PREVIEW_ATLASES,
  MAX_PREVIEW_LAYERS,
  MAX_PREVIEW_OMITTED_LAYERS,
  MAX_PREVIEW_REGION_CELLS,
} from "../maps/previewScene.js";
import {
  assetIdOutputSchema,
  checkpointIdOutputSchema,
  checkpointTimestampOutputSchema,
  dependencyRevisionsOutputSchema,
  diagnosticOutputSchema,
  integerOutputSchema,
  integerRectOutputSchema,
  mapSnapshotOutputSchema,
  nonnegativeIntegerOutputSchema,
  pixelSizeOutputSchema,
  positiveIntegerOutputSchema,
  projectPathOutputSchema,
  resolvedTileRefOutputSchema,
  revisionOutputSchema,
  toolOutputSchema,
} from "./common.js";

const tiledColorOutputSchema = z
  .string()
  .regex(/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu);

const displayStringOutputSchema = z.string();
const truncatedMarkerOutputSchema = z
  .literal(true)
  .optional();

const projectAssetOutputSchema = z
  .object({
    path: projectPathOutputSchema,
    kind: z.enum([
      "map",
      "project",
      "template",
      "tileset",
      "world",
    ]),
  })
  .strict();

const listFilesResultOutputSchema = z.array(
  projectAssetOutputSchema,
).max(10_000);

export const listFilesToolOutputSchema =
  toolOutputSchema(listFilesResultOutputSchema);

const checkpointBeforeOutputSchema = z.union([
  z
    .object({
      existed: z.literal(false),
    })
    .strict(),
  z
    .object({
      existed: z.literal(true),
      revision: revisionOutputSchema,
      objectHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/u),
      size: nonnegativeIntegerOutputSchema,
    })
    .strict(),
]);

const checkpointManifestOutputSchema = z
  .object({
    version: z.literal(1),
    id: checkpointIdOutputSchema,
    createdAt:
      checkpointTimestampOutputSchema,
    label: z.string(),
    path: projectPathOutputSchema,
    status: z.enum(["prepared", "committed"]),
    before: checkpointBeforeOutputSchema,
    afterRevision: revisionOutputSchema,
  })
  .strict();

const corruptCheckpointOutputSchema = z
  .object({
    fileName: z.string(),
    checkpointId:
      checkpointIdOutputSchema.optional(),
    code: z.literal("CHECKPOINT_CORRUPT"),
    message: z.string(),
  })
  .strict();

const checkpointListResultOutputSchema = z
  .object({
    manifests: z.array(
      checkpointManifestOutputSchema,
    ).max(1_000),
    corruptEntries: z.array(
      corruptCheckpointOutputSchema,
    ).max(1_000),
    scannedEntries: nonnegativeIntegerOutputSchema,
    truncated: z.boolean(),
  })
  .strict();

export const checkpointListToolOutputSchema =
  toolOutputSchema(
    checkpointListResultOutputSchema,
  );

const mapLayerCommonShape = {
  id: positiveIntegerOutputSchema,
  name: displayStringOutputSchema,
  nameTruncated: truncatedMarkerOutputSchema,
  visible: z.boolean(),
  opacity: z.number(),
} as const;

const mapLayerOutputSchema: z.ZodType = z.lazy(
  () =>
    z.union([
      z
        .object({
          ...mapLayerCommonShape,
          type: z.literal("tilelayer"),
          width: positiveIntegerOutputSchema,
          height: positiveIntegerOutputSchema,
          x: integerOutputSchema,
          y: integerOutputSchema,
        })
        .strict(),
      z
        .object({
          ...mapLayerCommonShape,
          type: z.literal("group"),
          layers: z
            .array(mapLayerOutputSchema)
            .max(10_000),
        })
        .strict(),
      z
        .object({
          ...mapLayerCommonShape,
          type: z.enum([
            "objectgroup",
            "imagelayer",
          ]),
        })
        .strict(),
    ]),
);

const mapTilesetBindingOutputSchema = z
  .object({
    assetId: assetIdOutputSchema,
    path: projectPathOutputSchema,
    name: displayStringOutputSchema,
    nameTruncated: truncatedMarkerOutputSchema,
    firstGid: positiveIntegerOutputSchema,
    tileCount: positiveIntegerOutputSchema,
    gidSpan: positiveIntegerOutputSchema,
    lastPotentialGid:
      positiveIntegerOutputSchema,
    revision: revisionOutputSchema,
  })
  .strict();

const mapSummaryResultOutputSchema = z
  .object({
    path: projectPathOutputSchema,
    revision: revisionOutputSchema,
    format: z.literal("tmj"),
    orientation: z.literal("orthogonal"),
    infinite: z.literal(false),
    renderOrder: z.enum([
      "right-down",
      "right-up",
      "left-down",
      "left-up",
    ]),
    backgroundColor:
      tiledColorOutputSchema.optional(),
    className: z.string().optional(),
    classNameTruncated:
      truncatedMarkerOutputSchema,
    width: positiveIntegerOutputSchema,
    height: positiveIntegerOutputSchema,
    tileWidth: positiveIntegerOutputSchema,
    tileHeight: positiveIntegerOutputSchema,
    layers: z
      .array(mapLayerOutputSchema)
      .max(10_000),
    tilesets: z.array(
      mapTilesetBindingOutputSchema,
    ).max(4_096),
    dependencyRevisions:
      dependencyRevisionsOutputSchema,
    editableProfile: z.literal(
      "finite-orthogonal-tmj-external-atlas-tsj",
    ),
  })
  .strict();

export const mapSummaryToolOutputSchema =
  toolOutputSchema(mapSummaryResultOutputSchema);

const regionLayerOutputSchema = z
  .object({
    id: positiveIntegerOutputSchema,
    name: z.string(),
  })
  .strict();

const regionRectOutputSchema = z
  .object({
    x: integerOutputSchema,
    y: integerOutputSchema,
    width: positiveIntegerOutputSchema,
    height: positiveIntegerOutputSchema,
  })
  .strict();

const regionResultOutputSchema = z
  .object({
    mapPath: projectPathOutputSchema,
    revision: revisionOutputSchema,
    dependencyRevisions:
      dependencyRevisionsOutputSchema,
    layer: regionLayerOutputSchema,
    region: regionRectOutputSchema,
    rows: z.array(
      z.array(
        resolvedTileRefOutputSchema.nullable(),
      ).max(MAX_PREVIEW_REGION_CELLS),
    ).max(MAX_PREVIEW_REGION_CELLS),
  })
  .strict();

export const regionToolOutputSchema =
  toolOutputSchema(regionResultOutputSchema);

const listedObjectOutputSchema = z
  .object({
    id: positiveIntegerOutputSchema,
    layerId: positiveIntegerOutputSchema,
    layerName: displayStringOutputSchema,
    layerNameTruncated:
      truncatedMarkerOutputSchema,
    name: displayStringOutputSchema,
    nameTruncated: truncatedMarkerOutputSchema,
    className: displayStringOutputSchema,
    classNameTruncated:
      truncatedMarkerOutputSchema,
    shape: z.enum([
      "rectangle",
      "point",
      "ellipse",
      "capsule",
      "polygon",
      "polyline",
      "text",
      "tile",
      "template",
    ]),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    rotation: z.number(),
    visible: z.boolean(),
    opacity: z.number(),
  })
  .strict();

const objectListResultOutputSchema = z
  .object({
    mapPath: projectPathOutputSchema,
    revision: revisionOutputSchema,
    dependencyRevisions:
      dependencyRevisionsOutputSchema,
    total: nonnegativeIntegerOutputSchema,
    truncated: z.boolean(),
    objects: z
      .array(listedObjectOutputSchema)
      .max(10_000),
  })
  .strict();

export const objectListToolOutputSchema =
  toolOutputSchema(objectListResultOutputSchema);

const validationResultOutputSchema = z
  .object({
    path: projectPathOutputSchema,
    revision: revisionOutputSchema,
    valid: z.boolean(),
    diagnostics: z.array(
      diagnosticOutputSchema,
    ).max(1_000),
  })
  .strict();

export const validationToolOutputSchema =
  toolOutputSchema(validationResultOutputSchema);

const safeImageFormatOutputSchema = z.enum([
  "jpeg",
  "png",
  "svg",
  "webp",
]);

const tilesetSheetPixelSizeOutputSchema = z
  .object({
    width: positiveIntegerOutputSchema.max(
      MAX_TILESET_SHEET_EDGE,
    ),
    height: positiveIntegerOutputSchema.max(
      MAX_TILESET_SHEET_EDGE,
    ),
  })
  .strict();

const nativePreviewPixelSizeOutputSchema = z
  .object({
    width: positiveIntegerOutputSchema.max(
      MAX_NATIVE_PREVIEW_EDGE,
    ),
    height: positiveIntegerOutputSchema.max(
      MAX_NATIVE_PREVIEW_EDGE,
    ),
  })
  .strict();

const renderedImageSourceOutputSchema = z
  .object({
    path: projectPathOutputSchema,
    revision: revisionOutputSchema,
    format: safeImageFormatOutputSchema,
    pixelSize: pixelSizeOutputSchema,
  })
  .strict();

const tilesetSheetPageOutputSchema = z
  .object({
    index: nonnegativeIntegerOutputSchema,
    count: positiveIntegerOutputSchema,
    requestedSize: positiveIntegerOutputSchema.max(
      MAX_TILESET_SHEET_PAGE_SIZE,
    ),
    size: positiveIntegerOutputSchema.max(
      MAX_TILESET_SHEET_PAGE_SIZE,
    ),
    adjusted: z.boolean(),
    tileCount: positiveIntegerOutputSchema.max(
      MAX_TILESET_SHEET_PAGE_SIZE,
    ),
    localIdRange: z
      .object({
        first: nonnegativeIntegerOutputSchema,
        last: nonnegativeIntegerOutputSchema,
      })
      .strict(),
    columns: positiveIntegerOutputSchema.max(
      MAX_TILESET_SHEET_COLUMNS,
    ),
    rows: positiveIntegerOutputSchema.max(
      MAX_TILESET_SHEET_PAGE_SIZE,
    ),
  })
  .strict();

const tilesetSheetResultOutputSchema = z
  .object({
    mimeType: z.literal("image/png"),
    pixelSize:
      tilesetSheetPixelSizeOutputSchema,
    byteLength: positiveIntegerOutputSchema.max(
      MAX_TILESET_SHEET_BYTES,
    ),
    sha256: revisionOutputSchema,
    source: z
      .object({
        assetId: assetIdOutputSchema,
        revision: revisionOutputSchema,
      })
      .strict(),
    map: mapSnapshotOutputSchema,
    image: renderedImageSourceOutputSchema,
    tileset: z
      .object({
        path: projectPathOutputSchema,
        name: displayStringOutputSchema,
        nameTruncated:
          truncatedMarkerOutputSchema,
        tileCount: positiveIntegerOutputSchema,
        tileSize: z
          .object({
            width: positiveIntegerOutputSchema,
            height: positiveIntegerOutputSchema,
          })
          .strict(),
        atlas: z
          .object({
            columns:
              positiveIntegerOutputSchema,
            margin:
              nonnegativeIntegerOutputSchema,
            spacing:
              nonnegativeIntegerOutputSchema,
          })
          .strict(),
      })
      .strict(),
    page: tilesetSheetPageOutputSchema,
    scale: positiveIntegerOutputSchema.max(
      MAX_TILESET_SHEET_SCALE,
    ),
    truncated: z.literal(false),
  })
  .strict();

export const tilesetSheetToolOutputSchema =
  toolOutputSchema(
    tilesetSheetResultOutputSchema,
  );

const nativePreviewSourceOutputSchema = z
  .object({
    assetId: assetIdOutputSchema,
    tileset: mapSnapshotOutputSchema,
    image: renderedImageSourceOutputSchema,
  })
  .strict();

const integerPointOutputSchema = z
  .object({
    x: integerOutputSchema,
    y: integerOutputSchema,
  })
  .strict();

const nativeCoordinateTransformOutputSchema = z
  .object({
    tileOrigin: integerPointOutputSchema,
    pixelOrigin: integerPointOutputSchema,
    pixelsPerTile: z
      .object({
        x: positiveIntegerOutputSchema,
        y: positiveIntegerOutputSchema,
      })
      .strict(),
  })
  .strict();

const omittedPreviewLayerOutputSchema = z
  .object({
    id: positiveIntegerOutputSchema,
    name: displayStringOutputSchema,
    type: displayStringOutputSchema,
    reason: z.literal("unsupported-layer-type"),
  })
  .strict();

const nativePreviewResultOutputSchema = z
  .object({
    mimeType: z.literal("image/png"),
    pixelSize:
      nativePreviewPixelSizeOutputSchema,
    byteLength: positiveIntegerOutputSchema.max(
      MAX_NATIVE_PREVIEW_BYTES,
    ),
    sha256: revisionOutputSchema,
    map: mapSnapshotOutputSchema,
    dependencyRevisions:
      dependencyRevisionsOutputSchema,
    sources: z.array(
      nativePreviewSourceOutputSchema,
    ).max(MAX_PREVIEW_ATLASES),
    tileRegion: integerRectOutputSchema,
    coordinateTransform:
      nativeCoordinateTransformOutputSchema,
    contentPixelRect: integerRectOutputSchema,
    layerIds: z.array(
      positiveIntegerOutputSchema,
    ).max(MAX_PREVIEW_LAYERS),
    layerSelection: z.enum([
      "visible",
      "explicit",
    ]),
    omittedLayers: z.array(
      omittedPreviewLayerOutputSchema,
    ).max(MAX_PREVIEW_OMITTED_LAYERS),
    omittedLayerCount:
      nonnegativeIntegerOutputSchema,
    omittedLayersTruncated: z.boolean(),
    partial: z.boolean(),
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    scale: positiveIntegerOutputSchema.max(
      MAX_NATIVE_PREVIEW_SCALE,
    ),
    overlays: z
      .object({
        grid: z.boolean(),
        coordinates: z.boolean(),
      })
      .strict(),
    renderProfile: z.literal(
      "finite-orthogonal-static-atlas-tilelayers-v1",
    ),
    truncated: z.literal(false),
  })
  .strict();

export const nativePreviewToolOutputSchema =
  toolOutputSchema(nativePreviewResultOutputSchema);

const rasterMapResultOutputSchema = z
  .object({
    mapPath: projectPathOutputSchema,
    mimeType: z.literal("image/png"),
    bytes: positiveIntegerOutputSchema.max(
      MAX_NATIVE_PREVIEW_BYTES,
    ),
    width: positiveIntegerOutputSchema.max(
      MAX_NATIVE_PREVIEW_EDGE,
    ),
    height: positiveIntegerOutputSchema.max(
      MAX_NATIVE_PREVIEW_EDGE,
    ),
  })
  .strict();

export const rasterMapToolOutputSchema =
  toolOutputSchema(rasterMapResultOutputSchema);
