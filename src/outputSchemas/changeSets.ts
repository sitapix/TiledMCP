import { z } from "zod";

import {
  MAX_OBJECT_SHAPE_POINTS,
  MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET,
  MAX_RESIZE_CROPPED_CELL_SAMPLE,
  MAX_RESIZE_MAP_DIMENSION,
  MAX_RESIZE_OFFSET_MAGNITUDE,
  MIN_POLYGON_OBJECT_POINTS,
  MIN_POLYLINE_OBJECT_POINTS,
} from "../maps/mapService.js";
import {
  MAX_TEXT_OBJECT_CONTENT_CODE_POINTS,
  MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET,
  MAX_TEXT_OBJECT_FONT_FAMILY_CODE_POINTS,
  MAX_TEXT_OBJECT_PIXEL_SIZE,
  MIN_TEXT_OBJECT_PIXEL_SIZE,
  TEXT_OBJECT_FIELDS,
  TEXT_OBJECT_HORIZONTAL_ALIGNMENTS,
  TEXT_OBJECT_VERTICAL_ALIGNMENTS,
  measureTextObjectPayloadBytes,
} from "../maps/textObjects.js";
import {
  MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
  MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
} from "../storage/checkpoints.js";
import {
  MAX_TILE_ANIMATION_FRAMES_PER_TILE,
  MAX_TILE_COLLISION_SHAPES_PER_TILE,
  MAX_TILE_PROPERTY_REMOVES_PER_TILE,
  MAX_TILE_PROPERTY_SETS_PER_TILE,
  MAX_TILE_UPDATES_PER_CHANGE_SET,
} from "../maps/tilesetEdits.js";
import { MAX_TILESET_WANG_COLORS_PER_SET } from "../maps/tilesetDetails.js";
import {
  MAX_WANG_ASSIGNMENTS_PER_OPERATION,
  MAX_WANG_EDIT_OPERATIONS,
} from "../maps/wangEdits.js";
import {
  MAX_CLASS_MEMBER_PATH_DEPTH,
  MAX_CLASS_MEMBER_WRITES_PER_TARGET,
  MAX_LIST_ELEMENT_WRITES_PER_TARGET,
  MAX_PROPERTY_NAME_CODE_POINTS,
  MAX_PROPERTY_VALUE_CODE_POINTS,
} from "../maps/propertyEdits.js";
import {
  MAX_CREATE_TILESET_MARGIN,
  MAX_CREATE_TILESET_NAME_CODE_POINTS,
  MAX_CREATE_TILESET_SPACING,
  MAX_CREATE_TILESET_TILE_EDGE,
} from "../maps/tilesetCreate.js";
import {
  MAX_TRANSACTION_MEMBERS,
  MIN_TRANSACTION_MEMBERS,
} from "../changeSets.js";
import {
  assetIdOutputSchema,
  changeSetIdOutputSchema,
  checkpointIdOutputSchema,
  checkpointTimestampOutputSchema,
  dependencyRevisionsOutputSchema,
  integerOutputSchema,
  isoTimestampOutputSchema,
  nonnegativeIntegerOutputSchema,
  positiveIntegerOutputSchema,
  projectPathOutputSchema,
  revisionOutputSchema,
  toolOutputSchema,
} from "./common.js";

const safeIntegerOutputSchema = integerOutputSchema
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
  .meta({ id: "ChangeSetSafeInteger" });
const uint32OutputSchema = nonnegativeIntegerOutputSchema.max(
  0xffffffff,
);
const positiveIdOutputSchema =
  positiveIntegerOutputSchema
    .max(Number.MAX_SAFE_INTEGER)
    .meta({ id: "ChangeSetPositiveId" });
const objectCoordinateOutputSchema = z
  .number()
  .min(-1_000_000_000)
  .max(1_000_000_000)
  .meta({ id: "ChangeSetObjectCoordinate" });
const objectExtentOutputSchema = z
  .number()
  .min(0)
  .max(1_000_000_000)
  .meta({ id: "ChangeSetObjectExtent" });
const objectStringOutputSchema = z.string().max(1_024);
const opacityOutputSchema = z.number().min(0).max(1);
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

const layerTypeOutputSchema = z.enum([
  "tilelayer",
  "objectgroup",
  "imagelayer",
  "group",
]).meta({ id: "ChangeSetLayerType" });
const nonImageLayerTypeOutputSchema = z.enum([
  "tilelayer",
  "objectgroup",
  "group",
]);
const mapRenderOrderOutputSchema = z.enum([
  "right-down",
  "right-up",
  "left-down",
  "left-up",
]);
const layerBlendModeOutputSchema = z.enum([
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
const mapUpdateFieldOutputSchema = z.enum([
  "renderOrder",
  "backgroundColor",
  "className",
]);
const layerUpdateFieldOutputSchema = z.enum([
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
]);

/*
 * Change-set previews echo the edit-intent TileRef shape. This differs from
 * the normalized read-result TileRef in common.ts: transform members remain
 * optional and retain the input names flipH/flipV/flipD.
 */
const previewTileTransformOutputSchema = z
  .object({
    kind: z.literal("orthogonal").optional(),
    flipH: z.boolean().optional(),
    flipV: z.boolean().optional(),
    flipD: z.boolean().optional(),
    rawFlags: uint32OutputSchema.optional(),
  })
  .strict();

const previewTileRefOutputSchema = z
  .object({
    tileset: z
      .object({
        kind: z.literal("external"),
        assetId: assetIdOutputSchema,
      })
      .strict(),
    localId: nonnegativeIntegerOutputSchema.max(
      0x0fffffff,
    ),
    transform:
      previewTileTransformOutputSchema.optional(),
  })
  .strict()
  .meta({ id: "ChangeSetTileRef" });

const positiveIntegerRectOutputSchema = z
  .object({
    x: safeIntegerOutputSchema,
    y: safeIntegerOutputSchema,
    width: positiveIntegerOutputSchema,
    height: positiveIntegerOutputSchema,
  })
  .strict()
  .meta({ id: "ChangeSetPositiveRect" });

const tileCellPreviewOutputSchema = z
  .object({
    x: safeIntegerOutputSchema,
    y: safeIntegerOutputSchema,
    tile: previewTileRefOutputSchema.nullable(),
  })
  .strict();

const mapPatchOutputSchema = z
  .object({
    renderOrder:
      mapRenderOrderOutputSchema.optional(),
    backgroundColor:
      tiledColorOutputSchema.nullable().optional(),
    className: z.string().optional(),
  })
  .strict();

const layerPatchOutputSchema = z
  .object({
    name: objectStringOutputSchema.optional(),
    className: objectStringOutputSchema.optional(),
    visible: z.boolean().optional(),
    opacity: opacityOutputSchema.optional(),
    offsetX: objectCoordinateOutputSchema.optional(),
    offsetY: objectCoordinateOutputSchema.optional(),
    parallaxX:
      objectCoordinateOutputSchema.optional(),
    parallaxY:
      objectCoordinateOutputSchema.optional(),
    tintColor:
      tiledColorOutputSchema.nullable().optional(),
    locked: z.boolean().optional(),
    blendMode:
      layerBlendModeOutputSchema.optional(),
  })
  .strict();

const objectCommonOutputShape = {
  x: objectCoordinateOutputSchema,
  y: objectCoordinateOutputSchema,
  name: objectStringOutputSchema.optional(),
  className: objectStringOutputSchema.optional(),
  rotation: objectCoordinateOutputSchema.optional(),
  visible: z.boolean().optional(),
  opacity: opacityOutputSchema.optional(),
} as const;

const rectangleObjectDraftOutputSchema = z
  .object({
    shape: z.literal("rectangle"),
    ...objectCommonOutputShape,
    width: objectExtentOutputSchema.optional(),
    height: objectExtentOutputSchema.optional(),
  })
  .strict();
const pointObjectDraftOutputSchema = z
  .object({
    shape: z.literal("point"),
    ...objectCommonOutputShape,
  })
  .strict();
const ellipseObjectDraftOutputSchema = z
  .object({
    shape: z.literal("ellipse"),
    ...objectCommonOutputShape,
    width: objectExtentOutputSchema.optional(),
    height: objectExtentOutputSchema.optional(),
  })
  .strict();
const capsuleObjectDraftOutputSchema = z
  .object({
    shape: z.literal("capsule"),
    ...objectCommonOutputShape,
    width: objectExtentOutputSchema.optional(),
    height: objectExtentOutputSchema.optional(),
  })
  .strict();
const objectPathPointOutputSchema = z
  .object({
    x: objectCoordinateOutputSchema,
    y: objectCoordinateOutputSchema,
  })
  .strict();
const polygonObjectDraftOutputSchema = z
  .object({
    shape: z.literal("polygon"),
    ...objectCommonOutputShape,
    points: z
      .array(objectPathPointOutputSchema)
      .min(MIN_POLYGON_OBJECT_POINTS)
      .max(MAX_OBJECT_SHAPE_POINTS),
  })
  .strict();
const polylineObjectDraftOutputSchema = z
  .object({
    shape: z.literal("polyline"),
    ...objectCommonOutputShape,
    points: z
      .array(objectPathPointOutputSchema)
      .min(MIN_POLYLINE_OBJECT_POINTS)
      .max(MAX_OBJECT_SHAPE_POINTS),
  })
  .strict();
const tileObjectDraftOutputSchema = z
  .object({
    shape: z.literal("tile"),
    ...objectCommonOutputShape,
    tile: previewTileRefOutputSchema,
    width: objectExtentOutputSchema,
    height: objectExtentOutputSchema,
  })
  .strict();
const textObjectDraftOutputSchema = z
  .object({
    shape: z.literal("text"),
    ...objectCommonOutputShape,
    width: objectExtentOutputSchema.optional(),
    height: objectExtentOutputSchema.optional(),
    text: textObjectContentOutputSchema,
    fontFamily:
      textObjectFontFamilyOutputSchema.optional(),
    pixelSize:
      textObjectPixelSizeOutputSchema.optional(),
    wrap: z.boolean().optional(),
    color: tiledColorOutputSchema.optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikeout: z.boolean().optional(),
    kerning: z.boolean().optional(),
    horizontalAlignment:
      textObjectHorizontalAlignmentOutputSchema.optional(),
    verticalAlignment:
      textObjectVerticalAlignmentOutputSchema.optional(),
  })
  .strict();
const propertyNameOutputSchema = z
  .string()
  .min(1)
  .max(MAX_PROPERTY_NAME_CODE_POINTS * 2);

const propertyWriteOutputSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        name: propertyNameOutputSchema,
        type: z.enum(["string", "file"]),
        value: z
          .string()
          .max(
            MAX_PROPERTY_VALUE_CODE_POINTS * 2,
          ),
      })
      .strict(),
    z
      .object({
        name: propertyNameOutputSchema,
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
        name: propertyNameOutputSchema,
        type: z.literal("float"),
        value: z.number().finite(),
      })
      .strict(),
    z
      .object({
        name: propertyNameOutputSchema,
        type: z.literal("bool"),
        value: z.boolean(),
      })
      .strict(),
    z
      .object({
        name: propertyNameOutputSchema,
        type: z.literal("color"),
        value: z
          .string()
          .regex(/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu),
      })
      .strict(),
  ]);

const scalarWriteValueOutputSchema = z.union([
  z.string().max(4_096),
  z.number().finite(),
  z.boolean(),
]);

