import { z } from "zod";

import {
  MAX_NATIVE_PREVIEW_BYTES,
  MAX_NATIVE_PREVIEW_EDGE,
  MAX_NATIVE_PREVIEW_HIGHLIGHTS,
  MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
  MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS_AGGREGATE,
  MAX_NATIVE_PREVIEW_OBJECTS,
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
} from "../images/mapPreview.js";
import {
  DEFAULT_TILE_RENDER_COLUMNS,
  MAX_TILE_RENDER_BYTES,
  MAX_TILE_RENDER_COLUMNS,
  MAX_TILE_RENDER_EDGE,
  MAX_TILE_RENDER_LOCAL_IDS,
  MAX_TILE_RENDER_PIXELS,
  MAX_TILE_RENDER_SCALE,
  MAX_TILESET_SHEET_BYTES,
  MAX_TILESET_SHEET_COLUMNS,
  MAX_TILESET_SHEET_EDGE,
  MAX_TILESET_SHEET_PAGE_SIZE,
  MAX_TILESET_SHEET_SCALE,
} from "../images/tilesetSheet.js";
import {
  MAX_OBJECT_DISPLAY_STRING_LENGTH,
  MAX_OBJECT_SHAPE_POINTS,
  MIN_POLYGON_OBJECT_POINTS,
  MIN_POLYLINE_OBJECT_POINTS,
} from "../maps/mapService.js";
import { MAX_PROPERTIES_PER_TARGET } from "../maps/propertyEdits.js";
import {
  MAX_PREVIEW_ATLASES,
  MAX_PREVIEW_LAYERS,
  MAX_PREVIEW_OMITTED_LAYERS,
  MAX_PREVIEW_REGION_CELLS,
} from "../maps/previewScene.js";
import {
  MAX_TEXT_OBJECT_CONTENT_CODE_POINTS,
  MAX_TEXT_OBJECT_FONT_FAMILY_CODE_POINTS,
  MAX_TEXT_OBJECT_PIXEL_SIZE,
  MIN_TEXT_OBJECT_PIXEL_SIZE,
  TEXT_OBJECT_FIELDS,
  TEXT_OBJECT_HORIZONTAL_ALIGNMENTS,
  TEXT_OBJECT_VERTICAL_ALIGNMENTS,
  measureTextObjectPayloadBytes,
} from "../maps/textObjects.js";
import {
  MAX_RASTER_PNG_BYTES,
  MAX_RASTER_RENDER_EDGE,
  MAX_RENDERER_VERSION_LENGTH,
  RASTER_RENDER_PROFILE,
  RASTER_SNAPSHOT_CONSISTENCY,
} from "../rasterContract.js";
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
  projectedPropertyOutputSchema,
  resolvedTileRefOutputSchema,
  revisionOutputSchema,
  toolOutputSchema,
} from "./common.js";

const tiledColorOutputSchema = z
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
const textObjectContentOutputSchema = z
  .string()
  .max(MAX_TEXT_OBJECT_CONTENT_CODE_POINTS * 2)
  .refine(
    (value) =>
      isValidTextObjectField("text", value),
  );
const textObjectFontFamilyOutputSchema = z
  .string()
  .min(1)
  .max(MAX_TEXT_OBJECT_FONT_FAMILY_CODE_POINTS * 2)
  .refine(
    (value) =>
      isValidTextObjectField("fontFamily", value),
  );
const textObjectPixelSizeOutputSchema = z
  .number()
  .int()
  .min(MIN_TEXT_OBJECT_PIXEL_SIZE)
  .max(MAX_TEXT_OBJECT_PIXEL_SIZE);
const textObjectHorizontalAlignmentOutputSchema =
  z.enum(TEXT_OBJECT_HORIZONTAL_ALIGNMENTS);
const textObjectVerticalAlignmentOutputSchema =
  z.enum(TEXT_OBJECT_VERTICAL_ALIGNMENTS);

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

const checkpointManifestBaseOutputShape = {
  id: checkpointIdOutputSchema,
  createdAt:
    checkpointTimestampOutputSchema,
  label: z.string(),
  path: projectPathOutputSchema,
  status: z.enum(["prepared", "committed"]),
  before: checkpointBeforeOutputSchema,
  afterRevision: revisionOutputSchema,
} as const;

const checkpointManifestOutputSchema =
  z.discriminatedUnion("version", [
    z
      .object({
        version: z.literal(1),
        ...checkpointManifestBaseOutputShape,
      })
      .strict(),
    z
      .object({
        version: z.literal(2),
        ...checkpointManifestBaseOutputShape,
        retention: z.discriminatedUnion(
          "class",
          [
            z
              .object({
                class: z.literal(
                  "protected",
                ),
              })
              .strict(),
            z
              .object({
                class: z.literal("rolling"),
                ordinal:
                  positiveIntegerOutputSchema.max(
                    Number.MAX_SAFE_INTEGER,
                  ),
              })
              .strict(),
          ],
        ),
      })
      .strict(),
  ]);

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

