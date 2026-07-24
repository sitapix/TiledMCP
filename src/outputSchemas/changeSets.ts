import { z } from "zod";

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
const objectPatchOutputSchema = z
  .object({
    x: objectCoordinateOutputSchema.optional(),
    y: objectCoordinateOutputSchema.optional(),
    width: objectExtentOutputSchema.optional(),
    height: objectExtentOutputSchema.optional(),
    name: objectStringOutputSchema.optional(),
    className: objectStringOutputSchema.optional(),
    rotation: objectCoordinateOutputSchema.optional(),
    visible: z.boolean().optional(),
    opacity: opacityOutputSchema.optional(),
  })
  .strict();

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
  ]);

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
        "name",
        "className",
        "rotation",
        "visible",
        "opacity",
      ]),
    ),
    patch: objectPatchOutputSchema,
  })
  .strict();

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
    currentRevision: revisionOutputSchema,
    restoreRevision: revisionOutputSchema,
    restoreBytes: nonnegativeIntegerOutputSchema,
    exactBytes: z.literal(true),
    wouldChange: z.boolean(),
  })
  .strict();

const genericOperationPreviewOutputSchema =
  z.discriminatedUnion("type", [
    updateMapOperationPreviewOutputSchema,
    setTilesOperationPreviewOutputSchema,
    fillRegionOperationPreviewOutputSchema,
    stampPatternOperationPreviewOutputSchema,
    floodFillOperationPreviewOutputSchema,
    copyRegionOperationPreviewOutputSchema,
    replaceTilesOperationPreviewOutputSchema,
    createObjectOperationPreviewOutputSchema,
    updateObjectOperationPreviewOutputSchema,
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
      .max(128),
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
    currentRevision: revisionOutputSchema,
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

export const checkpointRestorePreviewToolOutputSchema =
  toolOutputSchema(
    checkpointRestorePreviewOutputSchema,
  );

export const addTilesetPreviewToolOutputSchema =
  toolOutputSchema(
    addTilesetMapEditPreviewOutputSchema,
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