const propertiesPatchOutputSchema = z
  .object({
    set: z
      .array(propertyWriteOutputSchema)
      .min(1)
      .max(MAX_TILE_PROPERTY_SETS_PER_TILE)
      .optional(),
    remove: z
      .array(propertyNameOutputSchema)
      .min(1)
      .max(MAX_TILE_PROPERTY_REMOVES_PER_TILE)
      .optional(),
    setClassMembers: z
      .array(
        z
          .object({
            property: propertyNameOutputSchema,
            path: z
              .array(propertyNameOutputSchema)
              .min(1)
              .max(MAX_CLASS_MEMBER_PATH_DEPTH),
            value: scalarWriteValueOutputSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CLASS_MEMBER_WRITES_PER_TARGET)
      .optional(),
    setListElements: z
      .array(
        z
          .object({
            property: propertyNameOutputSchema,
            index:
              nonnegativeIntegerOutputSchema.max(
                100_000,
              ),
            value: scalarWriteValueOutputSchema,
          })
          .strict(),
      )
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
        "Properties patch must contain set, remove, setClassMembers, or setListElements entries",
    },
  );

const objectPatchOutputSchema = z
  .object({
    x: objectCoordinateOutputSchema.optional(),
    y: objectCoordinateOutputSchema.optional(),
    width: objectExtentOutputSchema.optional(),
    height: objectExtentOutputSchema.optional(),
    tile: previewTileRefOutputSchema.optional(),
    points: z
      .array(objectPathPointOutputSchema)
      .min(MIN_POLYLINE_OBJECT_POINTS)
      .max(MAX_OBJECT_SHAPE_POINTS)
      .optional(),
    name: objectStringOutputSchema.optional(),
    className: objectStringOutputSchema.optional(),
    rotation: objectCoordinateOutputSchema.optional(),
    visible: z.boolean().optional(),
    opacity: opacityOutputSchema.optional(),
    text: textObjectContentOutputSchema.optional(),
    fontFamily:
      textObjectFontFamilyOutputSchema.optional(),
    pixelSize:
      textObjectPixelSizeOutputSchema.optional(),
    wrap: z.boolean().optional(),
    color: tiledColorOutputSchema.optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikeout: z.boolean().optional(),
    kerning: z.boolean().optional(),
    horizontalAlignment:
      textObjectHorizontalAlignmentOutputSchema.optional(),
    verticalAlignment:
      textObjectVerticalAlignmentOutputSchema.optional(),
    properties:
      propertiesPatchOutputSchema.optional(),
  })
  .strict()
  .refine(
    (patch) => Object.keys(patch).length > 0,
    {
      message:
        "Object update patch must contain at least one field",
    },
  );

const layerDescriptorOutputSchema = z
  .object({
    id: positiveIdOutputSchema,
    type: layerTypeOutputSchema,
    name: z.string(),
    nameTruncated: z.boolean(),
  })
  .strict()
  .meta({
    id: "ChangeSetLayerDescriptor",
  });

const idMappingOutputSchema = z
  .object({
    from: positiveIdOutputSchema,
    to: positiveIdOutputSchema,
  })
  .strict()
  .meta({ id: "ChangeSetIdMapping" });

const imageDependencyOutputSchema = z
  .object({
    assetId: assetIdOutputSchema,
    path: projectPathOutputSchema,
    source: z.string().min(1),
    revision: revisionOutputSchema,
    width: positiveIntegerOutputSchema,
    height: positiveIntegerOutputSchema,
  })
  .strict()
  .meta({
    id: "ChangeSetImageDependency",
  });

const updateMapOperationPreviewOutputSchema = z
  .object({
    type: z.literal("updateMap"),
    destructive: z.literal(false),
    warning: z.string(),
    patch: mapPatchOutputSchema,
    requestedFields: z.array(
      mapUpdateFieldOutputSchema,
    ),
    changedFields: z.array(
      mapUpdateFieldOutputSchema,
    ),
    wouldChange: z.boolean(),
    renderingMayChange: z.boolean(),
  })
  .strict();

const resizeDimensionOutputSchema =
  positiveIntegerOutputSchema.max(
    MAX_RESIZE_MAP_DIMENSION,
  );
const resizeOffsetOutputSchema = integerOutputSchema
  .min(-MAX_RESIZE_OFFSET_MAGNITUDE)
  .max(MAX_RESIZE_OFFSET_MAGNITUDE);
const resizeBoundsOutputSchema = z
  .object({
    width: positiveIntegerOutputSchema,
    height: positiveIntegerOutputSchema,
  })
  .strict()
  .meta({ id: "ChangeSetResizeBounds" });
const resizeCroppedCellOutputSchema = z
  .object({
    layerId: positiveIdOutputSchema,
    x: nonnegativeIntegerOutputSchema,
    y: nonnegativeIntegerOutputSchema,
    gid: uint32OutputSchema.min(1),
  })
  .strict()
  .meta({ id: "ChangeSetResizeCroppedCell" });
const resizeAccountingShape = {
  wouldChange: z.boolean(),
  mapDimensionsChanged: z.boolean(),
  tileLayerCount: nonnegativeIntegerOutputSchema,
  resizedTileLayerIds: z.array(
    positiveIdOutputSchema,
  ),
  scannedCellCount: nonnegativeIntegerOutputSchema,
  rewrittenCellCount: nonnegativeIntegerOutputSchema,
  preservedNonEmptyCellCount:
    nonnegativeIntegerOutputSchema,
  croppedNonEmptyCellCount:
    nonnegativeIntegerOutputSchema,
  croppedCellSample: z
    .array(resizeCroppedCellOutputSchema)
    .max(MAX_RESIZE_CROPPED_CELL_SAMPLE),
  omittedCroppedCellCount:
    nonnegativeIntegerOutputSchema,
  objectLayerCount: nonnegativeIntegerOutputSchema,
  movedObjectCount: nonnegativeIntegerOutputSchema,
  objectsOutsideNewBounds:
    nonnegativeIntegerOutputSchema,
  imageLayerCount: nonnegativeIntegerOutputSchema,
  shiftedImageLayerIds: z.array(
    positiveIdOutputSchema,
  ),
  groupLayerCount: nonnegativeIntegerOutputSchema,
  lockedLayerCount: nonnegativeIntegerOutputSchema,
} as const;

const transcodeStorageOutputSchema = z
  .object({
    encoding: z.enum(["csv", "base64"]),
    compression: z.enum([
      "",
      "gzip",
      "zlib",
      "zstd",
    ]),
  })
  .strict();

const transcodeTileLayerOperationPreviewOutputSchema =
  z
    .object({
      type: z.literal("transcodeTileLayer"),
      destructive: z.literal(false),
      warning: z.string(),
      layerId: positiveIdOutputSchema,
      from: transcodeStorageOutputSchema,
      to: transcodeStorageOutputSchema,
      cellCount: positiveIntegerOutputSchema,
      wouldChange: z.boolean(),
    })
    .strict();

const resizeMapOperationPreviewOutputSchema = z
  .object({
    type: z.literal("resizeMap"),
    destructive: z.literal(true),
    warning: z.string(),
    oldBounds: resizeBoundsOutputSchema,
    newBounds: resizeBoundsOutputSchema,
    offset: z
      .object({
        x: resizeOffsetOutputSchema,
        y: resizeOffsetOutputSchema,
      })
      .strict(),
    pixelOffset: z
      .object({
        x: safeIntegerOutputSchema,
        y: safeIntegerOutputSchema,
      })
      .strict(),
    ...resizeAccountingShape,
  })
  .strict();

const setTilesOperationPreviewOutputSchema = z
  .object({
    type: z.literal("setTiles"),
    layerId: positiveIdOutputSchema,
    cellCount: positiveIntegerOutputSchema,
    bounds: positiveIntegerRectOutputSchema,
    sample: z
      .array(tileCellPreviewOutputSchema)
      .min(1)
      .max(8),
    omittedCellCount:
      nonnegativeIntegerOutputSchema,
  })
  .strict();

const fillRegionOperationPreviewOutputSchema = z
  .object({
    type: z.literal("fillRegion"),
    layerId: positiveIdOutputSchema,
    region: positiveIntegerRectOutputSchema,
    tile: previewTileRefOutputSchema.nullable(),
  })
  .strict();

const stampPatternOperationPreviewOutputSchema = z
  .object({
    type: z.literal("stampPattern"),
    layerId: positiveIdOutputSchema,
    destructive: z.literal(true),
    warning: z.string(),
    region: positiveIntegerRectOutputSchema,
    cellCount: positiveIntegerOutputSchema,
    nonEmptyCellCount:
      nonnegativeIntegerOutputSchema,
    clearCellCount: nonnegativeIntegerOutputSchema,
    transformedCellCount:
      nonnegativeIntegerOutputSchema,
    changedCellCount:
      nonnegativeIntegerOutputSchema,
    wouldChange: z.boolean(),
    sample: z
      .array(tileCellPreviewOutputSchema)
      .min(1)
      .max(8),
    omittedCellCount:
      nonnegativeIntegerOutputSchema,
  })
  .strict();

const floodFillOperationPreviewOutputSchema = z
  .object({
    type: z.literal("floodFill"),
    layerId: positiveIdOutputSchema,
    destructive: z.literal(true),
    warning: z.string(),
    seed: z
      .object({
        x: safeIntegerOutputSchema,
        y: safeIntegerOutputSchema,
      })
      .strict(),
    connectivity: z.literal("four-way"),
    sourceTile: previewTileRefOutputSchema.nullable(),
    targetTile: previewTileRefOutputSchema.nullable(),
    scannedCellCount: positiveIntegerOutputSchema,
    changedCellCount:
      nonnegativeIntegerOutputSchema,
    affectedBounds:
      positiveIntegerRectOutputSchema.nullable(),
    wouldChange: z.boolean(),
  })
  .strict();

const copyRegionEndpointOutputSchema = z
  .object({
    layerId: positiveIdOutputSchema,
    x: safeIntegerOutputSchema,
    y: safeIntegerOutputSchema,
    width: positiveIntegerOutputSchema,
    height: positiveIntegerOutputSchema,
  })
  .strict()
  .meta({
    id: "ChangeSetCopyEndpoint",
  });

const copyRegionOperationPreviewOutputSchema = z
  .object({
    type: z.literal("copyRegion"),
    destructive: z.literal(true),
    warning: z.string(),
    source: copyRegionEndpointOutputSchema,
    destination: copyRegionEndpointOutputSchema,
    scannedCellCount: positiveIntegerOutputSchema,
    cellCount: positiveIntegerOutputSchema,
    sourceNonEmptyCellCount:
      nonnegativeIntegerOutputSchema,
    changedCellCount:
      nonnegativeIntegerOutputSchema,
    overwrittenNonEmptyCellCount:
      nonnegativeIntegerOutputSchema,
    clearedCellCount:
      nonnegativeIntegerOutputSchema,
    overlapsSource: z.boolean(),
    wouldChange: z.boolean(),
  })
  .strict();

const replaceTilesOperationPreviewOutputSchema = z
  .object({
    type: z.literal("replaceTiles"),
    layerId: positiveIdOutputSchema,
    destructive: z.literal(true),
    warning: z.string(),
    region: positiveIntegerRectOutputSchema,
    scannedCellCount:
      nonnegativeIntegerOutputSchema,
    replacedCellCount:
      nonnegativeIntegerOutputSchema,
    mappingCount: positiveIntegerOutputSchema,
    mappingSample: z
      .array(
        z
          .object({
            from: previewTileRefOutputSchema,
            to: previewTileRefOutputSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    omittedMappingCount:
      nonnegativeIntegerOutputSchema,
  })
  .strict();

const createObjectOperationPreviewOutputSchema =
  z.discriminatedUnion("shape", [
    z
      .object({
        type: z.literal("createObject"),
        layerId: positiveIdOutputSchema,
        shape: z.literal("rectangle"),
        object:
          rectangleObjectDraftOutputSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("createObject"),
        layerId: positiveIdOutputSchema,
        shape: z.literal("point"),
        object: pointObjectDraftOutputSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("createObject"),
        layerId: positiveIdOutputSchema,
        shape: z.literal("ellipse"),
        object: ellipseObjectDraftOutputSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("createObject"),
        layerId: positiveIdOutputSchema,
        shape: z.literal("capsule"),
        object: capsuleObjectDraftOutputSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("createObject"),
        layerId: positiveIdOutputSchema,
        shape: z.literal("polygon"),
        object: polygonObjectDraftOutputSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("createObject"),
        layerId: positiveIdOutputSchema,
        shape: z.literal("polyline"),
        object: polylineObjectDraftOutputSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("createObject"),
        layerId: positiveIdOutputSchema,
        shape: z.literal("text"),
        object: textObjectDraftOutputSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("createObject"),
        layerId: positiveIdOutputSchema,
        shape: z.literal("tile"),
        object: tileObjectDraftOutputSchema,
      })
      .strict(),
  ]);

const instantiateTemplateOperationPreviewOutputSchema =
  z
    .object({
      type: z.literal("instantiateTemplate"),
      destructive: z.literal(false),
      warning: z.string(),
      layerId: positiveIdOutputSchema,
      templatePath: projectPathOutputSchema,
      source: z.string().min(1).max(4_096),
      x: objectCoordinateOutputSchema,
      y: objectCoordinateOutputSchema,
      expectedTemplateRevision:
        revisionOutputSchema,
    })
    .strict();

const updateObjectOperationPreviewOutputSchema = z
  .object({
    type: z.literal("updateObject"),
    objectId: positiveIdOutputSchema,
    changedFields: z.array(
      z.enum([
        "x",
        "y",
        "width",
        "height",
        "points",
        "name",
        "className",
        "rotation",
        "visible",
        "opacity",
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
        "properties",
        "tile",
      ]),
    ),
    patch: objectPatchOutputSchema,
  })
  .strict()
  .superRefine((operation, context) => {
    const expectedFields = Object.keys(
      operation.patch,
    ).sort();
    if (
      operation.changedFields.length !==
        expectedFields.length ||
      operation.changedFields.some(
        (field, index) =>
          field !== expectedFields[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["changedFields"],
        message:
          "updateObject changedFields must exactly equal the sorted patch keys",
      });
    }
  });

const updateLayerOperationPreviewOutputSchema = z
  .object({
    type: z.literal("updateLayer"),
    layerId: positiveIdOutputSchema,
    layerType: layerTypeOutputSchema,
    destructive: z.literal(false),
    warning: z.string(),
    patch: layerPatchOutputSchema,
    requestedFields: z.array(
      layerUpdateFieldOutputSchema,
    ),
    changedFields: z.array(
      layerUpdateFieldOutputSchema,
    ),
    wouldChange: z.boolean(),
    affectsDescendants: z.boolean(),
  })
  .strict();

const deleteLayerOperationPreviewOutputSchema = z
  .object({
    type: z.literal("deleteLayer"),
    layerId: positiveIdOutputSchema,
    deleteDescendants: z.boolean(),
    destructive: z.literal(true),
    warning: z.string(),
    layer: layerDescriptorOutputSchema,
    parentGroupId:
      positiveIdOutputSchema.nullable(),
    index: nonnegativeIntegerOutputSchema,
    deletedLayerCount: positiveIntegerOutputSchema,
    descendantLayerCount:
      nonnegativeIntegerOutputSchema,
    layerIdSample: z.array(positiveIdOutputSchema),
    omittedLayerCount:
      nonnegativeIntegerOutputSchema,
    objectCount: nonnegativeIntegerOutputSchema,
    objectIdSample: z.array(positiveIdOutputSchema),
    omittedObjectCount:
      nonnegativeIntegerOutputSchema,
    lockedLayerCount:
      nonnegativeIntegerOutputSchema,
  })
  .strict();

const moveLayerOperationPreviewOutputSchema = z
  .object({
    type: z.literal("moveLayer"),
    layerId: positiveIdOutputSchema,
    destructive: z.literal(false),
    warning: z.string(),
    layer: layerDescriptorOutputSchema,
    sourceParentGroupId:
      positiveIdOutputSchema.nullable(),
    sourceIndex: nonnegativeIntegerOutputSchema,
    targetParentGroupId:
      positiveIdOutputSchema.nullable(),
    targetIndex: nonnegativeIntegerOutputSchema,
    subtreeLayerCount: positiveIntegerOutputSchema,
    descendantLayerCount:
      nonnegativeIntegerOutputSchema,
    layerIdSample: z.array(positiveIdOutputSchema),
    omittedLayerCount:
      nonnegativeIntegerOutputSchema,
    objectCount: nonnegativeIntegerOutputSchema,
    lockedLayerCount:
      nonnegativeIntegerOutputSchema,
    sourceParentLocked: z.boolean(),
    targetParentLocked: z.boolean(),
    effectivelyLockedLayerCountBefore:
      nonnegativeIntegerOutputSchema,
    effectivelyLockedLayerCountAfter:
      nonnegativeIntegerOutputSchema,
    wouldChange: z.boolean(),
    renderOrderMayChange: z.boolean(),
    renderContextMayChange: z.boolean(),
    affectsDescendants: z.boolean(),
  })
  .strict();

const duplicateLayerOperationPreviewOutputSchema = z
  .object({
    type: z.literal("duplicateLayer"),
    destructive: z.literal(false),
    warning: z.string(),
    sourceLayerId: positiveIdOutputSchema,
    createdRootLayerId: positiveIdOutputSchema,
    layerType: layerTypeOutputSchema,
    name: z.string(),
    nameTruncated: z.boolean(),
    sourceParentGroupId:
      positiveIdOutputSchema.nullable(),
    targetParentGroupId:
      positiveIdOutputSchema.nullable(),
    sourceIndex: nonnegativeIntegerOutputSchema,
    targetIndex: nonnegativeIntegerOutputSchema,
    copiedLayerCount: positiveIntegerOutputSchema,
    descendantLayerCount:
      nonnegativeIntegerOutputSchema,
    copiedObjectCount:
      nonnegativeIntegerOutputSchema,
    allocatedCellCount:
      nonnegativeIntegerOutputSchema,
    serializedDuplicateBytes:
      positiveIntegerOutputSchema,
    layerIdMappingSample: z.array(
      idMappingOutputSchema,
    ),
    omittedLayerMappingCount:
      nonnegativeIntegerOutputSchema,
    objectIdMappingSample: z.array(
      idMappingOutputSchema,
    ),
    omittedObjectMappingCount:
      nonnegativeIntegerOutputSchema,
    remappedInternalObjectReferenceCount:
      nonnegativeIntegerOutputSchema,
    retainedExternalObjectReferenceCount:
      nonnegativeIntegerOutputSchema,
    fileReferenceCount:
      nonnegativeIntegerOutputSchema,
    tileObjectCount:
      nonnegativeIntegerOutputSchema,
    lockedLayerCount:
      nonnegativeIntegerOutputSchema,
    effectivelyLockedLayerCount:
      nonnegativeIntegerOutputSchema,
    renderOrderMayChange: z.boolean(),
    renderContextMayChange: z.boolean(),
    affectsDescendants: z.boolean(),
  })
  .strict();

const deleteObjectsOperationPreviewOutputSchema = z
  .object({
    type: z.literal("deleteObjects"),
    destructive: z.literal(true),
    warning: z.string(),
    objectCount: positiveIntegerOutputSchema,
    objectIdSample: z
      .array(positiveIdOutputSchema)
      .min(1)
      .max(32),
    omittedObjectCount:
      nonnegativeIntegerOutputSchema,
  })
  .strict();

const addTilesetOperationPreviewOutputSchema = z
  .object({
    type: z.literal("addTilesetToMap"),
    destructive: z.literal(false),
    warning: z.string(),
    tileset: z
      .object({
        kind: z.literal("external"),
        assetId: assetIdOutputSchema,
        path: projectPathOutputSchema,
        revision: revisionOutputSchema,
        tileCount: positiveIntegerOutputSchema,
        gidSpan: positiveIntegerOutputSchema,
      })
      .strict(),
    source: z.string().min(1),
    assignedFirstGid:
      positiveIntegerOutputSchema,
    gidRange: z
      .object({
        first: positiveIntegerOutputSchema,
        last: positiveIntegerOutputSchema,
      })
      .strict(),
  })
  .strict();

const removeTilesetOperationPreviewOutputSchema = z
  .object({
    type: z.literal("removeTilesetFromMap"),
    destructive: z.literal(true),
    warning: z.string(),
    tileset: z
      .object({
        kind: z.literal("external"),
        assetId: assetIdOutputSchema,
        path: projectPathOutputSchema,
        revision: revisionOutputSchema,
        name: z.string(),
        nameTruncated: z.literal(true).optional(),
        tileCount: positiveIntegerOutputSchema,
        gidSpan: positiveIntegerOutputSchema,
      })
      .strict(),
    source: z.string().min(1),
    index: nonnegativeIntegerOutputSchema,
    gidRange: z
      .object({
        first: positiveIntegerOutputSchema,
        last: positiveIntegerOutputSchema,
      })
      .strict(),
    scanned: z
      .object({
        tileCells:
          nonnegativeIntegerOutputSchema,
        objects:
          nonnegativeIntegerOutputSchema,
      })
      .strict(),
  })
  .strict();

const nonImageCreateLayerOperationPreviewOutputSchema =
  z
    .object({
      type: z.literal("createLayer"),
      destructive: z.literal(false),
      warning: z.string(),
      layer: z
        .object({
          id: positiveIdOutputSchema,
          type: nonImageLayerTypeOutputSchema,
          name: z.string(),
        })
        .strict(),
      parentGroupId:
        positiveIdOutputSchema.nullable(),
      index: nonnegativeIntegerOutputSchema,
      allocatedCellCount:
        nonnegativeIntegerOutputSchema,
    })
    .strict();

const imageCreateLayerOperationPreviewOutputSchema = z
  .object({
    type: z.literal("createLayer"),
    destructive: z.literal(false),
    warning: z.string(),
    layer: z
      .object({
        id: positiveIdOutputSchema,
        type: z.literal("imagelayer"),
        name: z.string(),
      })
      .strict(),
    parentGroupId:
      positiveIdOutputSchema.nullable(),
    index: nonnegativeIntegerOutputSchema,
    allocatedCellCount:
      nonnegativeIntegerOutputSchema,
    image: imageDependencyOutputSchema,
  })
  .strict();

const restoreCheckpointOperationPreviewOutputSchema = z
  .object({
    type: z.literal("restoreCheckpoint"),
    destructive: z.literal(true),
    warning: z.string(),
    checkpointId: checkpointIdOutputSchema,
    targetPath: projectPathOutputSchema,
    currentRevision:
      revisionOutputSchema.nullable(),
    restoreRevision: revisionOutputSchema,
    restoreBytes: nonnegativeIntegerOutputSchema,
    exactBytes: z.literal(true),
    wouldChange: z.boolean(),
  })
  .strict();

const pruneCheckpointOperationPreviewOutputSchema = z
  .object({
    type: z.literal("pruneCheckpoint"),
    destructive: z.literal(true),
    warning: z.string(),
    checkpointId: checkpointIdOutputSchema,
    targetPath: projectPathOutputSchema,
    status: z.literal("committed"),
    manifestRevision: revisionOutputSchema,
    manifestBytes:
      positiveIntegerOutputSchema.max(
        Number.MAX_SAFE_INTEGER,
      ),
    removesRecoveryPoint: z.literal(true),
    removesProjectAsset: z.literal(false),
    garbageCollection: z.literal(
      "fail-closed-after-manifest-prune",
    ),
  })
  .strict();

const pruneCheckpointBatchOperationPreviewOutputSchema =
  z
    .object({
      type: z.literal(
        "pruneCheckpointBatch",
      ),
      destructive: z.literal(true),
      warning: z.string(),
      checkpointCount:
        positiveIntegerOutputSchema
          .min(
            MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
          )
          .max(
            MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
          ),
      checkpointIds: z
        .array(checkpointIdOutputSchema)
        .min(
          MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
        )
        .max(
          MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
        ),
      targetCount:
        positiveIntegerOutputSchema.max(
          MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
        ),
      targetPaths: z
        .array(projectPathOutputSchema)
        .min(1)
        .max(
          MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
        ),
      status: z.literal("committed"),
      manifestBytes:
        positiveIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      removesRecoveryPointCount:
        positiveIntegerOutputSchema
          .min(
            MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
          )
          .max(
            MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
          ),
      removesProjectAssets: z.literal(false),
      ordering: z.literal(
        "canonical-checkpoint-id",
      ),
      atomic: z.literal(false),
      stopOnFirstFailure: z.literal(true),
      partialResult: z.literal(
        "cached-final-no-resume",
      ),
      garbageCollection: z.literal(
        "once-after-all-manifests-fail-closed",
      ),
    })
    .strict();

const discardPreparedCheckpointOperationPreviewOutputSchema =
  z
    .object({
      type: z.literal(
        "discardPreparedCheckpoint",
      ),
      destructive: z.literal(true),
      warning: z.string(),
      checkpointId: checkpointIdOutputSchema,
      targetPath: projectPathOutputSchema,
      status: z.literal("prepared"),
      manifestRevision:
        revisionOutputSchema,
      manifestBytes:
        positiveIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      removesRecoveryPoint: z.literal(true),
      removesProjectAsset: z.literal(false),
      targetBeforeStateVerified:
        z.literal(true),
      garbageCollection: z.literal(
        "fail-closed-after-prepared-manifest-discard",
      ),
    })
    .strict();

const commitPreparedCheckpointOperationPreviewOutputSchema =
  z
    .object({
      type: z.literal(
        "commitPreparedCheckpoint",
      ),
      destructive: z.literal(false),
      warning: z.string(),
      checkpointId: checkpointIdOutputSchema,
      targetPath: projectPathOutputSchema,
      status: z.literal("prepared"),
      manifestRevision:
        revisionOutputSchema,
      manifestBytes:
        positiveIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      operatorDecisionRequired:
        z.literal(true),
      commitsCheckpointRecord: z.literal(true),
      projectAssetModified: z.literal(false),
      garbageCollection: z.literal(
        "not-run",
      ),
    })
    .strict();

const abandonPreparedCheckpointOperationPreviewOutputSchema =
  z
    .object({
      type: z.literal(
        "abandonPreparedCheckpoint",
      ),
      destructive: z.literal(true),
      warning: z.string(),
      checkpointId: checkpointIdOutputSchema,
      targetPath: projectPathOutputSchema,
      status: z.literal("prepared"),
      manifestRevision:
        revisionOutputSchema,
      manifestBytes:
        positiveIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      operatorDecisionRequired:
        z.literal(true),
      removesRecoveryPoint: z.literal(true),
      projectAssetModified: z.literal(false),
      garbageCollection: z.literal(
        "fail-closed-after-prepared-manifest-abandon",
      ),
    })
    .strict();

const genericOperationPreviewOutputSchema =
  z.discriminatedUnion("type", [
    updateMapOperationPreviewOutputSchema,
    resizeMapOperationPreviewOutputSchema,
    transcodeTileLayerOperationPreviewOutputSchema,
    setTilesOperationPreviewOutputSchema,
    fillRegionOperationPreviewOutputSchema,
    stampPatternOperationPreviewOutputSchema,
    floodFillOperationPreviewOutputSchema,
    copyRegionOperationPreviewOutputSchema,
    replaceTilesOperationPreviewOutputSchema,
    createObjectOperationPreviewOutputSchema,
    updateObjectOperationPreviewOutputSchema,
    instantiateTemplateOperationPreviewOutputSchema,
    updateLayerOperationPreviewOutputSchema,
    deleteLayerOperationPreviewOutputSchema,
    moveLayerOperationPreviewOutputSchema,
    duplicateLayerOperationPreviewOutputSchema,
    deleteObjectsOperationPreviewOutputSchema,
    removeTilesetOperationPreviewOutputSchema,
  ]);

const mapUpdateSummaryOutputSchema = z
  .object({
    operationIndex: nonnegativeIntegerOutputSchema,
    requestedFields: z.array(
      mapUpdateFieldOutputSchema,
    ),
    changedFields: z.array(
      mapUpdateFieldOutputSchema,
    ),
    wouldChange: z.boolean(),
    renderingMayChange: z.boolean(),
  })
  .strict();

const mapResizeSummaryOutputSchema = z
  .object({
    operationIndex: nonnegativeIntegerOutputSchema,
    oldWidth: positiveIntegerOutputSchema,
    oldHeight: positiveIntegerOutputSchema,
    newWidth: resizeDimensionOutputSchema,
    newHeight: resizeDimensionOutputSchema,
    offsetX: resizeOffsetOutputSchema,
    offsetY: resizeOffsetOutputSchema,
    pixelOffsetX: safeIntegerOutputSchema,
    pixelOffsetY: safeIntegerOutputSchema,
    ...resizeAccountingShape,
  })
  .strict();

const removedTilesetSummaryOutputSchema = z
  .object({
    operationIndex: nonnegativeIntegerOutputSchema,
    assetId: assetIdOutputSchema,
    tilesetPath: projectPathOutputSchema,
    source: z.string().min(1),
    tilesetRevision: revisionOutputSchema,
    name: z.string(),
    nameTruncated: z.boolean(),
    index: nonnegativeIntegerOutputSchema,
    tileCount: positiveIntegerOutputSchema,
    gidSpan: positiveIntegerOutputSchema,
    firstGid: positiveIntegerOutputSchema,
    lastGid: positiveIntegerOutputSchema,
    scannedCellCount:
      nonnegativeIntegerOutputSchema,
    scannedObjectCount:
      nonnegativeIntegerOutputSchema,
  })
  .strict();

const layerUpdateSummaryOutputSchema = z
  .object({
    operationIndex: nonnegativeIntegerOutputSchema,
    layerId: positiveIdOutputSchema,
    layerType: layerTypeOutputSchema,
    requestedFields: z.array(
      layerUpdateFieldOutputSchema,
    ),
    changedFields: z.array(
      layerUpdateFieldOutputSchema,
    ),
    wouldChange: z.boolean(),
    affectsDescendants: z.boolean(),
  })
  .strict();

const deletedLayerSummaryOutputSchema = z
  .object({
    operationIndex: nonnegativeIntegerOutputSchema,
    layerId: positiveIdOutputSchema,
    layerType: layerTypeOutputSchema,
    name: z.string(),
    nameTruncated: z.boolean(),
    parentGroupId:
      positiveIdOutputSchema.nullable(),
    index: nonnegativeIntegerOutputSchema,
    deletedLayerCount: positiveIntegerOutputSchema,
    descendantLayerCount:
      nonnegativeIntegerOutputSchema,
    layerIdSample: z.array(positiveIdOutputSchema),
    omittedLayerCount:
      nonnegativeIntegerOutputSchema,
    objectCount: nonnegativeIntegerOutputSchema,
    objectIdSample: z.array(positiveIdOutputSchema),
    omittedObjectCount:
      nonnegativeIntegerOutputSchema,
    lockedLayerCount:
      nonnegativeIntegerOutputSchema,
  })
  .strict();

const movedLayerSummaryOutputSchema = z
  .object({
    operationIndex: nonnegativeIntegerOutputSchema,
    layerId: positiveIdOutputSchema,
    layerType: layerTypeOutputSchema,
    name: z.string(),
    nameTruncated: z.boolean(),
    sourceParentGroupId:
      positiveIdOutputSchema.nullable(),
    sourceIndex: nonnegativeIntegerOutputSchema,
    targetParentGroupId:
      positiveIdOutputSchema.nullable(),
    targetIndex: nonnegativeIntegerOutputSchema,
    subtreeLayerCount: positiveIntegerOutputSchema,
    descendantLayerCount:
      nonnegativeIntegerOutputSchema,
    layerIdSample: z.array(positiveIdOutputSchema),
    omittedLayerCount:
      nonnegativeIntegerOutputSchema,
    objectCount: nonnegativeIntegerOutputSchema,
    lockedLayerCount:
      nonnegativeIntegerOutputSchema,
    sourceParentLocked: z.boolean(),
    targetParentLocked: z.boolean(),
    effectivelyLockedLayerCountBefore:
      nonnegativeIntegerOutputSchema,
    effectivelyLockedLayerCountAfter:
      nonnegativeIntegerOutputSchema,
    wouldChange: z.boolean(),
    renderOrderMayChange: z.boolean(),
    renderContextMayChange: z.boolean(),
    affectsDescendants: z.boolean(),
  })
  .strict();

const duplicatedLayerSummaryOutputSchema = z
  .object({
    operationIndex: nonnegativeIntegerOutputSchema,
    sourceLayerId: positiveIdOutputSchema,
    createdRootLayerId: positiveIdOutputSchema,
    layerType: layerTypeOutputSchema,
    name: z.string(),
    nameTruncated: z.boolean(),
    sourceParentGroupId:
      positiveIdOutputSchema.nullable(),
    targetParentGroupId:
      positiveIdOutputSchema.nullable(),
    sourceIndex: nonnegativeIntegerOutputSchema,
    targetIndex: nonnegativeIntegerOutputSchema,
    copiedLayerCount: positiveIntegerOutputSchema,
    descendantLayerCount:
      nonnegativeIntegerOutputSchema,
    copiedObjectCount:
      nonnegativeIntegerOutputSchema,
    allocatedCellCount:
      nonnegativeIntegerOutputSchema,
    serializedDuplicateBytes:
      positiveIntegerOutputSchema,
    layerIdMappingSample: z.array(
      idMappingOutputSchema,
    ),
    omittedLayerMappingCount:
      nonnegativeIntegerOutputSchema,
    objectIdMappingSample: z.array(
      idMappingOutputSchema,
    ),
    omittedObjectMappingCount:
      nonnegativeIntegerOutputSchema,
    remappedInternalObjectReferenceCount:
      nonnegativeIntegerOutputSchema,
    retainedExternalObjectReferenceCount:
      nonnegativeIntegerOutputSchema,
    fileReferenceCount:
      nonnegativeIntegerOutputSchema,
    tileObjectCount:
      nonnegativeIntegerOutputSchema,
    lockedLayerCount:
      nonnegativeIntegerOutputSchema,
    effectivelyLockedLayerCount:
      nonnegativeIntegerOutputSchema,
    renderOrderMayChange: z.boolean(),
    renderContextMayChange: z.boolean(),
    affectsDescendants: z.boolean(),
  })
  .strict();

const tileReplacementSummaryOutputSchema = z
  .object({
    operationIndex: nonnegativeIntegerOutputSchema,
    layerId: positiveIdOutputSchema,
    region: positiveIntegerRectOutputSchema,
    scannedCellCount:
      nonnegativeIntegerOutputSchema,
    replacedCellCount:
      nonnegativeIntegerOutputSchema,
    mappingCount: positiveIntegerOutputSchema,
  })
  .strict();

const tileStampSummaryOutputSchema = z
  .object({
    operationIndex: nonnegativeIntegerOutputSchema,
    layerId: positiveIdOutputSchema,
    region: positiveIntegerRectOutputSchema,
    cellCount: positiveIntegerOutputSchema,
    nonEmptyCellCount:
      nonnegativeIntegerOutputSchema,
    clearCellCount: nonnegativeIntegerOutputSchema,
    transformedCellCount:
      nonnegativeIntegerOutputSchema,
    changedCellCount:
      nonnegativeIntegerOutputSchema,
    wouldChange: z.boolean(),
  })
  .strict();

const tileFloodFillSummaryOutputSchema = z
  .object({
    operationIndex: nonnegativeIntegerOutputSchema,
    layerId: positiveIdOutputSchema,
    seed: z
      .object({
        x: safeIntegerOutputSchema,
        y: safeIntegerOutputSchema,
      })
      .strict(),
    connectivity: z.literal("four-way"),
    sourceTile: previewTileRefOutputSchema.nullable(),
    targetTile: previewTileRefOutputSchema.nullable(),
    scannedCellCount: positiveIntegerOutputSchema,
    changedCellCount:
      nonnegativeIntegerOutputSchema,
    affectedBounds:
      positiveIntegerRectOutputSchema.nullable(),
    wouldChange: z.boolean(),
  })
  .strict();

const tileCopySummaryOutputSchema = z
  .object({
    operationIndex: nonnegativeIntegerOutputSchema,
    source: copyRegionEndpointOutputSchema,
    destination: copyRegionEndpointOutputSchema,
    scannedCellCount: positiveIntegerOutputSchema,
    cellCount: positiveIntegerOutputSchema,
    sourceNonEmptyCellCount:
      nonnegativeIntegerOutputSchema,
    changedCellCount:
      nonnegativeIntegerOutputSchema,
    overwrittenNonEmptyCellCount:
      nonnegativeIntegerOutputSchema,
    clearedCellCount:
      nonnegativeIntegerOutputSchema,
    overlapsSource: z.boolean(),
    wouldChange: z.boolean(),
  })
  .strict();

const addedTilesetSummaryOutputSchema = z
  .object({
    tilesetPath: projectPathOutputSchema,
    source: z.string().min(1),
    assetId: assetIdOutputSchema,
    tilesetRevision: revisionOutputSchema,
    tileCount: positiveIntegerOutputSchema,
    gidSpan: positiveIntegerOutputSchema,
    firstGid: positiveIntegerOutputSchema,
  })
  .strict();

const nonImageCreatedLayerSummaryOutputSchema = z
  .object({
    layerId: positiveIdOutputSchema,
    layerType: nonImageLayerTypeOutputSchema,
    name: z.string(),
    parentGroupId:
      positiveIdOutputSchema.nullable(),
    index: nonnegativeIntegerOutputSchema,
    allocatedCellCount:
      nonnegativeIntegerOutputSchema,
  })
  .strict();

const imageCreatedLayerSummaryOutputSchema = z
  .object({
    layerId: positiveIdOutputSchema,
    layerType: z.literal("imagelayer"),
    name: z.string(),
    parentGroupId:
      positiveIdOutputSchema.nullable(),
    index: nonnegativeIntegerOutputSchema,
    allocatedCellCount:
      nonnegativeIntegerOutputSchema,
    image: imageDependencyOutputSchema,
  })
  .strict();

const mapEditSummaryBaseShape = {
  operationCount: positiveIntegerOutputSchema,
  cellWrites: nonnegativeIntegerOutputSchema,
  affectedLayerIds: z.array(
    positiveIdOutputSchema,
  ),
  affectedTileLayerIds: z.array(
    positiveIdOutputSchema,
  ),
  chunkedTileLayerIds: z
    .array(positiveIdOutputSchema)
    .optional(),
  transcodes: z
    .array(
      z
        .object({
          operationIndex:
            nonnegativeIntegerOutputSchema,
          layerId: positiveIdOutputSchema,
          fromEncoding: z.enum([
            "csv",
            "base64",
          ]),
          fromCompression: z.enum([
            "",
            "gzip",
            "zlib",
            "zstd",
          ]),
          toEncoding: z.enum(["csv", "base64"]),
          toCompression: z.enum([
            "",
            "gzip",
            "zlib",
            "zstd",
          ]),
          cellCount:
            positiveIntegerOutputSchema,
          wouldChange: z.boolean(),
        })
        .strict(),
    )
    .max(1)
    .optional(),
  affectedObjectLayerIds: z.array(
    positiveIdOutputSchema,
  ),
  createdObjectIds: z.array(
    positiveIdOutputSchema,
  ),
  updatedObjectIds: z.array(
    positiveIdOutputSchema,
  ),
  deletedObjectIds: z.array(
    positiveIdOutputSchema,
  ),
} as const;

const genericSummaryOptionalShape = {
  mapUpdates: z
    .array(mapUpdateSummaryOutputSchema)
    .min(1)
    .optional(),
  mapResizes: z
    .array(mapResizeSummaryOutputSchema)
    .min(1)
    .optional(),
  removedTilesets: z
    .array(removedTilesetSummaryOutputSchema)
    .min(1)
    .optional(),
  deletedLayers: z
    .array(deletedLayerSummaryOutputSchema)
    .min(1)
    .optional(),
  movedLayers: z
    .array(movedLayerSummaryOutputSchema)
    .min(1)
    .optional(),
  duplicatedLayers: z
    .array(duplicatedLayerSummaryOutputSchema)
    .min(1)
    .optional(),
  tileReplacements: z
    .array(tileReplacementSummaryOutputSchema)
    .min(1)
    .optional(),
  tileStamps: z
    .array(tileStampSummaryOutputSchema)
    .min(1)
    .optional(),
  tileFloodFills: z
    .array(tileFloodFillSummaryOutputSchema)
    .min(1)
    .optional(),
  tileCopies: z
    .array(tileCopySummaryOutputSchema)
    .min(1)
    .optional(),
} as const;

const genericMapEditSummaryWithoutLayerUpdatesOutputSchema =
  z
    .object({
      ...mapEditSummaryBaseShape,
      ...genericSummaryOptionalShape,
    })
    .strict();

const genericMapEditSummaryWithLayerUpdatesOutputSchema =
  z
    .object({
      ...mapEditSummaryBaseShape,
      ...genericSummaryOptionalShape,
      updatedLayerIds: z
        .array(positiveIdOutputSchema),
      layerUpdates: z
        .array(layerUpdateSummaryOutputSchema)
        .min(1),
    })
    .strict();

const genericMapEditSummaryOutputSchema = z.union([
  genericMapEditSummaryWithoutLayerUpdatesOutputSchema,
  genericMapEditSummaryWithLayerUpdatesOutputSchema,
]);

const addTilesetSummaryOutputSchema = z
  .object({
    operationCount: z.literal(1),
    cellWrites: z.literal(0),
    affectedLayerIds: z.tuple([]),
    affectedTileLayerIds: z.tuple([]),
    affectedObjectLayerIds: z.tuple([]),
    createdObjectIds: z.tuple([]),
    updatedObjectIds: z.tuple([]),
    deletedObjectIds: z.tuple([]),
    addedTilesets: z.tuple([
      addedTilesetSummaryOutputSchema,
    ]),
  })
  .strict();

const nonImageCreateLayerSummaryOutputSchema = z
  .object({
    operationCount: z.literal(1),
    cellWrites: nonnegativeIntegerOutputSchema,
    affectedLayerIds: z
      .array(positiveIdOutputSchema)
      .length(1),
    affectedTileLayerIds: z.tuple([]),
    affectedObjectLayerIds: z.tuple([]),
    createdObjectIds: z.tuple([]),
    updatedObjectIds: z.tuple([]),
    deletedObjectIds: z.tuple([]),
    createdLayers: z.tuple([
      nonImageCreatedLayerSummaryOutputSchema,
    ]),
  })
  .strict();

const imageCreateLayerSummaryOutputSchema = z
  .object({
    operationCount: z.literal(1),
    cellWrites: z.literal(0),
    affectedLayerIds: z
      .array(positiveIdOutputSchema)
      .length(1),
    affectedTileLayerIds: z.tuple([]),
    affectedObjectLayerIds: z.tuple([]),
    createdObjectIds: z.tuple([]),
    updatedObjectIds: z.tuple([]),
    deletedObjectIds: z.tuple([]),
    createdLayers: z.tuple([
      imageCreatedLayerSummaryOutputSchema,
    ]),
  })
  .strict();

const mapEditPreviewCommonShape = {
  kind: z.literal("mapEdit"),
  changeSetId: changeSetIdOutputSchema,
  planDigest: changeSetIdOutputSchema,
  mapPath: projectPathOutputSchema,
  expectedRevision: revisionOutputSchema,
  dependencyRevisions:
    dependencyRevisionsOutputSchema,
  snapshotConsistency: z.literal(
    "non-atomic-read-set",
  ),
  createdAt: isoTimestampOutputSchema,
  expiresAt: isoTimestampOutputSchema,
} as const;

const genericMapEditPreviewOutputSchema = z
  .object({
    ...mapEditPreviewCommonShape,
    operations: z
      .array(genericOperationPreviewOutputSchema)
      .min(1)
      .max(128)
      .superRefine((operations, context) => {
        let pathPointCount = 0;
        let textObjectPayloadBytes = 0;
        for (const operation of operations) {
          if (
            operation.type === "createObject" &&
            (operation.shape === "polygon" ||
              operation.shape === "polyline")
          ) {
            pathPointCount +=
              operation.object.points.length;
          } else if (
            operation.type === "updateObject" &&
            operation.patch.points !== undefined
          ) {
            pathPointCount +=
              operation.patch.points.length;
          }
          if (operation.type === "createObject") {
            try {
              textObjectPayloadBytes +=
                measureTextObjectPayloadBytes(
                  operation.object,
                );
            } catch {
              // Nested schemas report invalid text fields.
            }
          } else if (
            operation.type === "updateObject"
          ) {
            try {
              textObjectPayloadBytes +=
                measureTextObjectPayloadBytes(
                  operation.patch,
                );
            } catch {
              // Nested schemas report invalid text fields.
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
              `Polygon and polyline create and update previews may contain at most ${MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET} total points per change set`,
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
      }),
    summary: genericMapEditSummaryOutputSchema,
  })
  .strict();

const addTilesetMapEditPreviewOutputSchema = z
  .object({
    ...mapEditPreviewCommonShape,
    prospectiveDependencyRevisions:
      dependencyRevisionsOutputSchema,
    operations: z.tuple([
      addTilesetOperationPreviewOutputSchema,
    ]),
    summary: addTilesetSummaryOutputSchema,
  })
  .strict();

const nonImageCreateLayerMapEditPreviewOutputSchema =
  z
    .object({
      ...mapEditPreviewCommonShape,
      operations: z.tuple([
        nonImageCreateLayerOperationPreviewOutputSchema,
      ]),
      summary:
        nonImageCreateLayerSummaryOutputSchema,
    })
    .strict();

const imageCreateLayerMapEditPreviewOutputSchema = z
  .object({
    ...mapEditPreviewCommonShape,
    prospectiveDependencyRevisions:
      dependencyRevisionsOutputSchema,
    operations: z.tuple([
      imageCreateLayerOperationPreviewOutputSchema,
    ]),
    summary: imageCreateLayerSummaryOutputSchema,
  })
  .strict();

const checkpointRestoreSummaryOutputSchema = z
  .object({
    operationCount: z.literal(1),
    destructive: z.literal(true),
    checkpointId: checkpointIdOutputSchema,
    targetPath: projectPathOutputSchema,
    currentRevision:
      revisionOutputSchema.nullable(),
    restoreRevision: revisionOutputSchema,
    restoreBytes: nonnegativeIntegerOutputSchema,
    wouldChange: z.boolean(),
    warning: z.string(),
  })
  .strict();

const checkpointRestorePreviewOutputSchema = z
  .object({
    kind: z.literal("checkpointRestore"),
    changeSetId: changeSetIdOutputSchema,
    planDigest: changeSetIdOutputSchema,
    targetPath: projectPathOutputSchema,
    expectedRevision: revisionOutputSchema,
    checkpoint: z
      .object({
        id: checkpointIdOutputSchema,
        status: z.enum([
          "prepared",
          "committed",
        ]),
        label: z.string(),
        createdAt:
          checkpointTimestampOutputSchema,
        afterRevision: revisionOutputSchema,
      })
      .strict(),
    restore: z
      .object({
        revision: revisionOutputSchema,
        size: nonnegativeIntegerOutputSchema,
        exactBytes: z.literal(true),
        wouldChange: z.boolean(),
      })
      .strict(),
    operations: z.tuple([
      restoreCheckpointOperationPreviewOutputSchema,
    ]),
    summary:
      checkpointRestoreSummaryOutputSchema,
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    createdAt: isoTimestampOutputSchema,
    expiresAt: isoTimestampOutputSchema,
  })
  .strict();

const checkpointPruneBeforeOutputSchema = z.union([
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
      size: nonnegativeIntegerOutputSchema.max(
        Number.MAX_SAFE_INTEGER,
      ),
    })
    .strict()
    .superRefine((before, context) => {
      if (
        before.revision !==
        `sha256:${before.objectHash}`
      ) {
        context.addIssue({
          code: "custom",
          path: ["revision"],
          message:
            "A checkpoint before revision must match its content-addressed object hash.",
        });
      }
    }),
]);

const checkpointPruneSummaryOutputSchema = z
  .object({
    operationCount: z.literal(1),
    destructive: z.literal(true),
    checkpointId: checkpointIdOutputSchema,
    targetPath: projectPathOutputSchema,
    status: z.literal("committed"),
    manifestRevision: revisionOutputSchema,
    manifestBytes:
      positiveIntegerOutputSchema.max(
        Number.MAX_SAFE_INTEGER,
      ),
    removesRecoveryPoint: z.literal(true),
    removesProjectAsset: z.literal(false),
    garbageCollection: z.literal(
      "fail-closed-after-manifest-prune",
    ),
    warning: z.string(),
  })
  .strict();

const checkpointPrunePreviewOutputSchema = z
  .object({
    kind: z.literal("checkpointPrune"),
    changeSetId: changeSetIdOutputSchema,
    planDigest: changeSetIdOutputSchema,
    targetPath: projectPathOutputSchema,
    expectedRevision: revisionOutputSchema,
    checkpoint: z
      .object({
        id: checkpointIdOutputSchema,
        status: z.literal("committed"),
        label: z
          .string()
          .max(1_024)
          .optional(),
        createdAt:
          checkpointTimestampOutputSchema,
        path: projectPathOutputSchema,
        before:
          checkpointPruneBeforeOutputSchema,
        afterRevision: revisionOutputSchema,
      })
      .strict(),
    manifest: z
      .object({
        revision: revisionOutputSchema,
        size: positiveIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      })
      .strict(),
    operations: z.tuple([
      pruneCheckpointOperationPreviewOutputSchema,
    ]),
    summary:
      checkpointPruneSummaryOutputSchema,
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    createdAt: isoTimestampOutputSchema,
    expiresAt: isoTimestampOutputSchema,
  })
  .strict();

const checkpointPruneBatchSummaryOutputSchema =
  z
    .object({
      operationCount: z.literal(1),
      checkpointCount:
        positiveIntegerOutputSchema
          .min(
            MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
          )
          .max(
            MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
          ),
      destructive: z.literal(true),
      checkpointIds: z
        .array(checkpointIdOutputSchema)
        .min(
          MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
        )
        .max(
          MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
        ),
      targetCount:
        positiveIntegerOutputSchema.max(
          MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
        ),
      targetPaths: z
        .array(projectPathOutputSchema)
        .min(1)
        .max(
          MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
        ),
      status: z.literal("committed"),
      manifestBytes:
        positiveIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      removesRecoveryPointCount:
        positiveIntegerOutputSchema
          .min(
            MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
          )
          .max(
            MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
          ),
      removesProjectAssets: z.literal(false),
      ordering: z.literal(
        "canonical-checkpoint-id",
      ),
      atomic: z.literal(false),
      stopOnFirstFailure: z.literal(true),
      partialResult: z.literal(
        "cached-final-no-resume",
      ),
      garbageCollection: z.literal(
        "once-after-all-manifests-fail-closed",
      ),
      warning: z.string(),
    })
    .strict();

const checkpointPruneBatchCheckpointBaseOutputShape =
  {
    id: checkpointIdOutputSchema,
    status: z.literal("committed"),
    label: z
      .string()
      .max(1_024)
      .optional(),
    createdAt:
      checkpointTimestampOutputSchema,
    path: projectPathOutputSchema,
    before: checkpointPruneBeforeOutputSchema,
    afterRevision: revisionOutputSchema,
    manifest: z
      .object({
        revision: revisionOutputSchema,
        size: positiveIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      })
      .strict(),
  };

const checkpointPruneBatchCheckpointOutputSchema =
  z.union([
    z
      .object({
        ...checkpointPruneBatchCheckpointBaseOutputShape,
        version: z.literal(1),
      })
      .strict(),
    z
      .object({
        ...checkpointPruneBatchCheckpointBaseOutputShape,
        version: z.literal(2),
        retention: z.union([
          z
            .object({
              class: z.literal(
                "protected",
              ),
            })
            .strict(),
          z
            .object({
              class:
                z.literal("rolling"),
              ordinal:
                positiveIntegerOutputSchema.max(
                  Number.MAX_SAFE_INTEGER,
                ),
            })
            .strict(),
        ]),
      })
      .strict(),
  ]);

const checkpointPruneBatchPreviewOutputSchema =
  z
    .object({
      kind: z.literal(
        "checkpointPruneBatch",
      ),
      changeSetId: changeSetIdOutputSchema,
      planDigest: changeSetIdOutputSchema,
      targetPaths: z
        .array(projectPathOutputSchema)
        .min(1)
        .max(
          MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
        ),
      expectedRevision: revisionOutputSchema,
      checkpoints: z
        .array(
          checkpointPruneBatchCheckpointOutputSchema,
        )
        .min(
          MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
        )
        .max(
          MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
        ),
      operations: z.tuple([
        pruneCheckpointBatchOperationPreviewOutputSchema,
      ]),
      summary:
        checkpointPruneBatchSummaryOutputSchema,
      snapshotConsistency: z.literal(
        "checkpoint-store-locked-manifest-set",
      ),
      createdAt: isoTimestampOutputSchema,
      expiresAt: isoTimestampOutputSchema,
    })
    .strict()
    .superRefine(
      (
        preview,
        context,
      ) => {
        const checkpointIds =
          preview.checkpoints.map(
            ({ id }) => id,
          );
        const canonicalCheckpointIds = [
          ...checkpointIds,
        ].sort(compareCheckpointPruneBatchStrings);
        if (
          !sameCheckpointPruneBatchStrings(
            checkpointIds,
            canonicalCheckpointIds,
          ) ||
          new Set(checkpointIds).size !==
            checkpointIds.length
        ) {
          context.addIssue({
            code: "custom",
            path: ["checkpoints"],
            message:
              "Checkpoint prune batch checkpoints must be in unique canonical checkpoint-ID order.",
          });
          return;
        }

        const targetPaths = [
          ...new Set(
            preview.checkpoints.map(
              ({ path }) => path,
            ),
          ),
        ].sort(compareCheckpointPruneBatchStrings);
        let manifestBytes = 0;
        for (const checkpoint of preview.checkpoints) {
          manifestBytes +=
            checkpoint.manifest.size;
          if (
            !Number.isSafeInteger(
              manifestBytes,
            )
          ) {
            context.addIssue({
              code: "custom",
              path: ["checkpoints"],
              message:
                "Checkpoint prune batch manifest bytes must have a safe-integer total.",
            });
            return;
          }
        }

        const summary = preview.summary;
        const operation =
          preview.operations[0];
        const checkpointCount =
          preview.checkpoints.length;
        if (
          !sameCheckpointPruneBatchStrings(
            preview.targetPaths,
            targetPaths,
          ) ||
          summary.checkpointCount !==
            checkpointCount ||
          !sameCheckpointPruneBatchStrings(
            summary.checkpointIds,
            checkpointIds,
          ) ||
          summary.targetCount !==
            targetPaths.length ||
          !sameCheckpointPruneBatchStrings(
            summary.targetPaths,
            targetPaths,
          ) ||
          summary.manifestBytes !==
            manifestBytes ||
          summary.removesRecoveryPointCount !==
            checkpointCount ||
          operation.checkpointCount !==
            checkpointCount ||
          !sameCheckpointPruneBatchStrings(
            operation.checkpointIds,
            checkpointIds,
          ) ||
          operation.targetCount !==
            targetPaths.length ||
          !sameCheckpointPruneBatchStrings(
            operation.targetPaths,
            targetPaths,
          ) ||
          operation.manifestBytes !==
            manifestBytes ||
          operation.removesRecoveryPointCount !==
            checkpointCount ||
          operation.warning !==
            summary.warning
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Checkpoint prune batch checkpoints, targets, summary, and operation must agree.",
          });
        }
      },
    );

function compareCheckpointPruneBatchStrings(
  left: string,
  right: string,
): number {
  return left < right
    ? -1
    : left > right
      ? 1
      : 0;
}

function sameCheckpointPruneBatchStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value === right[index],
    )
  );
}

const preparedCheckpointAdjudicationConflictOutputSchema =
  z.enum([
    "create-target-matches-after",
    "create-target-unrelated",
    "existing-target-missing",
    "existing-target-unrelated",
  ]);

const preparedCheckpointAdjudicationTargetOutputSchema =
  z.union([
    z
      .object({
        existed: z.literal(false),
      })
      .strict(),
    z
      .object({
        existed: z.literal(true),
        revision: revisionOutputSchema,
        size: nonnegativeIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      })
      .strict(),
  ]);

const preparedCheckpointAdjudicationCheckpointBaseOutputShape =
  {
    id: checkpointIdOutputSchema,
    status: z.literal("prepared"),
    label: z
      .string()
      .max(1_024)
      .optional(),
    createdAt:
      checkpointTimestampOutputSchema,
    path: projectPathOutputSchema,
    before: checkpointPruneBeforeOutputSchema,
    afterRevision: revisionOutputSchema,
  };

const preparedCheckpointAdjudicationCheckpointOutputSchema =
  z.union([
    z
      .object({
        ...preparedCheckpointAdjudicationCheckpointBaseOutputShape,
        version: z.literal(1),
      })
      .strict(),
    z
      .object({
        ...preparedCheckpointAdjudicationCheckpointBaseOutputShape,
        version: z.literal(2),
        retention: z.union([
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
        ]),
      })
      .strict(),
  ]);

const preparedCheckpointCommitSummaryOutputSchema =
  z
    .object({
      operationCount: z.literal(1),
      destructive: z.literal(false),
      checkpointId: checkpointIdOutputSchema,
      targetPath: projectPathOutputSchema,
      status: z.literal("prepared"),
      manifestRevision:
        revisionOutputSchema,
      manifestBytes:
        positiveIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      operatorDecisionRequired:
        z.literal(true),
      commitsCheckpointRecord: z.literal(true),
      projectAssetModified: z.literal(false),
      garbageCollection: z.literal(
        "not-run",
      ),
      warning: z.string(),
    })
    .strict();

const preparedCheckpointAbandonSummaryOutputSchema =
  z
    .object({
      operationCount: z.literal(1),
      destructive: z.literal(true),
      checkpointId: checkpointIdOutputSchema,
      targetPath: projectPathOutputSchema,
      status: z.literal("prepared"),
      manifestRevision:
        revisionOutputSchema,
      manifestBytes:
        positiveIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      operatorDecisionRequired:
        z.literal(true),
      removesRecoveryPoint: z.literal(true),
      projectAssetModified: z.literal(false),
      garbageCollection: z.literal(
        "fail-closed-after-prepared-manifest-abandon",
      ),
      warning: z.string(),
    })
    .strict();

const preparedCheckpointAdjudicationPreviewCommonShape =
  {
    changeSetId: changeSetIdOutputSchema,
    planDigest: changeSetIdOutputSchema,
    targetPath: projectPathOutputSchema,
    expectedRevision: revisionOutputSchema,
    checkpoint:
      preparedCheckpointAdjudicationCheckpointOutputSchema,
    manifest: z
      .object({
        revision: revisionOutputSchema,
        size: positiveIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      })
      .strict(),
    target:
      preparedCheckpointAdjudicationTargetOutputSchema,
    conflict:
      preparedCheckpointAdjudicationConflictOutputSchema,
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    createdAt: isoTimestampOutputSchema,
    expiresAt: isoTimestampOutputSchema,
  };

const preparedCheckpointCommitPreviewOutputSchema =
  z
    .object({
      ...preparedCheckpointAdjudicationPreviewCommonShape,
      kind: z.literal(
        "preparedCheckpointCommit",
      ),
      conflict: z.literal(
        "create-target-matches-after",
      ),
      target: z
        .object({
          existed: z.literal(true),
          revision: revisionOutputSchema,
          size: nonnegativeIntegerOutputSchema.max(
            Number.MAX_SAFE_INTEGER,
          ),
        })
        .strict(),
      operations: z.tuple([
        commitPreparedCheckpointOperationPreviewOutputSchema,
      ]),
      summary:
        preparedCheckpointCommitSummaryOutputSchema,
    })
    .strict()
    .superRefine((preview, context) => {
      const operation = preview.operations[0];
      if (
        preview.checkpoint.before.existed !==
          false ||
        preview.target.revision !==
          preview.checkpoint.afterRevision ||
        !preparedCheckpointAdjudicationPreviewFieldsAgree(
          preview,
          operation,
          preview.summary,
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Prepared checkpoint commit evidence, summary, and operation must agree.",
        });
      }
    });