const worldMapMemberOutputSchema = z
  .object({
    source: z.string().min(1).max(4_096),
    exists: z.boolean(),
    path: projectPathOutputSchema.optional(),
    revision: revisionOutputSchema.optional(),
    x: integerOutputSchema
      .min(-1_000_000_000)
      .max(1_000_000_000),
    y: integerOutputSchema
      .min(-1_000_000_000)
      .max(1_000_000_000),
    declaredSize: z
      .object({
        width: positiveIntegerOutputSchema,
        height: positiveIntegerOutputSchema,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((member, context) => {
    if (
      member.exists !==
      (member.path !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message:
          "A world member resolves a project path exactly when it exists",
      });
    }
    if (
      member.exists !==
      (member.revision !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message:
          "A world member pins a revision exactly when it exists",
      });
    }
  });

const worldListResultOutputSchema = z
  .object({
    path: projectPathOutputSchema,
    revision: revisionOutputSchema,
    onlyShowAdjacentMaps: z.boolean(),
    members: z
      .array(worldMapMemberOutputSchema)
      .max(1_000),
    memberCount:
      nonnegativeIntegerOutputSchema.max(1_000),
    patternCount:
      nonnegativeIntegerOutputSchema,
    patternsUnexpanded: z.boolean(),
    properties: z
      .array(projectedPropertyOutputSchema)
      .max(128),
    propertyCount:
      nonnegativeIntegerOutputSchema,
    propertiesTruncated: z
      .literal(true)
      .optional(),
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
  })
  .strict();

export const worldListToolOutputSchema =
  toolOutputSchema(worldListResultOutputSchema);

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
          width: nonnegativeIntegerOutputSchema,
          height: nonnegativeIntegerOutputSchema,
          x: integerOutputSchema,
          y: integerOutputSchema,
          startX: integerOutputSchema.optional(),
          startY: integerOutputSchema.optional(),
          chunked: z.literal(true).optional(),
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
    collection: z.literal(true).optional(),
  })
  .strict();

const mapSummaryResultOutputSchema = z
  .object({
    path: projectPathOutputSchema,
    revision: revisionOutputSchema,
    format: z.literal("tmj"),
    orientation: z.literal("orthogonal"),
    infinite: z.boolean(),
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
    embeddedTilesets: z
      .array(
        z
          .object({
            kind: z.literal("embedded"),
            sourceIndex:
              nonnegativeIntegerOutputSchema,
            name: z.string(),
            nameTruncated: z
              .literal(true)
              .optional(),
            firstGid:
              positiveIntegerOutputSchema,
            tileCount:
              positiveIntegerOutputSchema,
            gidSpan:
              positiveIntegerOutputSchema,
            lastPotentialGid:
              positiveIntegerOutputSchema,
          })
          .strict(),
      )
      .max(4_096),
    dependencyRevisions:
      dependencyRevisionsOutputSchema,
    editableProfile: z.enum([
      "finite-orthogonal-tmj-external-atlas-tsj",
      "infinite-orthogonal-tmj-read-only-chunked",
    ]),
  })
  .strict();

interface TmxLayerSummaryShape {
  id: number;
  name: string;
  type:
    | "tilelayer"
    | "objectgroup"
    | "imagelayer"
    | "group";
  visible: boolean;
  opacity: number;
  width?: number | undefined;
  height?: number | undefined;
  encoding?: string | undefined;
  compression?: string | undefined;
  chunked?: boolean | undefined;
  objectCount?: number | undefined;
  layers?: TmxLayerSummaryShape[] | undefined;
}

const tmxLayerSummaryOutputSchema: z.ZodType<TmxLayerSummaryShape> =
  z.lazy(() =>
    z
      .object({
        id: nonnegativeIntegerOutputSchema,
        name: z.string(),
        type: z.enum([
          "tilelayer",
          "objectgroup",
          "imagelayer",
          "group",
        ]),
        visible: z.boolean(),
        opacity: z.number(),
        width:
          nonnegativeIntegerOutputSchema.optional(),
        height:
          nonnegativeIntegerOutputSchema.optional(),
        encoding: z.string().optional(),
        compression: z.string().optional(),
        chunked: z.boolean().optional(),
        objectCount:
          nonnegativeIntegerOutputSchema.optional(),
        layers: z
          .array(tmxLayerSummaryOutputSchema)
          .optional(),
      })
      .strict(),
  );

const tmxSummaryResultOutputSchema = z
  .object({
    path: projectPathOutputSchema,
    revision: revisionOutputSchema,
    format: z.literal("tmx"),
    profile: z.literal(
      "tmx-read-only-summary-v1",
    ),
    orientation: z.string().min(1),
    infinite: z.boolean(),
    renderOrder: z.string().min(1),
    backgroundColor: z.string().optional(),
    className: z.string().optional(),
    width: integerOutputSchema,
    height: integerOutputSchema,
    tileWidth: integerOutputSchema,
    tileHeight: integerOutputSchema,
    layers: z
      .array(tmxLayerSummaryOutputSchema)
      .max(10_000),
    tilesets: z
      .array(
        z.union([
          z
            .object({
              firstGid:
                positiveIntegerOutputSchema,
              source: z.string().min(1),
              path: projectPathOutputSchema.optional(),
              revision:
                revisionOutputSchema.optional(),
              exists: z.boolean(),
            })
            .strict(),
          z
            .object({
              firstGid:
                positiveIntegerOutputSchema,
              embedded: z.literal(true),
              name: z.string().optional(),
              tileCount:
                nonnegativeIntegerOutputSchema.optional(),
            })
            .strict(),
        ]),
      )
      .max(4_096),
    editable: z.literal(false),
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
  })
  .strict();

export const mapSummaryToolOutputSchema =
  toolOutputSchema(
    z.union([
      mapSummaryResultOutputSchema,
      tmxSummaryResultOutputSchema,
    ]),
  );

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

const objectDetailsDisplayStringOutputSchema =
  displayStringOutputSchema
    .max(MAX_OBJECT_DISPLAY_STRING_LENGTH * 2)
    .refine(
      (value) =>
        Array.from(value).length <=
        MAX_OBJECT_DISPLAY_STRING_LENGTH,
    );
const objectDetailsCommonOutputShape = {
  id: positiveIntegerOutputSchema.max(
    Number.MAX_SAFE_INTEGER,
  ),
  layerId: positiveIntegerOutputSchema.max(
    Number.MAX_SAFE_INTEGER,
  ),
  layerName:
    objectDetailsDisplayStringOutputSchema,
  layerNameTruncated:
    truncatedMarkerOutputSchema,
  name: objectDetailsDisplayStringOutputSchema,
  nameTruncated: truncatedMarkerOutputSchema,
  className:
    objectDetailsDisplayStringOutputSchema,
  classNameTruncated:
    truncatedMarkerOutputSchema,
  x: z.number().min(-1_000_000_000).max(
    1_000_000_000,
  ),
  y: z.number().min(-1_000_000_000).max(
    1_000_000_000,
  ),
  rotation: z.number().min(-1_000_000_000).max(
    1_000_000_000,
  ),
  visible: z.boolean(),
  opacity: z.number().min(0).max(1),
  properties: z
    .array(projectedPropertyOutputSchema)
    .max(MAX_PROPERTIES_PER_TARGET),
  propertyCount: nonnegativeIntegerOutputSchema,
  propertiesTruncated:
    truncatedMarkerOutputSchema,
} as const;

const objectDetailsExtentOutputSchema = z
  .number()
  .min(0)
  .max(1_000_000_000);
const objectDetailsPointOutputSchema = z
  .object({
    ...objectDetailsCommonOutputShape,
    shape: z.literal("point"),
  })
  .strict();
const objectDetailsRectangleOutputSchema = z
  .object({
    ...objectDetailsCommonOutputShape,
    shape: z.literal("rectangle"),
    width: objectDetailsExtentOutputSchema,
    height: objectDetailsExtentOutputSchema,
  })
  .strict();
const objectDetailsEllipseOutputSchema = z
  .object({
    ...objectDetailsCommonOutputShape,
    shape: z.literal("ellipse"),
    width: objectDetailsExtentOutputSchema,
    height: objectDetailsExtentOutputSchema,
  })
  .strict();
const objectDetailsCapsuleOutputSchema = z
  .object({
    ...objectDetailsCommonOutputShape,
    shape: z.literal("capsule"),
    width: objectDetailsExtentOutputSchema,
    height: objectDetailsExtentOutputSchema,
  })
  .strict();
const objectDetailsPathPointOutputSchema = z
  .object({
    x: z.number().min(-1_000_000_000).max(
      1_000_000_000,
    ),
    y: z.number().min(-1_000_000_000).max(
      1_000_000_000,
    ),
  })
  .strict();
const objectDetailsPolygonOutputSchema = z
  .object({
    ...objectDetailsCommonOutputShape,
    shape: z.literal("polygon"),
    points: z
      .array(objectDetailsPathPointOutputSchema)
      .min(MIN_POLYGON_OBJECT_POINTS)
      .max(MAX_OBJECT_SHAPE_POINTS),
  })
  .strict();
const objectDetailsPolylineOutputSchema = z
  .object({
    ...objectDetailsCommonOutputShape,
    shape: z.literal("polyline"),
    points: z
      .array(objectDetailsPathPointOutputSchema)
      .min(MIN_POLYLINE_OBJECT_POINTS)
      .max(MAX_OBJECT_SHAPE_POINTS),
  })
  .strict();
const objectDetailsTextOutputSchema = z
  .object({
    ...objectDetailsCommonOutputShape,
    shape: z.literal("text"),
    width: objectDetailsExtentOutputSchema,
    height: objectDetailsExtentOutputSchema,
    text: textObjectContentOutputSchema,
    fontFamily:
      textObjectFontFamilyOutputSchema,
    pixelSize:
      textObjectPixelSizeOutputSchema,
    wrap: z.boolean(),
    color: tiledColorOutputSchema,
    bold: z.boolean(),
    italic: z.boolean(),
    underline: z.boolean(),
    strikeout: z.boolean(),
    kerning: z.boolean(),
    horizontalAlignment:
      textObjectHorizontalAlignmentOutputSchema,
    verticalAlignment:
      textObjectVerticalAlignmentOutputSchema,
  })
  .strict();
const objectDetailsTileOutputSchema = z
  .object({
    ...objectDetailsCommonOutputShape,
    shape: z.literal("tile"),
    width: objectDetailsExtentOutputSchema,
    height: objectDetailsExtentOutputSchema,
    tile: resolvedTileRefOutputSchema,
  })
  .strict();
const objectDetailsResultOutputSchema = z
  .object({
    mapPath: projectPathOutputSchema,
    revision: revisionOutputSchema,
    dependencyRevisions:
      dependencyRevisionsOutputSchema,
    object: z.discriminatedUnion("shape", [
      objectDetailsRectangleOutputSchema,
      objectDetailsPointOutputSchema,
      objectDetailsEllipseOutputSchema,
      objectDetailsCapsuleOutputSchema,
      objectDetailsPolygonOutputSchema,
      objectDetailsPolylineOutputSchema,
      objectDetailsTextOutputSchema,
      objectDetailsTileOutputSchema,
    ]),
    template: z
      .object({
        path: projectPathOutputSchema,
        revision: revisionOutputSchema,
        mergeProfile: z.literal(
          "tiled-sync-with-template-v1",
        ),
        propertiesSource: z.literal(
          "instance-only",
        ),
      })
      .strict()
      .optional(),
  })
  .strict();

export const objectDetailsToolOutputSchema =
  toolOutputSchema(objectDetailsResultOutputSchema);

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