const preparedCheckpointAbandonPreviewOutputSchema =
  z
    .object({
      ...preparedCheckpointAdjudicationPreviewCommonShape,
      kind: z.literal(
        "preparedCheckpointAbandon",
      ),
      operations: z.tuple([
        abandonPreparedCheckpointOperationPreviewOutputSchema,
      ]),
      summary:
        preparedCheckpointAbandonSummaryOutputSchema,
    })
    .strict()
    .superRefine((preview, context) => {
      const { checkpoint, target } = preview;
      const conflictMatches =
        preview.conflict ===
        "create-target-matches-after"
          ? checkpoint.before.existed ===
              false &&
            target.existed === true &&
            target.revision ===
              checkpoint.afterRevision
          : preview.conflict ===
              "create-target-unrelated"
            ? checkpoint.before.existed ===
                false &&
              target.existed === true &&
              target.revision !==
                checkpoint.afterRevision
            : preview.conflict ===
                "existing-target-missing"
              ? checkpoint.before.existed ===
                  true &&
                target.existed === false
              : checkpoint.before.existed ===
                  true &&
                target.existed === true &&
                target.revision !==
                  checkpoint.before.revision &&
                target.revision !==
                  checkpoint.afterRevision;
      if (
        !conflictMatches ||
        !preparedCheckpointAdjudicationPreviewFieldsAgree(
          preview,
          preview.operations[0],
          preview.summary,
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Prepared checkpoint abandon evidence, summary, and operation must agree.",
        });
      }
    });