const collectionSheetPageOutputSchema = z
  .object({
    index: nonnegativeIntegerOutputSchema,
    count: positiveIntegerOutputSchema,
    requestedSize: positiveIntegerOutputSchema.max(
      MAX_TILE_RENDER_LOCAL_IDS,
    ),
    size: positiveIntegerOutputSchema.max(
      MAX_TILE_RENDER_LOCAL_IDS,
    ),
    tileCount: positiveIntegerOutputSchema.max(
      MAX_TILE_RENDER_LOCAL_IDS,
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
      MAX_TILE_RENDER_LOCAL_IDS,
    ),
  })
  .strict();

const collectionSheetResultOutputSchema = z
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
    images: z
      .array(
        renderedImageSourceOutputSchema.extend({
          localId:
            nonnegativeIntegerOutputSchema,
        }),
      )
      .min(1)
      .max(MAX_TILE_RENDER_LOCAL_IDS),
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
        collection: z
          .object({
            sparseLocalIds: z.literal(true),
            maxLocalId:
              nonnegativeIntegerOutputSchema,
            tileSizeSemantics: z.literal(
              "maximum-tile-image-size",
            ),
          })
          .strict(),
      })
      .strict(),
    page: collectionSheetPageOutputSchema,
    scale: positiveIntegerOutputSchema.max(
      MAX_TILESET_SHEET_SCALE,
    ),
    truncated: z.literal(false),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.images.length !== result.page.size
    ) {
      context.addIssue({
        code: "custom",
        path: ["images"],
        message:
          "Every collection sheet page tile must report exactly one rendered image source",
      });
    }
  });

export const tilesetSheetToolOutputSchema =
  toolOutputSchema(
    z.union([
      tilesetSheetResultOutputSchema,
      collectionSheetResultOutputSchema,
    ]),
  );

const tileRenderSelectionOutputSchema = z
  .object({
    localIds: z
      .array(
        nonnegativeIntegerOutputSchema.max(
          0x0fffffff,
        ),
      )
      .min(1)
      .max(MAX_TILE_RENDER_LOCAL_IDS)
      .meta({ uniqueItems: true }),
    count: positiveIntegerOutputSchema.max(
      MAX_TILE_RENDER_LOCAL_IDS,
    ),
    order: z.literal("input"),
    labels: z.literal("local-id"),
    layout: z
      .object({
        kind: z.literal("row-major"),
        requestedColumns:
          positiveIntegerOutputSchema.max(
            MAX_TILE_RENDER_COLUMNS,
          ),
        columns:
          positiveIntegerOutputSchema.max(
            MAX_TILE_RENDER_COLUMNS,
          ),
        rows: positiveIntegerOutputSchema.max(
          MAX_TILE_RENDER_LOCAL_IDS,
        ),
        adjusted: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .describe(
    `Runtime-enforced cross-field invariants: count equals localIds.length; layout.rows equals ceil(count / layout.columns); layout.adjusted exactly reports an automatic reduction from the omitted-input default of ${DEFAULT_TILE_RENDER_COLUMNS} columns, and adjusted=true requires requestedColumns=${DEFAULT_TILE_RENDER_COLUMNS}.`,
  )
  .superRefine((selection, context) => {
    const seen = new Set<number>();
    for (const [
      index,
      localId,
    ] of selection.localIds.entries()) {
      if (seen.has(localId)) {
        context.addIssue({
          code: "custom",
          message:
            "Rendered local tile IDs must be unique",
          path: ["localIds", index],
        });
      }
      seen.add(localId);
    }
    if (
      selection.count !==
      selection.localIds.length
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Rendered tile count must equal localIds length",
        path: ["count"],
      });
    }
    const maximumEffectiveColumns = Math.min(
      selection.layout.requestedColumns,
      selection.count,
    );
    if (
      selection.layout.columns >
      maximumEffectiveColumns
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Rendered tile columns must not exceed the requested columns or selection count",
        path: ["layout", "columns"],
      });
    }
    const expectedRows = Math.ceil(
      selection.count /
        selection.layout.columns,
    );
    if (selection.layout.rows !== expectedRows) {
      context.addIssue({
        code: "custom",
        message:
          "Rendered tile rows must match the row-major selection layout",
        path: ["layout", "rows"],
      });
    }
    const expectedAdjusted =
      selection.layout.columns <
      maximumEffectiveColumns;
    if (
      selection.layout.adjusted !==
      expectedAdjusted
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Rendered tile layout adjusted flag must exactly report a reduced column count",
        path: ["layout", "adjusted"],
      });
    }
    if (
      selection.layout.adjusted &&
      selection.layout.requestedColumns !==
        DEFAULT_TILE_RENDER_COLUMNS
    ) {
      context.addIssue({
        code: "custom",
        message:
          "An adjusted tile layout must report the omitted-input default requested column count",
        path: ["layout", "requestedColumns"],
      });
    }
  });