function preparedCheckpointAdjudicationPreviewFieldsAgree(
  preview: {
    targetPath: string;
    checkpoint: {
      id: string;
      path: string;
    };
    manifest: {
      revision: string;
      size: number;
    };
  },
  operation: {
    checkpointId: string;
    targetPath: string;
    manifestRevision: string;
    manifestBytes: number;
    warning: string;
  },
  summary: {
    checkpointId: string;
    targetPath: string;
    manifestRevision: string;
    manifestBytes: number;
    warning: string;
  },
): boolean {
  return (
    preview.targetPath ===
      preview.checkpoint.path &&
    operation.checkpointId ===
      preview.checkpoint.id &&
    summary.checkpointId ===
      preview.checkpoint.id &&
    operation.targetPath ===
      preview.targetPath &&
    summary.targetPath ===
      preview.targetPath &&
    operation.manifestRevision ===
      preview.manifest.revision &&
    summary.manifestRevision ===
      preview.manifest.revision &&
    operation.manifestBytes ===
      preview.manifest.size &&
    summary.manifestBytes ===
      preview.manifest.size &&
    operation.warning === summary.warning
  );
}

const preparedCheckpointDiscardTargetOutputSchema =
  z.union([
    z
      .object({
        existed: z.literal(false),
      })
      .strict(),
    z
      .object({
        existed: z.literal(true),
        revision: revisionOutputSchema,
        size: nonnegativeIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      })
      .strict(),
  ]);

const preparedCheckpointDiscardSummaryOutputSchema =
  z
    .object({
      operationCount: z.literal(1),
      destructive: z.literal(true),
      checkpointId: checkpointIdOutputSchema,
      targetPath: projectPathOutputSchema,
      status: z.literal("prepared"),
      manifestRevision:
        revisionOutputSchema,
      manifestBytes:
        positiveIntegerOutputSchema.max(
          Number.MAX_SAFE_INTEGER,
        ),
      removesRecoveryPoint: z.literal(true),
      removesProjectAsset: z.literal(false),
      targetBeforeStateVerified:
        z.literal(true),
      garbageCollection: z.literal(
        "fail-closed-after-prepared-manifest-discard",
      ),
      warning: z.string(),
    })
    .strict();

const preparedCheckpointDiscardPreviewOutputSchema =
  z
    .object({
      kind: z.literal(
        "preparedCheckpointDiscard",
      ),
      changeSetId: changeSetIdOutputSchema,
      planDigest: changeSetIdOutputSchema,
      targetPath: projectPathOutputSchema,
      expectedRevision: revisionOutputSchema,
      checkpoint: z
        .object({
          id: checkpointIdOutputSchema,
          status: z.literal("prepared"),
          label: z
            .string()
            .max(1_024)
            .optional(),
          createdAt:
            checkpointTimestampOutputSchema,
          path: projectPathOutputSchema,
          before:
            checkpointPruneBeforeOutputSchema,
          afterRevision:
            revisionOutputSchema,
        })
        .strict(),
      manifest: z
        .object({
          revision: revisionOutputSchema,
          size: positiveIntegerOutputSchema.max(
            Number.MAX_SAFE_INTEGER,
          ),
        })
        .strict(),
      target:
        preparedCheckpointDiscardTargetOutputSchema,
      eligibility: z.literal(
        "current-target-matches-before-state",
      ),
      operations: z.tuple([
        discardPreparedCheckpointOperationPreviewOutputSchema,
      ]),
      summary:
        preparedCheckpointDiscardSummaryOutputSchema,
      snapshotConsistency: z.literal(
        "non-atomic-read-set",
      ),
      createdAt: isoTimestampOutputSchema,
      expiresAt: isoTimestampOutputSchema,
    })
    .strict();