const tileRenderResultOutputSchema = z
  .object({
    mimeType: z.literal("image/png"),
    pixelSize: z
      .object({
        width:
          positiveIntegerOutputSchema.max(
            MAX_TILE_RENDER_EDGE,
          ),
        height:
          positiveIntegerOutputSchema.max(
            MAX_TILE_RENDER_EDGE,
          ),
      })
      .strict()
      .describe(
        `Rendered PNG dimensions. Runtime enforces width * height <= ${MAX_TILE_RENDER_PIXELS}; this multiplicative invariant is not expressible in the published Draft-07 schema.`,
      )
      .refine(
        ({ width, height }) =>
          width * height <=
          MAX_TILE_RENDER_PIXELS,
        {
          message:
            "Rendered tile selection exceeds the output pixel budget",
        },
      ),
    byteLength: positiveIntegerOutputSchema.max(
      MAX_TILE_RENDER_BYTES,
    ),
    sha256: revisionOutputSchema,
    map: mapSnapshotOutputSchema,
    source: z
      .object({
        assetId: assetIdOutputSchema,
        revision: revisionOutputSchema,
      })
      .strict(),
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
            width:
              positiveIntegerOutputSchema,
            height:
              positiveIntegerOutputSchema,
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
    renderProfile: z.literal(
      "explicit-local-id-atlas-selection-v1",
    ),
    selection:
      tileRenderSelectionOutputSchema,
    scale: positiveIntegerOutputSchema.max(
      MAX_TILE_RENDER_SCALE,
    ),
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    truncated: z.literal(false),
  })
  .strict()
  .describe(
    "Runtime enforces every selection.localIds entry is less than tileset.tileCount; this dynamic cross-field invariant is not expressible in the published Draft-07 schema.",
  )
  .superRefine((result, context) => {
    for (const [
      index,
      localId,
    ] of result.selection.localIds.entries()) {
      if (localId >= result.tileset.tileCount) {
        context.addIssue({
          code: "custom",
          message:
            "Rendered local tile ID must be inside the tileset tileCount",
          path: [
            "selection",
            "localIds",
            index,
          ],
        });
      }
    }
  });

const collectionTileRenderResultOutputSchema = z
  .object({
    mimeType: z.literal("image/png"),
    pixelSize: z
      .object({
        width: positiveIntegerOutputSchema.max(
          MAX_TILE_RENDER_EDGE,
        ),
        height: positiveIntegerOutputSchema.max(
          MAX_TILE_RENDER_EDGE,
        ),
      })
      .strict()
      .refine(
        ({ width, height }) =>
          width * height <=
          MAX_TILE_RENDER_PIXELS,
        {
          message:
            "Rendered tile selection exceeds the output pixel budget",
        },
      ),
    byteLength: positiveIntegerOutputSchema.max(
      MAX_TILE_RENDER_BYTES,
    ),
    sha256: revisionOutputSchema,
    map: mapSnapshotOutputSchema,
    source: z
      .object({
        assetId: assetIdOutputSchema,
        revision: revisionOutputSchema,
      })
      .strict(),
    images: z
      .array(
        renderedImageSourceOutputSchema.extend({
          localId:
            nonnegativeIntegerOutputSchema,
        }),
      )
      .min(1)
      .max(MAX_TILE_RENDER_LOCAL_IDS),
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
        collection: z
          .object({
            sparseLocalIds: z.literal(true),
            maxLocalId:
              nonnegativeIntegerOutputSchema,
            tileSizeSemantics: z.literal(
              "maximum-tile-image-size",
            ),
          })
          .strict(),
      })
      .strict(),
    renderProfile: z.literal(
      "explicit-local-id-collection-selection-v1",
    ),
    selection:
      tileRenderSelectionOutputSchema,
    scale: positiveIntegerOutputSchema.max(
      MAX_TILE_RENDER_SCALE,
    ),
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    truncated: z.literal(false),
  })
  .strict()
  .superRefine((result, context) => {
    for (const [
      index,
      localId,
    ] of result.selection.localIds.entries()) {
      if (
        localId >
        result.tileset.collection.maxLocalId
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Rendered sparse local tile ID must not exceed the collection maxLocalId",
          path: [
            "selection",
            "localIds",
            index,
          ],
        });
      }
      if (
        result.images[index]?.localId !==
        localId
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Rendered collection image entries must mirror the selection order",
          path: ["images", index],
        });
      }
    }
    if (
      result.images.length !==
      result.selection.localIds.length
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Every selected collection tile must report exactly one rendered image source",
        path: ["images"],
      });
    }
  });

export const tileRenderToolOutputSchema =
  toolOutputSchema(
    z.union([
      tileRenderResultOutputSchema,
      collectionTileRenderResultOutputSchema,
    ]),
  );

const nativePreviewSourceOutputSchema = z.union([
  z
    .object({
      assetId: assetIdOutputSchema,
      tileset: mapSnapshotOutputSchema,
      image: renderedImageSourceOutputSchema,
    })
    .strict(),
  z
    .object({
      embedded: z
        .object({
          sourceIndex:
            nonnegativeIntegerOutputSchema,
        })
        .strict(),
      /** The map itself: embedded content is pinned by the map revision. */
      tileset: mapSnapshotOutputSchema,
      image: renderedImageSourceOutputSchema,
    })
    .strict(),
]);

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

const positiveNativePreviewTileRectOutputSchema =
  z
    .object({
      x: nonnegativeIntegerOutputSchema.max(
        Number.MAX_SAFE_INTEGER,
      ),
      y: nonnegativeIntegerOutputSchema.max(
        Number.MAX_SAFE_INTEGER,
      ),
      width: positiveIntegerOutputSchema.max(
        Number.MAX_SAFE_INTEGER,
      ),
      height: positiveIntegerOutputSchema.max(
        Number.MAX_SAFE_INTEGER,
      ),
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

const nativePreviewObjectDebugEntryOutputSchema = z
  .object({
    sourceIndex:
      nonnegativeIntegerOutputSchema.max(
        MAX_NATIVE_PREVIEW_OBJECTS - 1,
      ),
    objectId: positiveIntegerOutputSchema.max(
      Number.MAX_SAFE_INTEGER,
    ),
    layerId: positiveIntegerOutputSchema.max(
      Number.MAX_SAFE_INTEGER,
    ),
    shape: z.enum([
      "rectangle",
      "point",
      "ellipse",
      "capsule",
      "polygon",
      "polyline",
      "text",
      "tile",
    ]),
    representation: z.enum([
      "geometry-outline",
      "text-box-only",
      "tile-frame-only",
      "tile-frame-and-collision",
    ]),
    rendered: z.boolean(),
    clipped: z.boolean(),
    collisionObjectCount:
      nonnegativeIntegerOutputSchema
        .max(
          MAX_NATIVE_PREVIEW_TILE_COLLISION_SHAPES,
        )
        .optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      (entry.collisionObjectCount !== undefined) !==
      (entry.representation ===
        "tile-frame-and-collision")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "collisionObjectCount must be present exactly for tile-frame-and-collision entries",
        path: ["collisionObjectCount"],
      });
    }
  });