export const checkpointRestorePreviewToolOutputSchema =
  toolOutputSchema(
    checkpointRestorePreviewOutputSchema,
  );

export const checkpointPrunePreviewToolOutputSchema =
  toolOutputSchema(
    checkpointPrunePreviewOutputSchema,
  );

export const checkpointPruneBatchPreviewToolOutputSchema =
  toolOutputSchema(
    checkpointPruneBatchPreviewOutputSchema,
  );

export const preparedCheckpointDiscardPreviewToolOutputSchema =
  toolOutputSchema(
    preparedCheckpointDiscardPreviewOutputSchema,
  );

export const preparedCheckpointCommitPreviewToolOutputSchema =
  toolOutputSchema(
    preparedCheckpointCommitPreviewOutputSchema,
  );

export const preparedCheckpointAbandonPreviewToolOutputSchema =
  toolOutputSchema(
    preparedCheckpointAbandonPreviewOutputSchema,
  );

export const addTilesetPreviewToolOutputSchema =
  toolOutputSchema(
    addTilesetMapEditPreviewOutputSchema,
  );

const tilePatchFieldOutputSchema = z.enum([
  "probability",
  "className",
  "animation",
  "collision",
  "properties",
  "createCollectionTile",
  "removeCollectionTile",
]);
const tileEntryActionOutputSchema = z.enum([
  "insert",
  "update",
  "remove",
  "none",
]);
const tileUpdateAccountingShape = {
  tileId: nonnegativeIntegerOutputSchema.max(
    0x0fffffff,
  ),
  entryAction: tileEntryActionOutputSchema,
  requestedFields: z
    .array(tilePatchFieldOutputSchema)
    .min(1)
    .max(5),
  changedFields: z
    .array(tilePatchFieldOutputSchema)
    .max(5),
  wouldChange: z.boolean(),
  previousAnimationFrameCount:
    nonnegativeIntegerOutputSchema.optional(),
  newAnimationFrameCount:
    nonnegativeIntegerOutputSchema
      .max(MAX_TILE_ANIMATION_FRAMES_PER_TILE)
      .optional(),
  propertiesSet: nonnegativeIntegerOutputSchema
    .max(MAX_TILE_PROPERTY_SETS_PER_TILE)
    .optional(),
  propertiesRemoved:
    nonnegativeIntegerOutputSchema
      .max(MAX_TILE_PROPERTY_REMOVES_PER_TILE)
      .optional(),
  previousCollisionShapeCount:
    nonnegativeIntegerOutputSchema.optional(),
  collisionShapeCount:
    nonnegativeIntegerOutputSchema
      .max(MAX_TILE_COLLISION_SHAPES_PER_TILE)
      .optional(),
} as const;