const nativePreviewObjectDebugOutputSchema = z
  .object({
    profile: z.literal(
      NATIVE_PREVIEW_OBJECT_PROFILE,
    ),
    style: z.literal(
      NATIVE_PREVIEW_OBJECT_STYLE,
    ),
    color: z
      .object({
        r: z.literal(
          NATIVE_PREVIEW_OBJECT_COLOR.r,
        ),
        g: z.literal(
          NATIVE_PREVIEW_OBJECT_COLOR.g,
        ),
        b: z.literal(
          NATIVE_PREVIEW_OBJECT_COLOR.b,
        ),
        a: z.literal(
          NATIVE_PREVIEW_OBJECT_COLOR.a,
        ),
      })
      .strict(),
    strokeWidth: z.literal(
      NATIVE_PREVIEW_OBJECT_STROKE_WIDTH,
    ),
    originMarker: z.literal(
      NATIVE_PREVIEW_OBJECT_ORIGIN_MARKER,
    ),
    idLabels: z.literal(false),
    visibilityPolicy: z.literal(
      NATIVE_PREVIEW_OBJECT_VISIBILITY_POLICY,
    ),
    drawOrder: z.literal(
      NATIVE_PREVIEW_OBJECT_DRAW_ORDER,
    ),
    quantization: z.literal(
      NATIVE_PREVIEW_OBJECT_QUANTIZATION,
    ),
    curveTessellation: z
      .object({
        algorithm: z.literal(
          NATIVE_PREVIEW_OBJECT_CURVE_TESSELLATION,
        ),
        maximumChordErrorPixels: z.literal(
          NATIVE_PREVIEW_OBJECT_CURVE_MAX_ERROR_PIXELS,
        ),
        minimumSegments: z.literal(
          MIN_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
        ),
        maximumSegmentsPerObject: z.literal(
          MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
        ),
        maximumAggregateSegments: z.literal(
          MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS_AGGREGATE,
        ),
        segmentMultiple: z.literal(4),
        errorSpace: z.literal(
          "continuous-output-before-quantization",
        ),
        overflowPolicy: z.literal(
          "reject-whole-preview",
        ),
        offscreenPolicy: z.literal(
          "conservative-rotated-bounds-skip-before-tessellation",
        ),
        capsuleConstruction: z.literal(
          "two-semicircles-plus-two-straight-segments",
        ),
        degenerateExtent: z.literal(
          "tiled-1.12-single-zero-line-double-zero-anchor-centered-20-map-pixel-circle",
        ),
      })
      .strict(),
    tileObjectFrames: z
      .object({
        source: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_FRAMES.source,
        ),
        alignmentResolution: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_FRAMES.alignmentResolution,
        ),
        tileOffsetScaling: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_FRAMES.tileOffsetScaling,
        ),
        missingDimensionDefault: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_FRAMES.missingDimensionDefault,
        ),
        flipFlags: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_FRAMES.flipFlags,
        ),
        rotationCenter: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_FRAMES.rotationCenter,
        ),
        danglingGidPolicy: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_FRAMES.danglingGidPolicy,
        ),
        imageRendering: z.literal(false),
        collisionShapes: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_FRAMES.collisionShapes,
        ),
      })
      .strict(),
    tileObjectCollision: z
      .object({
        source: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_COLLISION.source,
        ),
        selection: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_COLLISION.selection,
        ),
        transform: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_COLLISION.transform,
        ),
        flipFlags: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_COLLISION.flipFlags,
        ),
        groupMetadata: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_COLLISION.groupMetadata,
        ),
        hiddenCollisionObjects: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_COLLISION.hiddenCollisionObjects,
        ),
        markerPrecedence: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_COLLISION.markerPrecedence,
        ),
        pointObjects: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_COLLISION.pointObjects,
        ),
        curveSegmentPlanning: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_COLLISION.curveSegmentPlanning,
        ),
        offscreenPolicy: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_COLLISION.offscreenPolicy,
        ),
        nestedTileOrTemplateObjects: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_COLLISION.nestedTileOrTemplateObjects,
        ),
        fillMode: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_COLLISION.fillMode,
        ),
        styling: z.literal(
          NATIVE_PREVIEW_TILE_OBJECT_COLLISION.styling,
        ),
      })
      .strict(),
    selectedObjectCount:
      nonnegativeIntegerOutputSchema.max(
        MAX_NATIVE_PREVIEW_OBJECTS,
      ),
    renderedObjectCount:
      nonnegativeIntegerOutputSchema.max(
        MAX_NATIVE_PREVIEW_OBJECTS,
      ),
    entries: z
      .array(
        nativePreviewObjectDebugEntryOutputSchema,
      )
      .max(MAX_NATIVE_PREVIEW_OBJECTS),
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
        highlights: z
          .object({
            style: z.literal(
              NATIVE_PREVIEW_HIGHLIGHT_STYLE,
            ),
            entries: z
              .array(
                z
                  .object({
                    sourceIndex:
                      nonnegativeIntegerOutputSchema.max(
                        MAX_NATIVE_PREVIEW_HIGHLIGHTS -
                          1,
                      ),
                    requestedTileRect:
                      positiveNativePreviewTileRectOutputSchema,
                    renderedTileRect:
                      positiveNativePreviewTileRectOutputSchema,
                    clipped: z.boolean(),
                  })
                  .strict(),
              )
              .max(
                MAX_NATIVE_PREVIEW_HIGHLIGHTS,
              ),
            highlightedTileCount:
              nonnegativeIntegerOutputSchema.max(
                MAX_PREVIEW_REGION_CELLS,
              ),
            color: z
              .object({
                r: z.literal(
                  NATIVE_PREVIEW_HIGHLIGHT_COLOR.r,
                ),
                g: z.literal(
                  NATIVE_PREVIEW_HIGHLIGHT_COLOR.g,
                ),
                b: z.literal(
                  NATIVE_PREVIEW_HIGHLIGHT_COLOR.b,
                ),
                a: z.literal(
                  NATIVE_PREVIEW_HIGHLIGHT_COLOR.a,
                ),
              })
              .strict(),
            blendMode: z.literal(
              NATIVE_PREVIEW_HIGHLIGHT_BLEND_MODE,
            ),
            overlapMode: z.literal(
              NATIVE_PREVIEW_HIGHLIGHT_OVERLAP_MODE,
            ),
          })
          .strict(),
        objectDebug:
          nativePreviewObjectDebugOutputSchema,
      })
      .strict(),
    objectLayers: z
      .array(
        z
          .object({
            id: positiveIntegerOutputSchema,
            name: z.string(),
            drawOrder: z.enum([
              "topdown",
              "index",
            ]),
            color: tiledColorOutputSchema.optional(),
            objectCount:
              nonnegativeIntegerOutputSchema,
            renderedObjectCount:
              nonnegativeIntegerOutputSchema,
            tileObjectCount:
              nonnegativeIntegerOutputSchema,
            omittedTemplateObjectCount:
              nonnegativeIntegerOutputSchema,
            hiddenObjectCount:
              nonnegativeIntegerOutputSchema,
            textBoxCount:
              nonnegativeIntegerOutputSchema,
          })
          .strict(),
      )
      .max(128),
    objectLayerRendering: z
      .object({
        profile: z.literal(
          "base-object-layers-v1",
        ),
        colors: z.literal(
          "group-color-else-gray-class-colors-unsupported",
        ),
        fillAlpha: z.literal(50),
        shadow: z.literal(
          "one-pixel-black-offset",
        ),
        stroke: z.literal(
          "one-pixel-cosmetic",
        ),
        text: z.literal("layout-box-only"),
        tileObjects: z.literal(
          "affine-nearest-neighbor-images",
        ),
        templates: z.literal(
          "omitted-counted",
        ),
        pointMarker: z.literal(
          "tiled-pin-cosmetic-radius-10",
        ),
        drawOrder: z.literal(
          "tiled-topdown-stable-or-index",
        ),
        opacity: z.literal(
          "layer-times-object-source-over",
        ),
      })
      .strict(),
    renderProfile: z.enum([
      "finite-orthogonal-static-atlas-tilelayers-v1",
      "infinite-orthogonal-static-atlas-chunked-tilelayers-v1",
    ]),
    truncated: z.literal(false),
  })
  .strict()
  .superRefine((result, context) => {
    const infiniteProfile =
      result.renderProfile ===
      "infinite-orthogonal-static-atlas-chunked-tilelayers-v1";
    const region = result.tileRegion;
    const regionRight = region.x + region.width;
    const regionBottom = region.y + region.height;
    const regionCells =
      region.width * region.height;
    if (
      (!infiniteProfile &&
        (region.x < 0 || region.y < 0)) ||
      Math.abs(region.x) > 1_000_000_000 ||
      Math.abs(region.y) > 1_000_000_000 ||
      region.width <= 0 ||
      region.height <= 0 ||
      !Number.isSafeInteger(regionRight) ||
      !Number.isSafeInteger(regionBottom) ||
      !Number.isSafeInteger(regionCells) ||
      regionCells > MAX_PREVIEW_REGION_CELLS
    ) {
      context.addIssue({
        code: "custom",
        message:
          "tileRegion must be a positive, safe, bounded tile rectangle",
        path: ["tileRegion"],
      });
      return;
    }

    const highlightedTiles =
      new Uint8Array(regionCells);
    const entries =
      result.overlays.highlights.entries;
    for (const [index, entry] of entries.entries()) {
      const entryPath = [
        "overlays",
        "highlights",
        "entries",
        index,
      ] as const;
      if (entry.sourceIndex !== index) {
        context.addIssue({
          code: "custom",
          message:
            "Highlight sourceIndex must equal its ordered entry index",
          path: [...entryPath, "sourceIndex"],
        });
      }

      const requested = entry.requestedTileRect;
      const requestedRight =
        requested.x + requested.width;
      const requestedBottom =
        requested.y + requested.height;
      const expectedRendered = {
        x: Math.max(requested.x, region.x),
        y: Math.max(requested.y, region.y),
        width:
          Math.min(requestedRight, regionRight) -
          Math.max(requested.x, region.x),
        height:
          Math.min(requestedBottom, regionBottom) -
          Math.max(requested.y, region.y),
      };
      if (
        expectedRendered.width <= 0 ||
        expectedRendered.height <= 0
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Each highlight entry must intersect tileRegion",
          path: [...entryPath, "requestedTileRect"],
        });
        continue;
      }

      const rendered = entry.renderedTileRect;
      const renderedMatchesIntersection =
        rendered.x === expectedRendered.x &&
        rendered.y === expectedRendered.y &&
        rendered.width ===
          expectedRendered.width &&
        rendered.height ===
          expectedRendered.height;
      if (!renderedMatchesIntersection) {
        context.addIssue({
          code: "custom",
          message:
            "renderedTileRect must equal the exact half-open intersection of requestedTileRect and tileRegion",
          path: [...entryPath, "renderedTileRect"],
        });
      }

      const expectedClipped =
        requested.x !== rendered.x ||
        requested.y !== rendered.y ||
        requested.width !== rendered.width ||
        requested.height !== rendered.height;
      if (entry.clipped !== expectedClipped) {
        context.addIssue({
          code: "custom",
          message:
            "clipped must exactly report whether requestedTileRect differs from renderedTileRect",
          path: [...entryPath, "clipped"],
        });
      }

      const renderedRight =
        rendered.x + rendered.width;
      const renderedBottom =
        rendered.y + rendered.height;
      if (
        rendered.x < region.x ||
        rendered.y < region.y ||
        renderedRight > regionRight ||
        renderedBottom > regionBottom
      ) {
        continue;
      }
      for (
        let y = rendered.y;
        y < renderedBottom;
        y += 1
      ) {
        const rowOffset =
          (y - region.y) * region.width;
        for (
          let x = rendered.x;
          x < renderedRight;
          x += 1
        ) {
          highlightedTiles[
            rowOffset + x - region.x
          ] = 1;
        }
      }
    }

    let highlightedTileCount = 0;
    for (const highlighted of highlightedTiles) {
      highlightedTileCount += highlighted;
    }
    if (
      result.overlays.highlights
        .highlightedTileCount !==
      highlightedTileCount
    ) {
      context.addIssue({
        code: "custom",
        message:
          "highlightedTileCount must equal the tile union of rendered highlight entries",
        path: [
          "overlays",
          "highlights",
          "highlightedTileCount",
        ],
      });
    }

    const objectDebug =
      result.overlays.objectDebug;
    if (
      objectDebug.selectedObjectCount !==
      objectDebug.entries.length
    ) {
      context.addIssue({
        code: "custom",
        message:
          "selectedObjectCount must equal object debug entries length",
        path: [
          "overlays",
          "objectDebug",
          "selectedObjectCount",
        ],
      });
    }

    let renderedObjectCount = 0;
    const objectIds = new Set<number>();
    for (
      const [index, entry] of
        objectDebug.entries.entries()
    ) {
      const entryPath = [
        "overlays",
        "objectDebug",
        "entries",
        index,
      ] as const;
      if (entry.sourceIndex !== index) {
        context.addIssue({
          code: "custom",
          message:
            "Object debug sourceIndex must equal its ordered entry index",
          path: [...entryPath, "sourceIndex"],
        });
      }
      if (objectIds.has(entry.objectId)) {
        context.addIssue({
          code: "custom",
          message:
            "Object debug entries must contain unique object IDs",
          path: [...entryPath, "objectId"],
        });
      }
      objectIds.add(entry.objectId);

      const validRepresentation =
        entry.shape === "text"
          ? entry.representation === "text-box-only"
          : entry.shape === "tile"
            ? entry.representation ===
                "tile-frame-only" ||
              entry.representation ===
                "tile-frame-and-collision"
            : entry.representation ===
              "geometry-outline";
      if (!validRepresentation) {
        context.addIssue({
          code: "custom",
          message:
            "Object debug representation must match the object shape",
          path: [
            ...entryPath,
            "representation",
          ],
        });
      }

      if (entry.rendered) {
        renderedObjectCount += 1;
      } else if (!entry.clipped) {
        context.addIssue({
          code: "custom",
          message:
            "A non-rendered object debug entry must report clipping",
          path: [...entryPath, "clipped"],
        });
      }
    }
    if (
      objectDebug.renderedObjectCount !==
      renderedObjectCount
    ) {
      context.addIssue({
        code: "custom",
        message:
          "renderedObjectCount must equal the number of rendered object debug entries",
        path: [
          "overlays",
          "objectDebug",
          "renderedObjectCount",
        ],
      });
    }
  });