const updateTileOperationPreviewOutputSchema = z
  .object({
    type: z.literal("updateTile"),
    destructive: z.boolean(),
    warning: z.string(),
    ...tileUpdateAccountingShape,
  })
  .strict();

const collectionStructureSummaryOutputSchema = z
  .object({
    action: z.enum(["create", "remove"]),
    tileId: nonnegativeIntegerOutputSchema,
    tileCountBefore:
      positiveIntegerOutputSchema,
    tileCountAfter: positiveIntegerOutputSchema,
    tileSizeBefore: z
      .object({
        width: positiveIntegerOutputSchema,
        height: positiveIntegerOutputSchema,
      })
      .strict(),
    tileSizeAfter: z
      .object({
        width: positiveIntegerOutputSchema,
        height: positiveIntegerOutputSchema,
      })
      .strict(),
  })
  .strict();

const tileUpdateSummaryOutputSchema = z
  .object({
    updateIndex: nonnegativeIntegerOutputSchema.max(
      MAX_TILE_UPDATES_PER_CHANGE_SET - 1,
    ),
    ...tileUpdateAccountingShape,
  })
  .strict();

const tilesetEditSummaryOutputSchema = z
  .object({
    updateCount: positiveIntegerOutputSchema.max(
      MAX_TILE_UPDATES_PER_CHANGE_SET,
    ),
    tileUpdates: z
      .array(tileUpdateSummaryOutputSchema)
      .min(1)
      .max(MAX_TILE_UPDATES_PER_CHANGE_SET),
    tilesMemberAction: z.enum([
      "insert",
      "keep",
      "remove",
      "none",
    ]),
    collectionStructure:
      collectionStructureSummaryOutputSchema.optional(),
    wouldChange: z.boolean(),
  })
  .strict();

const tilesetEditPreviewOutputSchema = z
  .object({
    kind: z.literal("tilesetEdit"),
    changeSetId: changeSetIdOutputSchema,
    planDigest: changeSetIdOutputSchema,
    mapPath: projectPathOutputSchema,
    tilesetPath: projectPathOutputSchema,
    assetId: assetIdOutputSchema,
    expectedRevision: revisionOutputSchema,
    mapRevision: revisionOutputSchema,
    operations: z
      .array(updateTileOperationPreviewOutputSchema)
      .min(1)
      .max(MAX_TILE_UPDATES_PER_CHANGE_SET),
    summary: tilesetEditSummaryOutputSchema,
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    createdAt: isoTimestampOutputSchema,
    expiresAt: isoTimestampOutputSchema,
  })
  .strict();

const embeddedTilesetEditPreviewOutputSchema = z
  .object({
    kind: z.literal("embeddedTilesetEdit"),
    changeSetId: changeSetIdOutputSchema,
    planDigest: changeSetIdOutputSchema,
    mapPath: projectPathOutputSchema,
    embeddedIndex:
      nonnegativeIntegerOutputSchema,
    expectedRevision: revisionOutputSchema,
    operations: z
      .array(updateTileOperationPreviewOutputSchema)
      .min(1)
      .max(MAX_TILE_UPDATES_PER_CHANGE_SET),
    summary: tilesetEditSummaryOutputSchema,
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    createdAt: isoTimestampOutputSchema,
    expiresAt: isoTimestampOutputSchema,
  })
  .strict();

export const updateTilePreviewToolOutputSchema =
  toolOutputSchema(
    z.union([
      tilesetEditPreviewOutputSchema,
      embeddedTilesetEditPreviewOutputSchema,
    ]),
  );

const tilesetCreateNameOutputSchema = z
  .string()
  .min(1)
  .max(MAX_CREATE_TILESET_NAME_CODE_POINTS * 2);

const tilesetCreateImageOutputSchema = z
  .object({
    path: projectPathOutputSchema,
    source: z.string().min(1),
    revision: revisionOutputSchema,
    width: positiveIntegerOutputSchema,
    height: positiveIntegerOutputSchema,
  })
  .strict();

const tilesetCreateGridShape = {
  name: tilesetCreateNameOutputSchema,
  className:
    tilesetCreateNameOutputSchema.nullable(),
  tileWidth: positiveIntegerOutputSchema.max(
    MAX_CREATE_TILESET_TILE_EDGE,
  ),
  tileHeight: positiveIntegerOutputSchema.max(
    MAX_CREATE_TILESET_TILE_EDGE,
  ),
  margin: nonnegativeIntegerOutputSchema.max(
    MAX_CREATE_TILESET_MARGIN,
  ),
  spacing: nonnegativeIntegerOutputSchema.max(
    MAX_CREATE_TILESET_SPACING,
  ),
} as const;

const tilesetCreateSummaryOutputSchema = z
  .object({
    tilesetPath: projectPathOutputSchema,
    ...tilesetCreateGridShape,
    columns: positiveIntegerOutputSchema,
    rows: positiveIntegerOutputSchema,
    tileCount: positiveIntegerOutputSchema,
    imageWidth: positiveIntegerOutputSchema,
    imageHeight: positiveIntegerOutputSchema,
    unusedRightPixels:
      nonnegativeIntegerOutputSchema,
    unusedBottomPixels:
      nonnegativeIntegerOutputSchema,
    contentBytes: positiveIntegerOutputSchema,
    wouldChange: z.literal(true),
  })
  .strict();

const createTilesetOperationPreviewOutputSchema =
  z
    .object({
      type: z.literal("createTileset"),
      destructive: z.literal(false),
      warning: z.string(),
      tilesetPath: projectPathOutputSchema,
      ...tilesetCreateGridShape,
      columns: positiveIntegerOutputSchema,
      rows: positiveIntegerOutputSchema,
      tileCount: positiveIntegerOutputSchema,
      contentRevision: revisionOutputSchema,
      image: tilesetCreateImageOutputSchema,
    })
    .strict();

const tilesetCreatePreviewOutputSchema = z
  .object({
    kind: z.literal("tilesetCreate"),
    changeSetId: changeSetIdOutputSchema,
    planDigest: changeSetIdOutputSchema,
    tilesetPath: projectPathOutputSchema,
    expectedRevision: revisionOutputSchema,
    image: tilesetCreateImageOutputSchema,
    operations: z
      .array(
        createTilesetOperationPreviewOutputSchema,
      )
      .length(1),
    summary: tilesetCreateSummaryOutputSchema,
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    createdAt: isoTimestampOutputSchema,
    expiresAt: isoTimestampOutputSchema,
  })
  .strict();

export const createTilesetPreviewToolOutputSchema =
  toolOutputSchema(
    tilesetCreatePreviewOutputSchema,
  );

const fileDeleteScanOutputSchema = z
  .object({
    scannedMaps: nonnegativeIntegerOutputSchema,
    scannedWorlds:
      nonnegativeIntegerOutputSchema,
    scannedTemplates:
      nonnegativeIntegerOutputSchema,
    scannedBytes:
      nonnegativeIntegerOutputSchema,
  })
  .strict();

const fileDeleteTargetKindOutputSchema = z.enum([
  "map",
  "tileset",
]);

const fileDeleteSummaryOutputSchema = z
  .object({
    targetPath: projectPathOutputSchema,
    targetKind: fileDeleteTargetKindOutputSchema,
    revision: revisionOutputSchema,
    size: nonnegativeIntegerOutputSchema,
    scan: fileDeleteScanOutputSchema,
    checkpointPolicy: z.literal(
      "committed-before-unlink",
    ),
    wouldChange: z.literal(true),
  })
  .strict();

const deleteFileOperationPreviewOutputSchema = z
  .object({
    type: z.literal("deleteFile"),
    destructive: z.literal(true),
    warning: z.string(),
    targetPath: projectPathOutputSchema,
    targetKind: fileDeleteTargetKindOutputSchema,
    revision: revisionOutputSchema,
    size: nonnegativeIntegerOutputSchema,
    scan: fileDeleteScanOutputSchema,
  })
  .strict();

const fileDeletePreviewOutputSchema = z
  .object({
    kind: z.literal("fileDelete"),
    changeSetId: changeSetIdOutputSchema,
    planDigest: changeSetIdOutputSchema,
    targetPath: projectPathOutputSchema,
    expectedRevision: revisionOutputSchema,
    operations: z
      .array(
        deleteFileOperationPreviewOutputSchema,
      )
      .length(1),
    summary: fileDeleteSummaryOutputSchema,
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    createdAt: isoTimestampOutputSchema,
    expiresAt: isoTimestampOutputSchema,
  })
  .strict();

export const deleteFilePreviewToolOutputSchema =
  toolOutputSchema(
    fileDeletePreviewOutputSchema,
  );

const transactionMemberPlanKindOutputSchema =
  z.enum([
    "mapEdit",
    "tilesetEdit",
    "tilesetCreate",
    "fileDelete",
  ]);

const transactionTargetKindOutputSchema = z.enum([
  "replace",
  "create",
  "delete",
]);

const transactionPlanTargetOutputSchema = z
  .object({
    memberChangeSetId: changeSetIdOutputSchema,
    memberPlanDigest: changeSetIdOutputSchema,
    planKind:
      transactionMemberPlanKindOutputSchema,
    targetKind: transactionTargetKindOutputSchema,
    path: projectPathOutputSchema,
    expectedRevision:
      revisionOutputSchema.nullable(),
  })
  .strict()
  .superRefine((target, context) => {
    if (
      (target.expectedRevision === null) !==
      (target.targetKind === "create")
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedRevision"],
        message:
          "A transaction target pins a revision exactly when it does not create its file.",
      });
    }
  });