export const nativePreviewToolOutputSchema =
  toolOutputSchema(nativePreviewResultOutputSchema);

const rasterMapPixelSizeOutputSchema = z
  .object({
    width: positiveIntegerOutputSchema.max(
      MAX_RASTER_RENDER_EDGE,
    ),
    height: positiveIntegerOutputSchema.max(
      MAX_RASTER_RENDER_EDGE,
    ),
  })
  .strict();

const rasterMapResultOutputSchema = z
  .object({
    mimeType: z.literal("image/png"),
    pixelSize:
      rasterMapPixelSizeOutputSchema,
    byteLength: positiveIntegerOutputSchema.max(
      MAX_RASTER_PNG_BYTES,
    ),
    sha256: revisionOutputSchema,
    map: mapSnapshotOutputSchema,
    dependencyRevisions:
      dependencyRevisionsOutputSchema,
    renderer: z
      .object({
        kind: z.literal("tmxrasterizer"),
        version: z
          .string()
          .min(1)
          .max(
            MAX_RENDERER_VERSION_LENGTH,
          ),
        profile: z.literal(
          RASTER_RENDER_PROFILE,
        ),
      })
      .strict(),
    options: z
      .object({
        size: positiveIntegerOutputSchema.max(
          MAX_RASTER_RENDER_EDGE,
        ),
        ignoreVisibility: z.boolean(),
      })
      .strict(),
    snapshotConsistency: z.literal(
      RASTER_SNAPSHOT_CONSISTENCY,
    ),
    truncated: z.literal(false),
  })
  .strict();

export const rasterMapToolOutputSchema =
  toolOutputSchema(rasterMapResultOutputSchema);