const transactionMemberOperationPreviewOutputSchema =
  z
    .object({
      type: z.literal("transactionMember"),
      destructive: z.boolean(),
      warning: z.string(),
      memberChangeSetId: changeSetIdOutputSchema,
      planKind:
        transactionMemberPlanKindOutputSchema,
      targetKind:
        transactionTargetKindOutputSchema,
      path: projectPathOutputSchema,
      expectedRevision:
        revisionOutputSchema.nullable(),
    })
    .strict()
    .superRefine((operation, context) => {
      if (
        operation.destructive !==
        (operation.targetKind === "delete")
      ) {
        context.addIssue({
          code: "custom",
          path: ["destructive"],
          message:
            "A transaction member operation is destructive exactly when it deletes its target.",
        });
      }
    });

const transactionSummaryOutputSchema = z
  .object({
    memberCount: positiveIntegerOutputSchema
      .min(MIN_TRANSACTION_MEMBERS)
      .max(MAX_TRANSACTION_MEMBERS),
    targets: z
      .array(transactionPlanTargetOutputSchema)
      .min(MIN_TRANSACTION_MEMBERS)
      .max(MAX_TRANSACTION_MEMBERS),
    wouldChange: z.literal(true),
  })
  .strict();

const transactionPreviewOutputSchema = z
  .object({
    kind: z.literal("transaction"),
    changeSetId: changeSetIdOutputSchema,
    planDigest: changeSetIdOutputSchema,
    expectedRevision: revisionOutputSchema,
    operations: z
      .array(
        transactionMemberOperationPreviewOutputSchema,
      )
      .min(MIN_TRANSACTION_MEMBERS)
      .max(MAX_TRANSACTION_MEMBERS),
    summary: transactionSummaryOutputSchema,
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    createdAt: isoTimestampOutputSchema,
    expiresAt: isoTimestampOutputSchema,
  })
  .strict()
  .superRefine((preview, context) => {
    if (
      preview.summary.memberCount !==
        preview.operations.length ||
      preview.summary.targets.length !==
        preview.operations.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["summary"],
        message:
          "A transaction preview must describe every member exactly once in both its operations and its summary.",
      });
    }
  });

const worldEditCoordinateOutputSchema = z
  .number()
  .int()
  .min(-1_000_000_000)
  .max(1_000_000_000);

const worldEditOperationPreviewOutputSchema =
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("addWorldMap"),
        destructive: z.literal(false),
        warning: z.string(),
        fileName: z.string().min(1).max(4_096),
        x: worldEditCoordinateOutputSchema,
        y: worldEditCoordinateOutputSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("moveWorldMap"),
        destructive: z.literal(false),
        warning: z.string(),
        index: nonnegativeIntegerOutputSchema,
        fileName: z.string().max(4_096),
        from: z
          .object({
            x: worldEditCoordinateOutputSchema,
            y: worldEditCoordinateOutputSchema,
          })
          .strict(),
        to: z
          .object({
            x: worldEditCoordinateOutputSchema,
            y: worldEditCoordinateOutputSchema,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal("removeWorldMap"),
        destructive: z.literal(true),
        warning: z.string(),
        index: nonnegativeIntegerOutputSchema,
        fileName: z.string().max(4_096),
      })
      .strict(),
  ]);

const worldEditSummaryOutputSchema = z
  .object({
    operationCount: positiveIntegerOutputSchema,
    memberCountBefore:
      nonnegativeIntegerOutputSchema,
    memberCountAfter:
      nonnegativeIntegerOutputSchema,
    added: z
      .array(
        z
          .object({
            index:
              nonnegativeIntegerOutputSchema,
            fileName: z
              .string()
              .min(1)
              .max(4_096),
          })
          .strict(),
      )
      .max(32),
    moved: z
      .array(
        z
          .object({
            index:
              nonnegativeIntegerOutputSchema,
            fileName: z.string().max(4_096),
            from: z
              .object({
                x: worldEditCoordinateOutputSchema,
                y: worldEditCoordinateOutputSchema,
              })
              .strict(),
            to: z
              .object({
                x: worldEditCoordinateOutputSchema,
                y: worldEditCoordinateOutputSchema,
              })
              .strict(),
          })
          .strict(),
      )
      .max(32),
    removed: z
      .array(
        z
          .object({
            index:
              nonnegativeIntegerOutputSchema,
            fileName: z.string().max(4_096),
          })
          .strict(),
      )
      .max(32),
    wouldChange: z.boolean(),
  })
  .strict();

const worldEditPreviewOutputSchema = z
  .object({
    kind: z.literal("worldEdit"),
    changeSetId: changeSetIdOutputSchema,
    planDigest: changeSetIdOutputSchema,
    worldPath: projectPathOutputSchema,
    expectedRevision: revisionOutputSchema,
    operations: z
      .array(
        worldEditOperationPreviewOutputSchema,
      )
      .min(1)
      .max(32),
    summary: worldEditSummaryOutputSchema,
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    createdAt: isoTimestampOutputSchema,
    expiresAt: isoTimestampOutputSchema,
  })
  .strict();

export const worldEditPreviewToolOutputSchema =
  toolOutputSchema(worldEditPreviewOutputSchema);

const wangSetTypeOutputSchema = z.enum([
  "corner",
  "edge",
  "mixed",
]);

const wangEditOperationPreviewOutputSchema =
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("addWangSet"),
        destructive: z.literal(false),
        warning: z.string(),
        index: z.number().int().min(-1),
        name: z.string().min(1),
        wangSetType: wangSetTypeOutputSchema,
        colorCount:
          nonnegativeIntegerOutputSchema.max(
            MAX_TILESET_WANG_COLORS_PER_SET,
          ),
      })
      .strict(),
    z
      .object({
        type: z.literal("addWangColor"),
        destructive: z.literal(false),
        warning: z.string(),
        wangSetIndex:
          nonnegativeIntegerOutputSchema,
        colorIndex: z.number().int().min(-1),
        name: z.string().min(1),
        color: z
          .string()
          .regex(
            /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu,
          ),
      })
      .strict(),
    z
      .object({
        type: z.literal("setWangTiles"),
        destructive: z.boolean(),
        warning: z.string(),
        wangSetIndex:
          nonnegativeIntegerOutputSchema,
        assignmentCount:
          positiveIntegerOutputSchema.max(
            MAX_WANG_ASSIGNMENTS_PER_OPERATION,
          ),
        upserts: nonnegativeIntegerOutputSchema,
        removals: nonnegativeIntegerOutputSchema,
        noOps: nonnegativeIntegerOutputSchema,
      })
      .strict(),
  ]);

const wangEditSummaryOutputSchema = z
  .object({
    operationCount:
      positiveIntegerOutputSchema.max(
        MAX_WANG_EDIT_OPERATIONS,
      ),
    addedWangSets: z
      .array(
        z
          .object({
            index:
              nonnegativeIntegerOutputSchema,
            name: z.string().min(1),
            colorCount:
              nonnegativeIntegerOutputSchema,
          })
          .strict(),
      )
      .max(MAX_WANG_EDIT_OPERATIONS),
    addedColors: z
      .array(
        z
          .object({
            wangSetIndex:
              nonnegativeIntegerOutputSchema,
            colorIndex:
              positiveIntegerOutputSchema.max(
                MAX_TILESET_WANG_COLORS_PER_SET,
              ),
          })
          .strict(),
      )
      .max(MAX_WANG_EDIT_OPERATIONS),
    assignmentChanges: z
      .array(
        z
          .object({
            wangSetIndex:
              nonnegativeIntegerOutputSchema,
            upserts:
              nonnegativeIntegerOutputSchema,
            removals:
              nonnegativeIntegerOutputSchema,
            noOps:
              nonnegativeIntegerOutputSchema,
          })
          .strict(),
      )
      .max(MAX_WANG_EDIT_OPERATIONS),
    wouldChange: z.boolean(),
  })
  .strict();

const wangEditPreviewOutputSchema = z
  .object({
    kind: z.literal("wangEdit"),
    changeSetId: changeSetIdOutputSchema,
    planDigest: changeSetIdOutputSchema,
    mapPath: projectPathOutputSchema,
    tilesetPath: projectPathOutputSchema,
    assetId: assetIdOutputSchema,
    expectedRevision: revisionOutputSchema,
    mapRevision: revisionOutputSchema,
    operations: z
      .array(
        wangEditOperationPreviewOutputSchema,
      )
      .min(1)
      .max(MAX_WANG_EDIT_OPERATIONS),
    summary: wangEditSummaryOutputSchema,
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    createdAt: isoTimestampOutputSchema,
    expiresAt: isoTimestampOutputSchema,
  })
  .strict();

export const wangEditPreviewToolOutputSchema =
  toolOutputSchema(wangEditPreviewOutputSchema);

const fileExportSummaryOutputSchema = z
  .object({
    sourcePath: projectPathOutputSchema,
    targetPath: projectPathOutputSchema,
    exportKind: z.enum(["map", "tileset"]),
    format: z
      .string()
      .regex(/^[a-z0-9]{1,16}$/u),
    contentBytes: positiveIntegerOutputSchema,
    wouldChange: z.literal(true),
  })
  .strict();

const fileExportPreviewOutputSchema = z
  .object({
    kind: z.literal("fileExport"),
    changeSetId: changeSetIdOutputSchema,
    planDigest: changeSetIdOutputSchema,
    sourcePath: projectPathOutputSchema,
    sourceRevision: revisionOutputSchema,
    targetPath: projectPathOutputSchema,
    expectedRevision: revisionOutputSchema,
    operations: z
      .array(
        z
          .object({
            type: z.literal("exportFile"),
            destructive: z.literal(false),
            warning: z.string(),
            producer: z.enum([
              "tiled-cli",
              "native",
            ]),
            sourcePath: projectPathOutputSchema,
            targetPath: projectPathOutputSchema,
            exportKind: z.enum([
              "map",
              "tileset",
            ]),
            format: z
              .string()
              .regex(/^[a-z0-9]{1,16}$/u),
            contentBytes:
              positiveIntegerOutputSchema,
          })
          .strict(),
      )
      .length(1),
    summary: fileExportSummaryOutputSchema,
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    createdAt: isoTimestampOutputSchema,
    expiresAt: isoTimestampOutputSchema,
  })
  .strict();

export const fileExportPreviewToolOutputSchema =
  toolOutputSchema(fileExportPreviewOutputSchema);

const propertyTypeNameOutputSchema = z
  .string()
  .min(1)
  .max(512);

const propertyTypeEditSummaryOutputSchema = z
  .object({
    operationCount:
      positiveIntegerOutputSchema.max(16),
    upserted: z
      .array(
        z
          .object({
            name: propertyTypeNameOutputSchema,
            kind: z.enum(["class", "enum"]),
            id: positiveIntegerOutputSchema,
            created: z.boolean(),
          })
          .strict(),
      )
      .max(16),
    deleted: z
      .array(
        z
          .object({
            name: propertyTypeNameOutputSchema,
            id: positiveIntegerOutputSchema,
          })
          .strict(),
      )
      .max(16),
    typeCountBefore:
      nonnegativeIntegerOutputSchema,
    typeCountAfter:
      nonnegativeIntegerOutputSchema,
    wouldChange: z.boolean(),
  })
  .strict();

const propertyTypeEditPreviewOutputSchema = z
  .object({
    kind: z.literal("propertyTypeEdit"),
    changeSetId: changeSetIdOutputSchema,
    planDigest: changeSetIdOutputSchema,
    projectFilePath: projectPathOutputSchema,
    expectedRevision: revisionOutputSchema,
    operations: z
      .array(
        z.discriminatedUnion("type", [
          z
            .object({
              type: z.literal(
                "upsertPropertyType",
              ),
              destructive: z.literal(false),
              warning: z.string(),
              name: propertyTypeNameOutputSchema,
              typeKind: z.enum([
                "class",
                "enum",
              ]),
              typeId:
                positiveIntegerOutputSchema,
              created: z.boolean(),
            })
            .strict(),
          z
            .object({
              type: z.literal(
                "deletePropertyType",
              ),
              destructive: z.literal(true),
              warning: z.string(),
              name: propertyTypeNameOutputSchema,
              typeId:
                positiveIntegerOutputSchema,
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(16),
    summary:
      propertyTypeEditSummaryOutputSchema,
    snapshotConsistency: z.literal(
      "non-atomic-read-set",
    ),
    createdAt: isoTimestampOutputSchema,
    expiresAt: isoTimestampOutputSchema,
  })
  .strict();

export const propertyTypeEditPreviewToolOutputSchema =
  toolOutputSchema(
    propertyTypeEditPreviewOutputSchema,
  );

export const previewTransactionToolOutputSchema =
  toolOutputSchema(
    transactionPreviewOutputSchema,
  );

export const createLayerPreviewToolOutputSchema =
  toolOutputSchema(
    z.union([
      nonImageCreateLayerMapEditPreviewOutputSchema,
      imageCreateLayerMapEditPreviewOutputSchema,
    ]),
  );

export const previewEditsToolOutputSchema =
  toolOutputSchema(
    genericMapEditPreviewOutputSchema,
  );
