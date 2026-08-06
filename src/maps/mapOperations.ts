// The map-edit operation interpreter. Validates a batch of operations
// against an in-memory document, applies them to that document and returns
// the summary the change-set digest is computed over.
//
// One exported function over ~6,000 lines: callers and tests cross the same
// seam, and neither needs a filesystem to do it.

import {
  TiledMcpError,
} from "../errors.js";
import {
  type JsonObject,
  type JsonValue,
  cloneJson,
  expectArray,
  expectInteger,
  expectObject,
  expectString,
  isJsonObject,
  stableJson,
} from "../formats/json.js";
import {
  type JsonSourcePath,
} from "../formats/jsonSourcePatch.js";
import {
} from "../images/tilesetSheet.js";
import {
  type MapOrientation,
  decodeGid,
} from "./gid.js";
import {
  ASSET_ID_PATTERN,
  type DeletableLayerLocation,
  type EditableLayerLocation,
  FOUR_WAY_TILE_NEIGHBOR_OFFSETS,
  GROUP_DESCENDANT_RENDER_FIELDS,
  LAYER_BLEND_MODES,
  LAYER_PATCH_FIELDS,
  type LayerPatchField,
  type LayerSubtreeInspection,
  type LayerTraversalBudget,
  MAP_PATCH_FIELDS,
  MAP_RENDER_FIELDS,
  MAP_RENDER_ORDERS,
  MAX_ABSOLUTE_OBJECT_NUMBER,
  MAX_CELL_WRITES,
  MAX_CREATE_TILE_LAYER_CELLS,
  MAX_DUPLICATE_LAYER_BYTES,
  MAX_EDITABLE_DOCUMENT_BYTES,
  MAX_LAYER_COUNT,
  MAX_LAYER_DEPTH,
  MAX_LAYER_OPERATION_ID_SAMPLE,
  MAX_MAP_CLASS_NAME_CODE_POINTS,
  MAX_OBJECT_COUNT,
  MAX_OBJECT_MUTATIONS,
  MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET,
  MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET,
  MAX_PATCHED_SUBTREES,
  MAX_PLAN_OPERATIONS,
  MAX_REPLACE_TILE_MAPPINGS,
  MAX_RESIZE_CROPPED_CELL_SAMPLE,
  MAX_RESIZE_MAP_DIMENSION,
  MAX_RESIZE_OFFSET_MAGNITUDE,
  MAX_RESIZE_SOURCE_CELL_SCANS,
  MAX_STAMP_PATTERN_CELLS,
  MAX_STAMP_PATTERN_EDGE,
  MAX_TILED_SIGNED_ID,
  MAX_TILE_OPERATION_SCANS,
  type MapPatchField,
  type ObjectEditIndex,
  type ObjectLayerView,
  type ObjectLocation,
  REVISION_PATTERN,
  TILED_COLOR_PATTERN,
  type TileLayerView,
  type TilesetBinding,
} from "./mapDomain.js";
import {
  applyPropertiesPatch,
  measurePropertiesPatchBytes,
  validatePropertiesPatch,
} from "./propertyEdits.js";
import {
  MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET,
  TEXT_OBJECT_FIELDS,
  TextObjectValidationError,
  applyTextObjectFieldsPatch,
  hasTextObjectFields,
  measureTextObjectPayloadBytes,
  serializeTiledTextObjectData,
  textObjectFieldsFromFlatInput,
} from "./textObjects.js";
import {
  type ChunkedCellView,
  readMapChunkSize,
  serializeChunkedCells,
  writeChunkedViewGid,
} from "./tileData.js";
import {
  type MapEditOperation,
  type MapEditPlan,
  type ObjectDraft,
  type ObjectPathPoint,
  type PlannedMapEditOperation,
  type ResolvedAddTilesetToMapOperation,
  type ResolvedCreateLayerOperation,
  type TileRef,
} from "./types.js";
import {
  posix,
} from "node:path";
import {
  assertBasicEditableObject,
  assertBoundedString,
  assertExactObjectKeys,
  assertLayerTraversalBudget,
  assertObjectPathPoints,
  assertPositiveInteger,
  assertPositiveIntegerAtMost,
  assertRegionInsideLayer,
  assertResolvableGid,
  assertResolvedCreateLayerOperation,
  assertSafeInteger,
  boundedDisplayString,
  buildObjectEditIndex,
  findEditableLayer,
  findObjectLayer,
  findObjectLocation,
  findTileLayer,
  gidToTileRef,
  inspectLayerTree,
  isRecordValue,
  layerContainerForParent,
  layerPatchJsonKey,
  mapPatchJsonKey,
  readLayerGid,
  readOptionalInteger,
  tileRefToGid,
} from "./mapPrimitives.js";
import {
  inspectTilesetUsage,
} from "./mapPrimitives.js";
export function validateAndSummarizeOperations(
  map: JsonObject,
  // Edit planners never receive staggered/hexagonal contexts (that
  // gate is read-only opt-in), but the context type carries the union.
  orientation:
    | "orthogonal"
    | "isometric"
    | "staggered"
    | "hexagonal",
  bindings: readonly TilesetBinding[],
  operations: readonly PlannedMapEditOperation[],
  mapPath: string,
  options: {
    allowResolvedAddTileset?: boolean;
    allowResolvedCreateLayer?: boolean;
    sourceBytes?: number;
  } = {},
): MapEditPlan["summary"] {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new TiledMcpError("INVALID_ARGUMENT", "At least one edit operation is required.");
  }
  if (operations.length > MAX_PLAN_OPERATIONS) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A change set may contain at most ${MAX_PLAN_OPERATIONS} operations.`,
      { limit: MAX_PLAN_OPERATIONS },
    );
  }
  const removeTilesetOperationCount = operations.filter(
    (operation) =>
      isRecordValue(operation) &&
      operation.type === "removeTilesetFromMap",
  ).length;
  if (
    removeTilesetOperationCount > 1 ||
    (removeTilesetOperationCount === 1 &&
      operations.length !== 1)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "removeTilesetFromMap must be the only operation in its change set.",
    );
  }
  const deleteLayerOperationCount = operations.filter(
    (operation) =>
      isRecordValue(operation) &&
      operation.type === "deleteLayer",
  ).length;
  if (
    deleteLayerOperationCount > 1 ||
    (deleteLayerOperationCount === 1 &&
      operations.length !== 1)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "deleteLayer must be the only operation in its change set.",
    );
  }
  const moveLayerOperationCount = operations.filter(
    (operation) =>
      isRecordValue(operation) &&
      operation.type === "moveLayer",
  ).length;
  if (
    moveLayerOperationCount > 1 ||
    (moveLayerOperationCount === 1 &&
      operations.length !== 1)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "moveLayer must be the only operation in its change set.",
    );
  }
  const duplicateLayerOperationCount = operations.filter(
    (operation) =>
      isRecordValue(operation) &&
      operation.type === "duplicateLayer",
  ).length;
  if (
    duplicateLayerOperationCount > 1 ||
    (duplicateLayerOperationCount === 1 &&
      operations.length !== 1)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "duplicateLayer must be the only operation in its change set.",
    );
  }
  const resizeMapOperationCount = operations.filter(
    (operation) =>
      isRecordValue(operation) &&
      operation.type === "resizeMap",
  ).length;
  if (
    resizeMapOperationCount > 1 ||
    (resizeMapOperationCount === 1 &&
      operations.length !== 1)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "resizeMap must be the only operation in its change set.",
    );
  }
  const transcodeOperationCount = operations.filter(
    (operation) =>
      isRecordValue(operation) &&
      operation.type === "transcodeTileLayer",
  ).length;
  if (
    transcodeOperationCount > 1 ||
    (transcodeOperationCount === 1 &&
      operations.length !== 1)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "transcodeTileLayer must be the only operation in its change set.",
    );
  }

  let cellWrites = 0;
  let tileOperationScans = 0;
  let objectMutations = 0;
  let objectShapePoints = 0;
  let textObjectPayloadBytes = 0;
  let objectPropertyPatchBytes = 0;
  const affectedLayerIds = new Set<number>();
  const affectedTileLayerIds = new Set<number>();
  const chunkedTileLayerIds = new Set<number>();
  const affectedObjectLayerIds = new Set<number>();
  const createdObjectIds = new Set<number>();
  const updatedObjectIds = new Set<number>();
  const deletedObjectIds = new Set<number>();
  const updatedLayerIds = new Set<number>();
  const changedMapMembers = new Set<string>();
  const changedLayerMembers = new Set<string>();
  const addedTilesets: NonNullable<
    MapEditPlan["summary"]["addedTilesets"]
  > = [];
  const removedTilesets: NonNullable<
    MapEditPlan["summary"]["removedTilesets"]
  > = [];
  const createdLayers: NonNullable<
    MapEditPlan["summary"]["createdLayers"]
  > = [];
  const tileReplacements: NonNullable<
    MapEditPlan["summary"]["tileReplacements"]
  > = [];
  const tileStamps: NonNullable<
    MapEditPlan["summary"]["tileStamps"]
  > = [];
  const tileFloodFills: NonNullable<
    MapEditPlan["summary"]["tileFloodFills"]
  > = [];
  const tileCopies: NonNullable<
    MapEditPlan["summary"]["tileCopies"]
  > = [];
  const mapUpdates: NonNullable<
    MapEditPlan["summary"]["mapUpdates"]
  > = [];
  const transcodes: NonNullable<
    MapEditPlan["summary"]["transcodes"]
  > = [];
  const mapResizes: NonNullable<
    MapEditPlan["summary"]["mapResizes"]
  > = [];
  const layerUpdates: NonNullable<
    MapEditPlan["summary"]["layerUpdates"]
  > = [];
  const deletedLayers: NonNullable<
    MapEditPlan["summary"]["deletedLayers"]
  > = [];
  const movedLayers: NonNullable<
    MapEditPlan["summary"]["movedLayers"]
  > = [];
  const duplicatedLayers: NonNullable<
    MapEditPlan["summary"]["duplicatedLayers"]
  > = [];
  let objectIndex: ObjectEditIndex | undefined;
  const getObjectIndex = (): ObjectEditIndex => {
    objectIndex ??= buildObjectEditIndex(map, mapPath);
    return objectIndex;
  };
  for (const [operationIndex, operation] of operations.entries()) {
    if (!isRecordValue(operation)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `Operation ${operationIndex} must be an object.`,
      );
    }
    if (operation.type === "createLayer") {
      if (
        options.allowResolvedCreateLayer !== true ||
        operations.length !== 1
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "createLayer is available only through its dedicated preview tool and cannot be batched with generic map edits.",
        );
      }
      assertResolvedCreateLayerOperation(operation);
      const created = applyResolvedCreateLayer(
        map,
        operation,
        mapPath,
      );
      if (cellWrites + created.allocatedCellCount > MAX_CELL_WRITES) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may write at most ${MAX_CELL_WRITES} cells.`,
          { limit: MAX_CELL_WRITES },
        );
      }
      cellWrites += created.allocatedCellCount;
      affectedLayerIds.add(operation.layerId);
      createdLayers.push({
        layerId: operation.layerId,
        layerType: operation.layerType,
        name: operation.name,
        parentGroupId: operation.parentGroupId,
        index: operation.index,
        allocatedCellCount: created.allocatedCellCount,
        ...(operation.image === undefined
          ? {}
          : { image: structuredClone(operation.image) }),
      });
    } else if (operation.type === "addTilesetToMap") {
      if (
        options.allowResolvedAddTileset !== true ||
        operations.length !== 1
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "addTilesetToMap is available only through its dedicated preview tool and cannot be batched with generic map edits.",
        );
      }
      assertResolvedAddTilesetOperation(operation);
      const entries = expectArray(map.tilesets, `${mapPath}.tilesets`);
      entries.push({
        firstgid: operation.firstGid,
        source: operation.source,
      });
      map.tilesets = entries;
      addedTilesets.push({
        tilesetPath: operation.tilesetPath,
        source: operation.source,
        assetId: operation.assetId,
        tilesetRevision: operation.tilesetRevision,
        tileCount: operation.tileCount,
        gidSpan: operation.gidSpan,
        firstGid: operation.firstGid,
      });
    } else if (
      operation.type === "removeTilesetFromMap"
    ) {
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set(["tilesetAssetId", "type"]),
        `operations[${operationIndex}]`,
      );
      if (
        typeof operation.tilesetAssetId !== "string" ||
        !ASSET_ID_PATTERN.test(
          operation.tilesetAssetId,
        )
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}].tilesetAssetId must be an opaque asset id returned by the map summary.`,
        );
      }
      removedTilesets.push({
        operationIndex,
        ...removeUnusedTilesetReference(
          map,
          bindings,
          operation.tilesetAssetId,
          mapPath,
        ),
      });
    } else if (operation.type === "updateMap") {
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set(["patch", "type"]),
        `operations[${operationIndex}]`,
      );
      const update = updateCommonMap(
        map,
        operation.patch,
        `operations[${operationIndex}].patch`,
      );
      for (const field of update.changedFields) {
        changedMapMembers.add(mapPatchJsonKey(field));
      }
      mapUpdates.push({
        operationIndex,
        requestedFields: update.requestedFields,
        changedFields: update.changedFields,
        wouldChange: update.changedFields.length > 0,
        renderingMayChange: update.changedFields.some(
          (field) => MAP_RENDER_FIELDS.has(field),
        ),
      });
    } else if (operation.type === "resizeMap") {
      const operationContext = `operations[${operationIndex}]`;
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set(["height", "offsetX", "offsetY", "type", "width"]),
        operationContext,
      );
      if (map.infinite === true) {
        throw new TiledMcpError(
          "UNSUPPORTED_RESIZE_LAYER_BOUNDS",
          "Infinite maps have no resizable canvas; their nominal width and height do not bound chunked storage.",
          { path: mapPath },
        );
      }
      const input = readResizeMapInput(
        operation as unknown as Record<string, unknown>,
        operationContext,
      );
      const oldWidth = expectInteger(map.width, `${mapPath}.width`);
      const oldHeight = expectInteger(map.height, `${mapPath}.height`);
      assertPositiveInteger(oldWidth, `${mapPath}.width`);
      assertPositiveInteger(oldHeight, `${mapPath}.height`);
      const tileWidth = expectInteger(map.tilewidth, `${mapPath}.tilewidth`);
      const tileHeight = expectInteger(map.tileheight, `${mapPath}.tileheight`);
      assertPositiveInteger(tileWidth, `${mapPath}.tilewidth`);
      assertPositiveInteger(tileHeight, `${mapPath}.tileheight`);
      const pixelOffsetX = input.offsetX * tileWidth;
      const pixelOffsetY = input.offsetY * tileHeight;
      if (
        !Number.isSafeInteger(pixelOffsetX) ||
        !Number.isSafeInteger(pixelOffsetY) ||
        !Number.isSafeInteger(input.width * tileWidth) ||
        !Number.isSafeInteger(input.height * tileHeight)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${operationContext} pixel arithmetic must stay within safe integers.`,
        );
      }
      const views = collectResizeLayerViews(
        map,
        oldWidth,
        oldHeight,
        mapPath,
        operationContext,
      );
      const scannedCellCount =
        views.tileLayers.length * oldWidth * oldHeight;
      const rewrittenCellCount =
        views.tileLayers.length * input.width * input.height;
      if (
        !Number.isSafeInteger(rewrittenCellCount) ||
        cellWrites + rewrittenCellCount > MAX_CELL_WRITES
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may write at most ${MAX_CELL_WRITES} cells.`,
          {
            limit: MAX_CELL_WRITES,
            actual: cellWrites + rewrittenCellCount,
            operationIndex,
          },
        );
      }
      if (
        !Number.isSafeInteger(scannedCellCount) ||
        tileOperationScans + scannedCellCount >
          MAX_RESIZE_SOURCE_CELL_SCANS
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A resizeMap operation may scan at most ${MAX_RESIZE_SOURCE_CELL_SCANS} source tile cells.`,
          {
            limit: MAX_RESIZE_SOURCE_CELL_SCANS,
            actual: tileOperationScans + scannedCellCount,
            operationIndex,
          },
        );
      }
      const resized = performMapResize(
        map,
        orientation,
        bindings,
        views,
        {
          operationContext,
          mapPath,
          oldWidth,
          oldHeight,
          newWidth: input.width,
          newHeight: input.height,
          offsetX: input.offsetX,
          offsetY: input.offsetY,
          pixelOffsetX,
          pixelOffsetY,
          tileWidth,
          tileHeight,
          objectMutationsUsed: objectMutations,
        },
      );
      cellWrites += rewrittenCellCount;
      tileOperationScans += scannedCellCount;
      objectMutations += resized.movedObjectCount;
      for (const layerId of resized.dataChangedTileLayerIds) {
        affectedLayerIds.add(layerId);
        affectedTileLayerIds.add(layerId);
      }
      for (const layerId of resized.objectShiftedLayerIds) {
        affectedLayerIds.add(layerId);
        affectedObjectLayerIds.add(layerId);
      }
      for (const layerId of resized.shiftedImageLayerIds) {
        affectedLayerIds.add(layerId);
      }
      mapResizes.push({
        operationIndex,
        oldWidth,
        oldHeight,
        newWidth: input.width,
        newHeight: input.height,
        offsetX: input.offsetX,
        offsetY: input.offsetY,
        pixelOffsetX,
        pixelOffsetY,
        wouldChange: resized.wouldChange,
        mapDimensionsChanged: resized.mapDimensionsChanged,
        tileLayerCount: views.tileLayers.length,
        resizedTileLayerIds: views.tileLayers
          .map((layer) => layer.id)
          .sort((left, right) => left - right),
        scannedCellCount,
        rewrittenCellCount,
        preservedNonEmptyCellCount:
          resized.preservedNonEmptyCellCount,
        croppedNonEmptyCellCount:
          resized.croppedNonEmptyCellCount,
        croppedCellSample: resized.croppedCellSample,
        omittedCroppedCellCount:
          resized.croppedNonEmptyCellCount -
          resized.croppedCellSample.length,
        objectLayerCount: views.objectLayers.length,
        movedObjectCount: resized.movedObjectCount,
        objectsOutsideNewBounds:
          resized.objectsOutsideNewBounds,
        imageLayerCount: views.imageLayers.length,
        shiftedImageLayerIds: [
          ...resized.shiftedImageLayerIds,
        ].sort((left, right) => left - right),
        groupLayerCount: views.groupLayerCount,
        lockedLayerCount: views.lockedLayerCount,
      });
    } else if (operation.type === "transcodeTileLayer") {
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set(["compression", "encoding", "layerId", "type"]),
        `operations[${operationIndex}]`,
      );
      assertPositiveInteger(
        operation.layerId,
        `operations[${operationIndex}].layerId`,
      );
      if (
        operation.encoding !== "csv" &&
        operation.encoding !== "base64"
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}].encoding must be "csv" or "base64".`,
        );
      }
      const toCompression = operation.compression ?? "";
      if (
        !["", "gzip", "zlib", "zstd"].includes(toCompression)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}].compression must be "", "gzip", "zlib" or "zstd".`,
        );
      }
      if (operation.encoding === "csv" && toCompression !== "") {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}] csv storage cannot carry a compression member.`,
        );
      }
      const layer = findTileLayer(
        map,
        operation.layerId,
        mapPath,
        "edit",
        true,
      );
      const fromEncoding =
        layer.object.encoding === "base64" ? "base64" : "csv";
      const fromCompression =
        fromEncoding === "base64" &&
        layer.object.compression !== undefined
          ? String(layer.object.compression)
          : "";
      const wouldChange =
        fromEncoding !== operation.encoding ||
        (operation.encoding === "base64" &&
          fromCompression !== toCompression);
      if (wouldChange) {
        affectedLayerIds.add(layer.id);
        affectedTileLayerIds.add(layer.id);
        if (operation.encoding === "csv") {
          delete layer.object.encoding;
          delete layer.object.compression;
        } else {
          layer.object.encoding = "base64";
          layer.object.compression = toCompression;
        }
        if (layer.chunked !== undefined) {
          // Transcoding rewrites every chunk in the target encoding and,
          // like any chunked write, normalizes the chunk structure.
          layer.chunked.dirty = true;
          finalizeChunkedTileLayerWrite(
            layer,
            map,
            mapPath,
            chunkedTileLayerIds,
          );
        } else {
          // The shared re-encode pass turns this array into the target
          // byte representation using the members written above.
          layer.object.data = layer.data;
        }
      }
      transcodes.push({
        operationIndex,
        layerId: layer.id,
        fromEncoding,
        fromCompression,
        toEncoding: operation.encoding,
        toCompression:
          operation.encoding === "base64" ? toCompression : "",
        cellCount:
          layer.chunked === undefined
            ? layer.data.length
            : layer.chunked.structure
                .totalChunkCells,
        wouldChange,
      });
    } else if (operation.type === "setTiles") {
      assertSafeInteger(operation.layerId, `operations[${operationIndex}].layerId`);
      if (!Array.isArray(operation.cells) || operation.cells.length === 0) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}].cells must not be empty.`,
        );
      }
      if (cellWrites + operation.cells.length > MAX_CELL_WRITES) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may write at most ${MAX_CELL_WRITES} cells.`,
          { limit: MAX_CELL_WRITES },
        );
      }
      const layer = findTileLayer(map, operation.layerId, mapPath, "edit", true);
      affectedLayerIds.add(layer.id);
      affectedTileLayerIds.add(layer.id);
      cellWrites += operation.cells.length;
      for (const [cellIndex, cell] of operation.cells.entries()) {
        assertSafeInteger(cell.x, `operations[${operationIndex}].cells[${cellIndex}].x`);
        assertSafeInteger(cell.y, `operations[${operationIndex}].cells[${cellIndex}].y`);
        if (layer.chunked === undefined) {
          assertRegionInsideLayer(layer, cell.x, cell.y, 1, 1);
        } else if (
          Math.abs(cell.x) > 1_000_000_000 ||
          Math.abs(cell.y) > 1_000_000_000
        ) {
          throw new TiledMcpError(
            "REGION_OUT_OF_BOUNDS",
            `operations[${operationIndex}].cells[${cellIndex}] is outside the bounded infinite-map coordinate range.`,
            { layerId: layer.id, x: cell.x, y: cell.y },
          );
        }
        const gid = tileRefToGid(cell.tile, orientation, bindings);
        writeLayerGid(layer, cell.x, cell.y, gid);
      }
      finalizeChunkedTileLayerWrite(
        layer,
        map,
        mapPath,
        chunkedTileLayerIds,
      );
    } else if (operation.type === "fillRegion") {
      assertSafeInteger(operation.layerId, `operations[${operationIndex}].layerId`);
      assertSafeInteger(operation.x, `operations[${operationIndex}].x`);
      assertSafeInteger(operation.y, `operations[${operationIndex}].y`);
      assertPositiveInteger(operation.width, `operations[${operationIndex}].width`);
      assertPositiveInteger(operation.height, `operations[${operationIndex}].height`);
      const regionCells = operation.width * operation.height;
      if (
        !Number.isSafeInteger(regionCells) ||
        cellWrites + regionCells > MAX_CELL_WRITES
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may write at most ${MAX_CELL_WRITES} cells.`,
          { limit: MAX_CELL_WRITES },
        );
      }
      const layer = findTileLayer(
        map,
        operation.layerId,
        mapPath,
        "edit",
        true,
      );
      if (layer.chunked === undefined) {
        assertRegionInsideLayer(
          layer,
          operation.x,
          operation.y,
          operation.width,
          operation.height,
        );
      } else {
        assertChunkedRegionBounded(
          layer,
          operationIndex,
          operation.x,
          operation.y,
          operation.width,
          operation.height,
        );
      }
      affectedLayerIds.add(layer.id);
      affectedTileLayerIds.add(layer.id);
      cellWrites += regionCells;
      const gid = tileRefToGid(operation.tile, orientation, bindings);
      for (let y = operation.y; y < operation.y + operation.height; y += 1) {
        for (let x = operation.x; x < operation.x + operation.width; x += 1) {
          writeLayerGid(layer, x, y, gid);
        }
      }
      finalizeChunkedTileLayerWrite(
        layer,
        map,
        mapPath,
        chunkedTileLayerIds,
      );
    } else if (operation.type === "floodFill") {
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set([
          "layerId",
          "tile",
          "type",
          "x",
          "y",
        ]),
        `operations[${operationIndex}]`,
      );
      assertPositiveInteger(
        operation.layerId,
        `operations[${operationIndex}].layerId`,
      );
      assertSafeInteger(
        operation.x,
        `operations[${operationIndex}].x`,
      );
      assertSafeInteger(
        operation.y,
        `operations[${operationIndex}].y`,
      );
      const layer = findTileLayer(
        map,
        operation.layerId,
        mapPath,
        "edit",
        true,
      );
      let fillBounds: {
        x: number;
        y: number;
        width: number;
        height: number;
      } | null;
      if (layer.chunked === undefined) {
        assertRegionInsideLayer(
          layer,
          operation.x,
          operation.y,
          1,
          1,
        );
        fillBounds = {
          x: layer.x,
          y: layer.y,
          width: layer.width,
          height: layer.height,
        };
      } else {
        // Tiled 1.12.2 flood-fills an infinite layer inside its used
        // chunk bounds; a seed outside them fills nothing.
        fillBounds = chunkedFillBounds(
          layer.chunked,
        );
      }
      const seedInsideBounds =
        fillBounds !== null &&
        operation.x >= fillBounds.x &&
        operation.x <
          fillBounds.x + fillBounds.width &&
        operation.y >= fillBounds.y &&
        operation.y <
          fillBounds.y + fillBounds.height;
      const targetGid = tileRefToGid(
        operation.tile,
        orientation,
        bindings,
      );
      const targetTile = gidToTileRef(
        targetGid,
        orientation,
        bindings,
      );
      let scannedCellCount = 0;
      const readObservedGid = (
        x: number,
        y: number,
      ): {
        gid: number;
        tile: TileRef | null;
      } => {
        const nextScanCount =
          tileOperationScans +
          scannedCellCount +
          1;
        if (
          !Number.isSafeInteger(nextScanCount) ||
          nextScanCount >
            MAX_TILE_OPERATION_SCANS
        ) {
          throw new TiledMcpError(
            "RESULT_LIMIT_EXCEEDED",
            `A change set may perform at most ${MAX_TILE_OPERATION_SCANS} tile-cell reads across replaceTiles, floodFill and copyRegion operations.`,
            {
              limit: MAX_TILE_OPERATION_SCANS,
              actual: nextScanCount,
              operationIndex,
            },
          );
        }
        scannedCellCount += 1;
        const gid = readLayerGid(layer, x, y);
        return {
          gid,
          tile: gidToTileRef(
            gid,
            orientation,
            bindings,
          ),
        };
      };
      const source = readObservedGid(
        operation.x,
        operation.y,
      );
      let changedCellCount = 0;
      let affectedBounds: {
        x: number;
        y: number;
        width: number;
        height: number;
      } | null = null;

      if (
        source.gid !== targetGid &&
        seedInsideBounds &&
        fillBounds !== null
      ) {
        if (cellWrites + 1 > MAX_CELL_WRITES) {
          throw new TiledMcpError(
            "RESULT_LIMIT_EXCEEDED",
            `A change set may write at most ${MAX_CELL_WRITES} cells.`,
            {
              limit: MAX_CELL_WRITES,
              actual: cellWrites + 1,
              operationIndex,
            },
          );
        }
        const queue: Array<{
          x: number;
          y: number;
        }> = [
          { x: operation.x, y: operation.y },
        ];
        writeLayerGid(
          layer,
          operation.x,
          operation.y,
          targetGid,
        );
        changedCellCount = 1;
        let minimumX = operation.x;
        let minimumY = operation.y;
        let maximumX = operation.x;
        let maximumY = operation.y;

        for (
          let queueIndex = 0;
          queueIndex < queue.length;
          queueIndex += 1
        ) {
          const current = queue[
            queueIndex
          ] as { x: number; y: number };
          for (const [
            deltaX,
            deltaY,
          ] of FOUR_WAY_TILE_NEIGHBOR_OFFSETS) {
            const neighborX =
              current.x + deltaX;
            const neighborY =
              current.y + deltaY;
            if (
              neighborX < fillBounds.x ||
              neighborY < fillBounds.y ||
              neighborX >=
                fillBounds.x +
                  fillBounds.width ||
              neighborY >=
                fillBounds.y +
                  fillBounds.height
            ) {
              continue;
            }
            const candidate = readObservedGid(
              neighborX,
              neighborY,
            );
            if (candidate.gid !== source.gid) {
              continue;
            }
            const nextChangedCellCount =
              changedCellCount + 1;
            if (
              cellWrites +
                nextChangedCellCount >
              MAX_CELL_WRITES
            ) {
              throw new TiledMcpError(
                "RESULT_LIMIT_EXCEEDED",
                `A change set may write at most ${MAX_CELL_WRITES} cells.`,
                {
                  limit: MAX_CELL_WRITES,
                  actual:
                    cellWrites +
                    nextChangedCellCount,
                  operationIndex,
                },
              );
            }
            writeLayerGid(
              layer,
              neighborX,
              neighborY,
              targetGid,
            );
            changedCellCount =
              nextChangedCellCount;
            minimumX = Math.min(
              minimumX,
              neighborX,
            );
            minimumY = Math.min(
              minimumY,
              neighborY,
            );
            maximumX = Math.max(
              maximumX,
              neighborX,
            );
            maximumY = Math.max(
              maximumY,
              neighborY,
            );
            queue.push({
              x: neighborX,
              y: neighborY,
            });
          }
        }
        affectedBounds = {
          x: minimumX,
          y: minimumY,
          width: maximumX - minimumX + 1,
          height: maximumY - minimumY + 1,
        };
      }

      tileOperationScans +=
        scannedCellCount;
      cellWrites += changedCellCount;
      if (changedCellCount > 0) {
        affectedLayerIds.add(layer.id);
        affectedTileLayerIds.add(layer.id);
        finalizeChunkedTileLayerWrite(
          layer,
          map,
          mapPath,
          chunkedTileLayerIds,
        );
      }
      tileFloodFills.push({
        operationIndex,
        layerId: layer.id,
        seed: {
          x: operation.x,
          y: operation.y,
        },
        connectivity: "four-way",
        sourceTile: source.tile,
        targetTile,
        scannedCellCount,
        changedCellCount,
        affectedBounds,
        wouldChange: changedCellCount > 0,
      });
    } else if (operation.type === "copyRegion") {
      const operationContext =
        `operations[${operationIndex}]`;
      assertExactObjectKeys(
        operation as unknown as Record<
          string,
          unknown
        >,
        new Set(["destination", "source", "type"]),
        operationContext,
      );
      if (!isRecordValue(operation.source)) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${operationContext}.source must be an object.`,
        );
      }
      if (!isRecordValue(operation.destination)) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${operationContext}.destination must be an object.`,
        );
      }
      assertExactObjectKeys(
        operation.source as unknown as Record<
          string,
          unknown
        >,
        new Set([
          "height",
          "layerId",
          "width",
          "x",
          "y",
        ]),
        `${operationContext}.source`,
      );
      assertExactObjectKeys(
        operation.destination as unknown as Record<
          string,
          unknown
        >,
        new Set(["layerId", "x", "y"]),
        `${operationContext}.destination`,
      );
      assertPositiveInteger(
        operation.source.layerId,
        `${operationContext}.source.layerId`,
      );
      assertSafeInteger(
        operation.source.x,
        `${operationContext}.source.x`,
      );
      assertSafeInteger(
        operation.source.y,
        `${operationContext}.source.y`,
      );
      assertPositiveInteger(
        operation.source.width,
        `${operationContext}.source.width`,
      );
      assertPositiveInteger(
        operation.source.height,
        `${operationContext}.source.height`,
      );
      assertPositiveInteger(
        operation.destination.layerId,
        `${operationContext}.destination.layerId`,
      );
      assertSafeInteger(
        operation.destination.x,
        `${operationContext}.destination.x`,
      );
      assertSafeInteger(
        operation.destination.y,
        `${operationContext}.destination.y`,
      );
      if (
        !Number.isSafeInteger(
          operation.source.x +
            operation.source.width,
        ) ||
        !Number.isSafeInteger(
          operation.source.y +
            operation.source.height,
        ) ||
        !Number.isSafeInteger(
          operation.destination.x +
            operation.source.width,
        ) ||
        !Number.isSafeInteger(
          operation.destination.y +
            operation.source.height,
        )
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${operationContext} copy endpoints must be safe integers.`,
        );
      }
      const copyCellCount =
        operation.source.width *
        operation.source.height;
      if (
        !Number.isSafeInteger(copyCellCount) ||
        cellWrites + copyCellCount >
          MAX_CELL_WRITES
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may write at most ${MAX_CELL_WRITES} cells.`,
          {
            limit: MAX_CELL_WRITES,
            actual: cellWrites + copyCellCount,
            operationIndex,
          },
        );
      }
      const scannedCellCount = copyCellCount * 2;
      if (
        !Number.isSafeInteger(scannedCellCount) ||
        tileOperationScans + scannedCellCount >
          MAX_TILE_OPERATION_SCANS
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may perform at most ${MAX_TILE_OPERATION_SCANS} tile-cell reads across replaceTiles, floodFill and copyRegion operations.`,
          {
            limit: MAX_TILE_OPERATION_SCANS,
            actual:
              tileOperationScans +
              scannedCellCount,
            operationIndex,
          },
        );
      }
      const sourceLayer = findTileLayer(
        map,
        operation.source.layerId,
        mapPath,
        "edit",
        true,
      );
      const destinationLayer = findTileLayer(
        map,
        operation.destination.layerId,
        mapPath,
        "edit",
        true,
      );
      if (sourceLayer.chunked === undefined) {
        assertRegionInsideLayer(
          sourceLayer,
          operation.source.x,
          operation.source.y,
          operation.source.width,
          operation.source.height,
        );
      } else {
        assertChunkedRegionBounded(
          sourceLayer,
          operationIndex,
          operation.source.x,
          operation.source.y,
          operation.source.width,
          operation.source.height,
        );
      }
      if (
        destinationLayer.chunked === undefined
      ) {
        assertRegionInsideLayer(
          destinationLayer,
          operation.destination.x,
          operation.destination.y,
          operation.source.width,
          operation.source.height,
        );
      } else {
        assertChunkedRegionBounded(
          destinationLayer,
          operationIndex,
          operation.destination.x,
          operation.destination.y,
          operation.source.width,
          operation.source.height,
        );
      }

      const sourceGids: number[] = [];
      const destinationGids: number[] = [];
      let sourceNonEmptyCellCount = 0;
      let overwrittenNonEmptyCellCount = 0;
      let changedCellCount = 0;
      let clearedCellCount = 0;
      for (
        let rowIndex = 0;
        rowIndex < operation.source.height;
        rowIndex += 1
      ) {
        for (
          let columnIndex = 0;
          columnIndex < operation.source.width;
          columnIndex += 1
        ) {
          const sourceGid = readLayerGid(
            sourceLayer,
            operation.source.x + columnIndex,
            operation.source.y + rowIndex,
          );
          const destinationGid = readLayerGid(
            destinationLayer,
            operation.destination.x + columnIndex,
            operation.destination.y + rowIndex,
          );
          // A copy observes both rectangles before it mutates either one.
          // Resolve every observed encoded GID so malformed or unbound
          // values fail closed even when the destination would be unchanged.
          gidToTileRef(
            sourceGid,
            orientation,
            bindings,
          );
          gidToTileRef(
            destinationGid,
            orientation,
            bindings,
          );
          sourceGids.push(sourceGid);
          destinationGids.push(destinationGid);
          if (sourceGid !== 0) {
            sourceNonEmptyCellCount += 1;
          }
          if (destinationGid !== 0) {
            overwrittenNonEmptyCellCount += 1;
          }
          if (sourceGid !== destinationGid) {
            changedCellCount += 1;
            if (
              sourceGid === 0 &&
              destinationGid !== 0
            ) {
              clearedCellCount += 1;
            }
          }
        }
      }

      for (
        let rowIndex = 0;
        rowIndex < operation.source.height;
        rowIndex += 1
      ) {
        for (
          let columnIndex = 0;
          columnIndex < operation.source.width;
          columnIndex += 1
        ) {
          const index =
            rowIndex * operation.source.width +
            columnIndex;
          const sourceGid = sourceGids[index] as number;
          if (
            sourceGid === destinationGids[index]
          ) {
            continue;
          }
          writeLayerGid(
            destinationLayer,
            operation.destination.x + columnIndex,
            operation.destination.y + rowIndex,
            sourceGid,
          );
        }
      }
      cellWrites += copyCellCount;
      tileOperationScans += scannedCellCount;
      if (changedCellCount > 0) {
        affectedLayerIds.add(destinationLayer.id);
        affectedTileLayerIds.add(
          destinationLayer.id,
        );
        finalizeChunkedTileLayerWrite(
          destinationLayer,
          map,
          mapPath,
          chunkedTileLayerIds,
        );
      }
      const overlapsSource =
        sourceLayer.id === destinationLayer.id &&
        operation.source.x <
          operation.destination.x +
            operation.source.width &&
        operation.destination.x <
          operation.source.x +
            operation.source.width &&
        operation.source.y <
          operation.destination.y +
            operation.source.height &&
        operation.destination.y <
          operation.source.y +
            operation.source.height;
      tileCopies.push({
        operationIndex,
        source: {
          layerId: sourceLayer.id,
          x: operation.source.x,
          y: operation.source.y,
          width: operation.source.width,
          height: operation.source.height,
        },
        destination: {
          layerId: destinationLayer.id,
          x: operation.destination.x,
          y: operation.destination.y,
          width: operation.source.width,
          height: operation.source.height,
        },
        scannedCellCount,
        cellCount: copyCellCount,
        sourceNonEmptyCellCount,
        changedCellCount,
        overwrittenNonEmptyCellCount,
        clearedCellCount,
        overlapsSource,
        wouldChange: changedCellCount > 0,
      });
    } else if (operation.type === "stampPattern") {
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set([
          "layerId",
          "pattern",
          "type",
          "x",
          "y",
        ]),
        `operations[${operationIndex}]`,
      );
      assertPositiveInteger(
        operation.layerId,
        `operations[${operationIndex}].layerId`,
      );
      assertSafeInteger(
        operation.x,
        `operations[${operationIndex}].x`,
      );
      assertSafeInteger(
        operation.y,
        `operations[${operationIndex}].y`,
      );
      const pattern = readStampPattern(
        operation.pattern,
        operationIndex,
      );
      const height = pattern.length;
      const width = pattern[0]?.length ?? 0;
      const patternCellCount = width * height;
      if (
        !Number.isSafeInteger(operation.x + width) ||
        !Number.isSafeInteger(operation.y + height)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}] stamp endpoints must be safe integers.`,
        );
      }
      if (
        cellWrites + patternCellCount >
        MAX_CELL_WRITES
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A change set may write at most ${MAX_CELL_WRITES} cells.`,
          {
            limit: MAX_CELL_WRITES,
            actual: cellWrites + patternCellCount,
          },
        );
      }
      const layer = findTileLayer(
        map,
        operation.layerId,
        mapPath,
        "edit",
        true,
      );
      if (layer.chunked === undefined) {
        assertRegionInsideLayer(
          layer,
          operation.x,
          operation.y,
          width,
          height,
        );
      } else {
        assertChunkedRegionBounded(
          layer,
          operationIndex,
          operation.x,
          operation.y,
          width,
          height,
        );
      }

      const resolvedRows: number[][] = [];
      let nonEmptyCellCount = 0;
      let clearCellCount = 0;
      let transformedCellCount = 0;
      for (const row of pattern) {
        const resolvedRow: number[] = [];
        for (const tile of row) {
          const gid = tileRefToGid(
            tile,
            orientation,
            bindings,
          );
          resolvedRow.push(gid);
          if (gid === 0) {
            clearCellCount += 1;
          } else {
            nonEmptyCellCount += 1;
            if (
              decodeGid(gid, orientation).transform
                .rawFlags !== 0
            ) {
              transformedCellCount += 1;
            }
          }
        }
        resolvedRows.push(resolvedRow);
      }

      let changedCellCount = 0;
      for (
        let rowIndex = 0;
        rowIndex < resolvedRows.length;
        rowIndex += 1
      ) {
        const row = resolvedRows[rowIndex] as number[];
        for (
          let columnIndex = 0;
          columnIndex < row.length;
          columnIndex += 1
        ) {
          const gid = row[columnIndex] as number;
          const x = operation.x + columnIndex;
          const y = operation.y + rowIndex;
          const currentGid = readLayerGid(layer, x, y);
          gidToTileRef(
            currentGid,
            orientation,
            bindings,
          );
          if (currentGid === gid) {
            continue;
          }
          writeLayerGid(layer, x, y, gid);
          changedCellCount += 1;
        }
      }
      if (changedCellCount > 0) {
        affectedLayerIds.add(layer.id);
        affectedTileLayerIds.add(layer.id);
        finalizeChunkedTileLayerWrite(
          layer,
          map,
          mapPath,
          chunkedTileLayerIds,
        );
      }
      cellWrites += patternCellCount;
      tileStamps.push({
        operationIndex,
        layerId: layer.id,
        region: {
          x: operation.x,
          y: operation.y,
          width,
          height,
        },
        cellCount: patternCellCount,
        nonEmptyCellCount,
        clearCellCount,
        transformedCellCount,
        changedCellCount,
        wouldChange: changedCellCount > 0,
      });
    } else if (operation.type === "replaceTiles") {
      assertPositiveInteger(
        operation.layerId,
        `operations[${operationIndex}].layerId`,
      );
      if (
        !Array.isArray(operation.mappings) ||
        operation.mappings.length === 0
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}].mappings must not be empty.`,
        );
      }
      if (
        operation.mappings.length >
        MAX_REPLACE_TILE_MAPPINGS
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A replaceTiles operation may contain at most ${MAX_REPLACE_TILE_MAPPINGS} mappings.`,
          { limit: MAX_REPLACE_TILE_MAPPINGS },
        );
      }
      const layer = findTileLayer(
        map,
        operation.layerId,
        mapPath,
        "edit",
        true,
      );
      const chunkedBounds =
        layer.chunked === undefined
          ? null
          : chunkedFillBounds(layer.chunked);
      const region =
        operation.region === undefined
          ? layer.chunked === undefined
            ? {
                x: layer.x,
                y: layer.y,
                width: layer.width,
                height: layer.height,
              }
            : (chunkedBounds ?? {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
              })
          : readReplaceTilesRegion(
              operation.region,
              operationIndex,
            );
      if (
        !Number.isSafeInteger(region.x + region.width) ||
        !Number.isSafeInteger(region.y + region.height)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}].region endpoints must be safe integers.`,
        );
      }
      if (layer.chunked === undefined) {
        assertRegionInsideLayer(
          layer,
          region.x,
          region.y,
          region.width,
          region.height,
        );
      } else if (region.width > 0) {
        assertChunkedRegionBounded(
          layer,
          operationIndex,
          region.x,
          region.y,
          region.width,
          region.height,
        );
      }
      let scannedCellCount =
        region.width * region.height;
      if (layer.chunked === undefined) {
        if (
          !Number.isSafeInteger(scannedCellCount) ||
          tileOperationScans + scannedCellCount >
            MAX_TILE_OPERATION_SCANS
        ) {
          throw new TiledMcpError(
            "RESULT_LIMIT_EXCEEDED",
            `A change set may perform at most ${MAX_TILE_OPERATION_SCANS} tile-cell reads across replaceTiles, floodFill and copyRegion operations.`,
            {
              limit: MAX_TILE_OPERATION_SCANS,
              actual:
                tileOperationScans +
                scannedCellCount,
            },
          );
        }
        tileOperationScans += scannedCellCount;
      }

      const replacements = new Map<number, number>();
      const sourceMappingIndexes = new Map<number, number>();
      for (const [
        mappingIndex,
        mapping,
      ] of operation.mappings.entries()) {
        if (!isRecordValue(mapping) || mapping.from === null) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `operations[${operationIndex}].mappings[${mappingIndex}].from must be a TileRef.`,
          );
        }
        const fromGid = tileRefToGid(
          mapping.from,
          orientation,
          bindings,
        );
        const toGid = tileRefToGid(
          mapping.to,
          orientation,
          bindings,
        );
        const duplicateIndex =
          sourceMappingIndexes.get(fromGid);
        if (duplicateIndex !== undefined) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `operations[${operationIndex}].mappings contains duplicate canonical source tiles.`,
            {
              operationIndex,
              mappingIndex,
              duplicateMappingIndex: duplicateIndex,
              fromGid,
            },
          );
        }
        if (fromGid === toGid) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `operations[${operationIndex}].mappings[${mappingIndex}] does not change the encoded tile value.`,
            { operationIndex, mappingIndex, gid: fromGid },
          );
        }
        sourceMappingIndexes.set(fromGid, mappingIndex);
        replacements.set(fromGid, toGid);
      }

      let replacedCellCount = 0;
      const applyReplacement = (
        x: number,
        y: number,
        currentGid: number,
      ): void => {
        // Replacement interprets every scanned cell, so malformed or
        // unbound GIDs fail closed even when they are not a mapping source.
        gidToTileRef(currentGid, orientation, bindings);
        const replacement = replacements.get(currentGid);
        if (replacement === undefined) {
          return;
        }
        if (
          cellWrites + replacedCellCount + 1 >
          MAX_CELL_WRITES
        ) {
          throw new TiledMcpError(
            "RESULT_LIMIT_EXCEEDED",
            `A change set may write at most ${MAX_CELL_WRITES} cells.`,
            { limit: MAX_CELL_WRITES },
          );
        }
        writeLayerGid(layer, x, y, replacement);
        replacedCellCount += 1;
      };
      if (layer.chunked === undefined) {
        for (
          let y = region.y;
          y < region.y + region.height;
          y += 1
        ) {
          for (
            let x = region.x;
            x < region.x + region.width;
            x += 1
          ) {
            applyReplacement(
              x,
              y,
              readLayerGid(layer, x, y),
            );
          }
        }
      } else {
        // Sparse layers scan only their stored nonzero cells: mapping
        // sources are nonzero tiles, so empty cells can never match.
        scannedCellCount = 0;
        for (const [key, currentGid] of [
          ...layer.chunked.cells,
        ]) {
          const comma = key.indexOf(",");
          const x = Number(key.slice(0, comma));
          const y = Number(key.slice(comma + 1));
          if (
            x < region.x ||
            y < region.y ||
            x >= region.x + region.width ||
            y >= region.y + region.height
          ) {
            continue;
          }
          if (
            tileOperationScans +
              scannedCellCount +
              1 >
            MAX_TILE_OPERATION_SCANS
          ) {
            throw new TiledMcpError(
              "RESULT_LIMIT_EXCEEDED",
              `A change set may perform at most ${MAX_TILE_OPERATION_SCANS} tile-cell reads across replaceTiles, floodFill and copyRegion operations.`,
              {
                limit: MAX_TILE_OPERATION_SCANS,
              },
            );
          }
          scannedCellCount += 1;
          applyReplacement(x, y, currentGid);
        }
        tileOperationScans += scannedCellCount;
      }
      if (replacedCellCount > 0) {
        affectedLayerIds.add(layer.id);
        affectedTileLayerIds.add(layer.id);
        finalizeChunkedTileLayerWrite(
          layer,
          map,
          mapPath,
          chunkedTileLayerIds,
        );
      }
      cellWrites += replacedCellCount;
      tileReplacements.push({
        operationIndex,
        layerId: layer.id,
        region,
        scannedCellCount,
        replacedCellCount,
        mappingCount: operation.mappings.length,
      });
    } else if (operation.type === "updateLayer") {
      assertPositiveInteger(
        operation.layerId,
        `operations[${operationIndex}].layerId`,
      );
      const update = updateCommonLayer(
        map,
        operation.layerId,
        operation.patch,
        mapPath,
        `operations[${operationIndex}].patch`,
      );
      if (update.changedFields.length > 0) {
        affectedLayerIds.add(update.layer.id);
        updatedLayerIds.add(update.layer.id);
        for (const field of update.changedFields) {
          changedLayerMembers.add(
            `${update.layer.id}:${layerPatchJsonKey(field)}`,
          );
        }
      }
      layerUpdates.push({
        operationIndex,
        layerId: update.layer.id,
        layerType: update.layer.type,
        requestedFields: update.requestedFields,
        changedFields: update.changedFields,
        wouldChange: update.changedFields.length > 0,
        affectsDescendants:
          update.layer.type === "group" &&
          update.changedFields.some((field) =>
            GROUP_DESCENDANT_RENDER_FIELDS.has(field),
          ),
      });
    } else if (operation.type === "deleteLayer") {
      const deleted = deleteExistingLayer(
        map,
        operation,
        mapPath,
        `operations[${operationIndex}]`,
      );
      affectedLayerIds.add(deleted.layerId);
      deletedLayers.push({
        operationIndex,
        ...deleted,
      });
    } else if (operation.type === "moveLayer") {
      const moved = moveExistingLayer(
        map,
        operation,
        mapPath,
        `operations[${operationIndex}]`,
      );
      if (moved.wouldChange) {
        affectedLayerIds.add(moved.layerId);
      }
      movedLayers.push({
        operationIndex,
        ...moved,
      });
    } else if (operation.type === "duplicateLayer") {
      const duplicated = duplicateExistingLayer(
        map,
        operation,
        bindings,
        mapPath,
        `operations[${operationIndex}]`,
        options.sourceBytes,
      );
      affectedLayerIds.add(
        duplicated.createdRootLayerId,
      );
      cellWrites += duplicated.allocatedCellCount;
      objectMutations += duplicated.copiedObjectCount;
      duplicatedLayers.push({
        operationIndex,
        ...duplicated,
      });
    } else if (operation.type === "createObject") {
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set(["layerId", "object", "type"]),
        `operations[${operationIndex}]`,
      );
      assertPositiveInteger(
        operation.layerId,
        `operations[${operationIndex}].layerId`,
      );
      const created = createBasicObject(
        map,
        operation.layerId,
        operation.object,
        mapPath,
        `operations[${operationIndex}].object`,
        getObjectIndex(),
        orientation,
        bindings,
      );
      textObjectPayloadBytes +=
        measureTextObjectPayloadBytes(
          operation.object as unknown as Readonly<
            Record<string, unknown>
          >,
        );
      assertTextObjectPayloadBudget(
        textObjectPayloadBytes,
      );
      if (
        operation.object.shape === "polygon" ||
        operation.object.shape === "polyline"
      ) {
        objectShapePoints += operation.object.points.length;
        assertObjectShapePointBudget(objectShapePoints);
      }
      affectedLayerIds.add(created.layer.id);
      affectedObjectLayerIds.add(created.layer.id);
      createdObjectIds.add(expectInteger(created.object.id, "created object id"));
      objectMutations += 1;
    } else if (
      operation.type === "instantiateTemplate"
    ) {
      assertExactObjectKeys(
        operation as unknown as Record<
          string,
          unknown
        >,
        new Set([
          "expectedTemplateRevision",
          "layerId",
          "source",
          "templatePath",
          "type",
          "x",
          "y",
        ]),
        `operations[${operationIndex}]`,
      );
      assertPositiveInteger(
        operation.layerId,
        `operations[${operationIndex}].layerId`,
      );
      const instanceLayer = findObjectLayer(
        map,
        operation.layerId,
        mapPath,
      );
      const nextObjectId = expectInteger(
        map.nextobjectid,
        `${mapPath}.nextobjectid`,
      );
      if (
        nextObjectId <= 0 ||
        nextObjectId >=
          Number.MAX_SAFE_INTEGER ||
        nextObjectId <=
          getObjectIndex().maximumId
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${mapPath}.nextobjectid must be a positive integer greater than every existing object id.`,
          { path: mapPath, nextObjectId },
        );
      }
      if (
        typeof operation.x !== "number" ||
        !Number.isFinite(operation.x) ||
        typeof operation.y !== "number" ||
        !Number.isFinite(operation.y)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}] x and y must be finite numbers.`,
        );
      }
      // Tiled's minimal template instance: everything else is inherited
      // from the template at load time.
      const instance: JsonObject = {
        id: nextObjectId,
        template: operation.source,
        x: operation.x,
        y: operation.y,
      };
      instanceLayer.objects.push(instance);
      instanceLayer.object.objects =
        instanceLayer.objects;
      map.nextobjectid = nextObjectId + 1;
      getObjectIndex().byId.set(nextObjectId, {
        object: instance,
        objectIndex:
          instanceLayer.objects.length - 1,
        layer: instanceLayer,
        ancestors: instanceLayer.ancestors,
      });
      getObjectIndex().maximumId = nextObjectId;
      affectedLayerIds.add(instanceLayer.id);
      affectedObjectLayerIds.add(
        instanceLayer.id,
      );
      createdObjectIds.add(nextObjectId);
      objectMutations += 1;
    } else if (operation.type === "updateObject") {
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set(["objectId", "patch", "type"]),
        `operations[${operationIndex}]`,
      );
      assertPositiveInteger(
        operation.objectId,
        `operations[${operationIndex}].objectId`,
      );
      const updated = updateBasicObject(
        operation.objectId,
        operation.patch,
        mapPath,
        `operations[${operationIndex}].patch`,
        getObjectIndex(),
        orientation,
        bindings,
      );
      textObjectPayloadBytes +=
        measureTextObjectPayloadBytes(
          operation.patch as Readonly<
            Record<string, unknown>
          >,
        );
      assertTextObjectPayloadBudget(
        textObjectPayloadBytes,
      );
      if (
        Object.prototype.hasOwnProperty.call(
          operation.patch,
          "points",
        )
      ) {
        objectShapePoints += operation.patch.points?.length ?? 0;
        assertObjectShapePointBudget(objectShapePoints);
      }
      if (operation.patch.properties !== undefined) {
        objectPropertyPatchBytes +=
          measurePropertiesPatchBytes(
            operation.patch.properties,
          );
        assertObjectPropertyPatchBudget(
          objectPropertyPatchBytes,
        );
      }
      affectedLayerIds.add(updated.layer.id);
      affectedObjectLayerIds.add(updated.layer.id);
      updatedObjectIds.add(operation.objectId);
      objectMutations += 1;
    } else if (operation.type === "deleteObjects") {
      assertExactObjectKeys(
        operation as unknown as Record<string, unknown>,
        new Set(["objectIds", "type"]),
        `operations[${operationIndex}]`,
      );
      if (
        !Array.isArray(operation.objectIds) ||
        operation.objectIds.length === 0
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${operationIndex}].objectIds must not be empty.`,
        );
      }
      if (operation.objectIds.length > MAX_OBJECT_MUTATIONS) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A deleteObjects operation may contain at most ${MAX_OBJECT_MUTATIONS} ids.`,
          { limit: MAX_OBJECT_MUTATIONS },
        );
      }
      const uniqueIds = new Set<number>();
      for (const [idIndex, objectId] of operation.objectIds.entries()) {
        assertPositiveInteger(
          objectId,
          `operations[${operationIndex}].objectIds[${idIndex}]`,
        );
        if (uniqueIds.has(objectId)) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `operations[${operationIndex}].objectIds contains duplicate id ${objectId}.`,
          );
        }
        uniqueIds.add(objectId);
      }
      const deletedLocations = deleteBasicObjects(
        map,
        operation.objectIds,
        mapPath,
        getObjectIndex(),
      );
      for (const deleted of deletedLocations) {
        const objectId = expectInteger(deleted.object.id, "deleted object id");
        affectedLayerIds.add(deleted.layer.id);
        affectedObjectLayerIds.add(deleted.layer.id);
        deletedObjectIds.add(objectId);
        objectMutations += 1;
      }
    } else {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `Unsupported edit operation type at index ${operationIndex}.`,
      );
    }
    if (cellWrites > MAX_CELL_WRITES) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `A change set may write at most ${MAX_CELL_WRITES} cells.`,
        { limit: MAX_CELL_WRITES },
      );
    }
    if (objectMutations > MAX_OBJECT_MUTATIONS) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `A change set may mutate at most ${MAX_OBJECT_MUTATIONS} objects.`,
        { limit: MAX_OBJECT_MUTATIONS },
      );
    }
  }

  const patchedSubtreeCount =
    affectedTileLayerIds.size +
    affectedObjectLayerIds.size +
    changedMapMembers.size +
    changedLayerMembers.size +
    (createdObjectIds.size > 0 ? 1 : 0) +
    (addedTilesets.length > 0 ? 1 : 0) +
    (removedTilesets.length > 0 ? 1 : 0) +
    (createdLayers.length > 0 ? 2 : 0) +
    duplicatedLayers.reduce(
      (count, duplicated) =>
        count +
        2 +
        (duplicated.copiedObjectCount > 0 ? 1 : 0),
      0,
    ) +
    (deletedLayers.length > 0 ? 1 : 0) +
    movedLayers.reduce(
      (count, move) =>
        count +
        (move.wouldChange
          ? move.sourceParentGroupId ===
            move.targetParentGroupId
            ? 1
            : 2
          : 0),
      0,
    ) +
    mapResizes.reduce((count, resize) => {
      const changedDimensionMembers =
        (resize.newWidth !== resize.oldWidth ? 1 : 0) +
        (resize.newHeight !== resize.oldHeight ? 1 : 0);
      const changedOffsetMembers =
        (resize.pixelOffsetX !== 0 ? 1 : 0) +
        (resize.pixelOffsetY !== 0 ? 1 : 0);
      return (
        count +
        changedDimensionMembers *
          (1 + resize.resizedTileLayerIds.length) +
        changedOffsetMembers *
          resize.shiftedImageLayerIds.length
      );
    }, 0);
  if (patchedSubtreeCount > MAX_PATCHED_SUBTREES) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A change set may rewrite at most ${MAX_PATCHED_SUBTREES} JSON subtrees.`,
      { limit: MAX_PATCHED_SUBTREES, actual: patchedSubtreeCount },
    );
  }

  return {
    operationCount: operations.length,
    cellWrites,
    affectedLayerIds: [...affectedLayerIds].sort((left, right) => left - right),
    affectedTileLayerIds: [...affectedTileLayerIds].sort(
      (left, right) => left - right,
    ),
    ...(chunkedTileLayerIds.size === 0
      ? {}
      : {
          chunkedTileLayerIds: [
            ...chunkedTileLayerIds,
          ].sort((left, right) => left - right),
        }),
    affectedObjectLayerIds: [...affectedObjectLayerIds].sort(
      (left, right) => left - right,
    ),
    createdObjectIds: [...createdObjectIds].sort((left, right) => left - right),
    updatedObjectIds: [...updatedObjectIds].sort((left, right) => left - right),
    deletedObjectIds: [...deletedObjectIds].sort((left, right) => left - right),
    ...(mapUpdates.length === 0
      ? {}
      : { mapUpdates }),
    ...(mapResizes.length === 0
      ? {}
      : { mapResizes }),
    ...(transcodes.length === 0
      ? {}
      : { transcodes }),
    ...(layerUpdates.length === 0
      ? {}
      : {
          updatedLayerIds: [...updatedLayerIds].sort(
            (left, right) => left - right,
          ),
          layerUpdates,
        }),
    ...(tileReplacements.length === 0
      ? {}
      : { tileReplacements }),
    ...(tileStamps.length === 0
      ? {}
      : { tileStamps }),
    ...(tileFloodFills.length === 0
      ? {}
      : { tileFloodFills }),
    ...(tileCopies.length === 0
      ? {}
      : { tileCopies }),
    ...(addedTilesets.length === 0 ? {} : { addedTilesets }),
    ...(removedTilesets.length === 0
      ? {}
      : { removedTilesets }),
    ...(createdLayers.length === 0 ? {} : { createdLayers }),
    ...(deletedLayers.length === 0 ? {} : { deletedLayers }),
    ...(movedLayers.length === 0 ? {} : { movedLayers }),
    ...(duplicatedLayers.length === 0
      ? {}
      : { duplicatedLayers }),
  };
}

interface ResizeTileLayerScanView {
  object: JsonObject;
  id: number;
  width: number;
  height: number;
  data: JsonValue[];
}

interface ResizeObjectLayerScanView {
  object: JsonObject;
  id: number;
  objects: JsonValue[];
}

interface ResizeImageLayerScanView {
  object: JsonObject;
  id: number;
}

interface ResizeLayerViews {
  tileLayers: ResizeTileLayerScanView[];
  objectLayers: ResizeObjectLayerScanView[];
  imageLayers: ResizeImageLayerScanView[];
  groupLayerCount: number;
  lockedLayerCount: number;
}

function readResizeMapInput(
  operation: Record<string, unknown>,
  operationContext: string,
): { width: number; height: number; offsetX: number; offsetY: number } {
  const { width, height } = operation;
  if (typeof width !== "number" || typeof height !== "number") {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${operationContext} width and height must be numbers.`,
    );
  }
  assertPositiveIntegerAtMost(
    width,
    `${operationContext}.width`,
    MAX_RESIZE_MAP_DIMENSION,
  );
  assertPositiveIntegerAtMost(
    height,
    `${operationContext}.height`,
    MAX_RESIZE_MAP_DIMENSION,
  );
  const readOffset = (key: "offsetX" | "offsetY"): number => {
    const value = operation[key];
    if (value === undefined) {
      return 0;
    }
    if (typeof value !== "number") {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${operationContext}.${key} must be an integer.`,
      );
    }
    assertSafeInteger(value, `${operationContext}.${key}`);
    if (Math.abs(value) > MAX_RESIZE_OFFSET_MAGNITUDE) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${operationContext}.${key} magnitude must be at most ${MAX_RESIZE_OFFSET_MAGNITUDE}.`,
        {
          option: `${operationContext}.${key}`,
          limit: MAX_RESIZE_OFFSET_MAGNITUDE,
          actual: value,
        },
      );
    }
    return value;
  };
  return {
    width,
    height,
    offsetX: readOffset("offsetX"),
    offsetY: readOffset("offsetY"),
  };
}

function collectResizeLayerViews(
  map: JsonObject,
  oldWidth: number,
  oldHeight: number,
  mapPath: string,
  operationContext: string,
): ResizeLayerViews {
  const tileLayers: ResizeTileLayerScanView[] = [];
  const objectLayers: ResizeObjectLayerScanView[] = [];
  const imageLayers: ResizeImageLayerScanView[] = [];
  let groupLayerCount = 0;
  let lockedLayerCount = 0;
  const budget: LayerTraversalBudget = { count: 0 };
  const visit = (
    entries: JsonValue[],
    context: string,
    depth: number,
  ): void => {
    assertLayerTraversalBudget(entries.length, depth, budget);
    for (const [index, value] of entries.entries()) {
      const layer = expectObject(value, `${context}[${index}]`);
      const layerType = expectString(
        layer.type,
        `${context}[${index}].type`,
      );
      const layerId = expectInteger(
        layer.id,
        `${context}[${index}].id`,
      );
      if (layer.locked === true) {
        lockedLayerCount += 1;
      }
      if (layerType === "tilelayer") {
        if ("chunks" in layer || typeof layer.data === "string") {
          throw new TiledMcpError(
            "UNSUPPORTED_TILE_ENCODING",
            "MVP editing supports only finite JSON tile layers with numeric data arrays.",
            { path: mapPath, layerId },
          );
        }
        const width = expectInteger(layer.width, `layer ${layerId}.width`);
        const height = expectInteger(layer.height, `layer ${layerId}.height`);
        assertPositiveInteger(width, `layer ${layerId}.width`);
        assertPositiveInteger(height, `layer ${layerId}.height`);
        const x = readOptionalInteger(layer.x, `layer ${layerId}.x`, 0);
        const y = readOptionalInteger(layer.y, `layer ${layerId}.y`, 0);
        if (
          x !== 0 ||
          y !== 0 ||
          width !== oldWidth ||
          height !== oldHeight
        ) {
          throw new TiledMcpError(
            "UNSUPPORTED_RESIZE_LAYER_BOUNDS",
            `${operationContext} cannot resize this map: tile layer ${layerId} bounds do not match the map bounds, and Tiled 1.12 leaves resize semantics for such layers undefined.`,
            {
              path: mapPath,
              layerId,
              layerBounds: { x, y, width, height },
              mapBounds: {
                x: 0,
                y: 0,
                width: oldWidth,
                height: oldHeight,
              },
            },
          );
        }
        const data = expectArray(layer.data, `layer ${layerId}.data`);
        if (data.length !== width * height) {
          throw new TiledMcpError(
            "INVALID_TILE_DATA",
            `Layer ${layerId} data length does not match width × height.`,
            { layerId, expected: width * height, actual: data.length },
          );
        }
        tileLayers.push({
          object: layer,
          id: layerId,
          width,
          height,
          data,
        });
      } else if (layerType === "objectgroup") {
        objectLayers.push({
          object: layer,
          id: layerId,
          objects: expectArray(
            layer.objects,
            `layer ${layerId}.objects`,
          ),
        });
      } else if (layerType === "imagelayer") {
        imageLayers.push({ object: layer, id: layerId });
      } else if (layerType === "group") {
        groupLayerCount += 1;
        visit(
          expectArray(layer.layers, `layer ${layerId}.layers`),
          `${context}[${index}].layers`,
          depth + 1,
        );
      } else {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${context}[${index}].type is not a supported Tiled layer type.`,
          { layerType },
        );
      }
    }
  };
  visit(
    expectArray(map.layers, `${mapPath}.layers`),
    `${mapPath}.layers`,
    0,
  );
  return {
    tileLayers,
    objectLayers,
    imageLayers,
    groupLayerCount,
    lockedLayerCount,
  };
}

function performMapResize(
  map: JsonObject,
  orientation:
    | "orthogonal"
    | "isometric"
    | "staggered"
    | "hexagonal",
  bindings: readonly TilesetBinding[],
  views: ResizeLayerViews,
  input: {
    operationContext: string;
    mapPath: string;
    oldWidth: number;
    oldHeight: number;
    newWidth: number;
    newHeight: number;
    offsetX: number;
    offsetY: number;
    pixelOffsetX: number;
    pixelOffsetY: number;
    tileWidth: number;
    tileHeight: number;
    objectMutationsUsed: number;
  },
): {
  wouldChange: boolean;
  mapDimensionsChanged: boolean;
  dataChangedTileLayerIds: number[];
  preservedNonEmptyCellCount: number;
  croppedNonEmptyCellCount: number;
  croppedCellSample: Array<{
    layerId: number;
    x: number;
    y: number;
    gid: number;
  }>;
  objectShiftedLayerIds: number[];
  movedObjectCount: number;
  objectsOutsideNewBounds: number;
  shiftedImageLayerIds: number[];
} {
  const {
    operationContext,
    mapPath,
    newWidth,
    newHeight,
    offsetX,
    offsetY,
    pixelOffsetX,
    pixelOffsetY,
  } = input;
  const newArea = newWidth * newHeight;
  const dataChangedTileLayerIds: number[] = [];
  const croppedCellSample: Array<{
    layerId: number;
    x: number;
    y: number;
    gid: number;
  }> = [];
  let preservedNonEmptyCellCount = 0;
  let croppedNonEmptyCellCount = 0;
  for (const layer of views.tileLayers) {
    const newData: number[] = new Array<number>(newArea).fill(0);
    for (let y = 0; y < layer.height; y += 1) {
      for (let x = 0; x < layer.width; x += 1) {
        const raw = layer.data[y * layer.width + x];
        if (
          typeof raw !== "number" ||
          !Number.isSafeInteger(raw)
        ) {
          throw new TiledMcpError(
            "INVALID_TILE_DATA",
            `Layer ${layer.id} has a non-integer GID.`,
            { layerId: layer.id, x, y },
          );
        }
        // Every scanned source cell resolves fail closed, so cropping can
        // never silently discard a malformed or unbound encoded GID.
        gidToTileRef(raw, orientation, bindings);
        const destX = x + offsetX;
        const destY = y + offsetY;
        if (
          destX >= 0 &&
          destX < newWidth &&
          destY >= 0 &&
          destY < newHeight
        ) {
          newData[destY * newWidth + destX] = raw;
          if (raw !== 0) {
            preservedNonEmptyCellCount += 1;
          }
        } else if (raw !== 0) {
          croppedNonEmptyCellCount += 1;
          if (
            croppedCellSample.length <
            MAX_RESIZE_CROPPED_CELL_SAMPLE
          ) {
            croppedCellSample.push({
              layerId: layer.id,
              x,
              y,
              gid: raw,
            });
          }
        }
      }
    }
    let changed =
      layer.width !== newWidth || layer.height !== newHeight;
    if (!changed) {
      for (let index = 0; index < newArea; index += 1) {
        if (newData[index] !== layer.data[index]) {
          changed = true;
          break;
        }
      }
    }
    layer.object.width = newWidth;
    layer.object.height = newHeight;
    layer.object.data = newData;
    if (changed) {
      dataChangedTileLayerIds.push(layer.id);
    }
  }

  const shifting = pixelOffsetX !== 0 || pixelOffsetY !== 0;
  const newPixelWidth = newWidth * input.tileWidth;
  const newPixelHeight = newHeight * input.tileHeight;
  const objectShiftedLayerIds: number[] = [];
  let movedObjectCount = 0;
  let objectsOutsideNewBounds = 0;
  let visitedObjects = 0;
  for (const layer of views.objectLayers) {
    let layerShifted = false;
    for (const [objectIndex, value] of layer.objects.entries()) {
      visitedObjects += 1;
      if (visitedObjects > MAX_OBJECT_COUNT) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A resizeMap operation may scan at most ${MAX_OBJECT_COUNT} objects.`,
          { limit: MAX_OBJECT_COUNT },
        );
      }
      const objectRecord = expectObject(
        value,
        `layer ${layer.id}.objects[${objectIndex}]`,
      );
      if (
        shifting &&
        Object.prototype.hasOwnProperty.call(
          objectRecord,
          "template",
        )
      ) {
        throw new TiledMcpError(
          "UNSUPPORTED_RESIZE_TEMPLATE",
          `${operationContext} cannot move template objects: template semantics are outside the supported editing profile.`,
          {
            path: mapPath,
            layerId: layer.id,
          },
        );
      }
      const x = objectRecord.x;
      const y = objectRecord.y;
      if (
        typeof x !== "number" ||
        !Number.isFinite(x) ||
        typeof y !== "number" ||
        !Number.isFinite(y)
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `layer ${layer.id}.objects[${objectIndex}] must have finite numeric x and y coordinates.`,
          { path: mapPath, layerId: layer.id },
        );
      }
      let finalX = x;
      let finalY = y;
      if (shifting) {
        finalX = x + pixelOffsetX;
        finalY = y + pixelOffsetY;
        if (
          !Number.isFinite(finalX) ||
          Math.abs(finalX) > MAX_ABSOLUTE_OBJECT_NUMBER ||
          !Number.isFinite(finalY) ||
          Math.abs(finalY) > MAX_ABSOLUTE_OBJECT_NUMBER
        ) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `${operationContext} would move object coordinates beyond ±${MAX_ABSOLUTE_OBJECT_NUMBER} map pixels.`,
            {
              limit: MAX_ABSOLUTE_OBJECT_NUMBER,
              layerId: layer.id,
            },
          );
        }
        objectRecord.x = finalX;
        objectRecord.y = finalY;
        movedObjectCount += 1;
        if (
          input.objectMutationsUsed + movedObjectCount >
          MAX_OBJECT_MUTATIONS
        ) {
          throw new TiledMcpError(
            "RESULT_LIMIT_EXCEEDED",
            `A change set may mutate at most ${MAX_OBJECT_MUTATIONS} objects.`,
            { limit: MAX_OBJECT_MUTATIONS },
          );
        }
        layerShifted = true;
      }
      if (
        finalX < 0 ||
        finalX > newPixelWidth ||
        finalY < 0 ||
        finalY > newPixelHeight
      ) {
        objectsOutsideNewBounds += 1;
      }
    }
    if (layerShifted) {
      objectShiftedLayerIds.push(layer.id);
    }
  }

  const shiftedImageLayerIds: number[] = [];
  if (shifting) {
    for (const layer of views.imageLayers) {
      const applyOffsetShift = (
        key: "offsetx" | "offsety",
        delta: number,
      ): void => {
        if (delta === 0) {
          return;
        }
        const current = layer.object[key];
        if (
          current !== undefined &&
          (typeof current !== "number" ||
            !Number.isFinite(current))
        ) {
          throw new TiledMcpError(
            "INVALID_DOCUMENT",
            `layer ${layer.id}.${key} must be a finite number.`,
            { path: mapPath, layerId: layer.id },
          );
        }
        const base = typeof current === "number" ? current : 0;
        const next = base + delta;
        if (
          !Number.isFinite(next) ||
          Math.abs(next) > MAX_ABSOLUTE_OBJECT_NUMBER
        ) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `${operationContext} would move image layer ${layer.id} offsets beyond ±${MAX_ABSOLUTE_OBJECT_NUMBER} map pixels.`,
            {
              limit: MAX_ABSOLUTE_OBJECT_NUMBER,
              layerId: layer.id,
            },
          );
        }
        layer.object[key] = next;
      };
      applyOffsetShift("offsetx", pixelOffsetX);
      applyOffsetShift("offsety", pixelOffsetY);
      shiftedImageLayerIds.push(layer.id);
    }
  }

  const mapDimensionsChanged =
    newWidth !== input.oldWidth || newHeight !== input.oldHeight;
  if (mapDimensionsChanged) {
    map.width = newWidth;
    map.height = newHeight;
  }
  return {
    wouldChange:
      mapDimensionsChanged ||
      dataChangedTileLayerIds.length > 0 ||
      movedObjectCount > 0 ||
      shiftedImageLayerIds.length > 0,
    mapDimensionsChanged,
    dataChangedTileLayerIds,
    preservedNonEmptyCellCount,
    croppedNonEmptyCellCount,
    croppedCellSample,
    objectShiftedLayerIds,
    movedObjectCount,
    objectsOutsideNewBounds,
    shiftedImageLayerIds,
  };
}

function assertResolvedAddTilesetOperation(
  operation: ResolvedAddTilesetToMapOperation,
): void {
  const expectedKeys = [
    "assetId",
    "firstGid",
    "gidSpan",
    "source",
    "tileCount",
    "tilesetPath",
    "tilesetRevision",
    "type",
  ];
  const actualKeys = Object.keys(operation).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The resolved add-tileset operation has unexpected fields.",
    );
  }
  if (
    operation.type !== "addTilesetToMap" ||
    typeof operation.tilesetPath !== "string" ||
    posix.extname(operation.tilesetPath).toLowerCase() !== ".tsj" ||
    typeof operation.source !== "string" ||
    operation.source.length === 0 ||
    operation.source.includes("\\") ||
    posix.isAbsolute(operation.source) ||
    posix.normalize(operation.source) !== operation.source ||
    typeof operation.assetId !== "string" ||
    !/^asset_[0-9a-f]{24}$/u.test(operation.assetId) ||
    typeof operation.tilesetRevision !== "string" ||
    !REVISION_PATTERN.test(operation.tilesetRevision) ||
    !Number.isSafeInteger(operation.tileCount) ||
    operation.tileCount <= 0 ||
    !Number.isSafeInteger(operation.gidSpan) ||
    operation.gidSpan < operation.tileCount ||
    !Number.isSafeInteger(operation.firstGid) ||
    operation.firstGid <= 0 ||
    operation.firstGid + operation.gidSpan - 1 > 0x0fffffff
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The resolved add-tileset operation is malformed.",
    );
  }
}

function applyResolvedCreateLayer(
  map: JsonObject,
  operation: ResolvedCreateLayerOperation,
  mapPath: string,
): { allocatedCellCount: number } {
  const rootLayers = expectArray(map.layers, `${mapPath}.layers`);
  const inventory = inspectLayerTree(rootLayers, mapPath);
  if (inventory.count >= MAX_LAYER_COUNT) {
    throw new TiledMcpError(
      "LAYER_LIMIT_EXCEEDED",
      `A map may contain at most ${MAX_LAYER_COUNT} layers.`,
      { path: mapPath, limit: MAX_LAYER_COUNT },
    );
  }
  const nextLayerId = expectInteger(
    map.nextlayerid,
    `${mapPath}.nextlayerid`,
  );
  if (
    nextLayerId !== operation.layerId ||
    nextLayerId <= inventory.maximumId
  ) {
    throw new TiledMcpError(
      "NEXT_LAYER_ID_INVALID",
      "The planned layer id no longer matches the map nextlayerid high-water mark.",
      {
        path: mapPath,
        plannedLayerId: operation.layerId,
        nextLayerId,
        maximumExistingId: inventory.maximumId,
      },
    );
  }
  if (nextLayerId >= MAX_TILED_SIGNED_ID) {
    throw new TiledMcpError(
      "LAYER_ID_EXHAUSTED",
      "The map has exhausted Tiled's signed 32-bit layer id space.",
      { path: mapPath, nextLayerId },
    );
  }

  const placement = layerContainerForParent(
    map,
    operation.parentGroupId,
    mapPath,
  );
  if (placement.childDepth > MAX_LAYER_DEPTH) {
    throw new TiledMcpError(
      "LAYER_LIMIT_EXCEEDED",
      `Creating this layer would exceed the maximum layer depth ${MAX_LAYER_DEPTH}.`,
      {
        path: mapPath,
        childDepth: placement.childDepth,
        limit: MAX_LAYER_DEPTH,
      },
    );
  }
  if (operation.index > placement.layers.length) {
    throw new TiledMcpError(
      "LAYER_INDEX_OUT_OF_RANGE",
      "The planned insertion index no longer exists in the target layer container.",
      {
        path: mapPath,
        parentGroupId: operation.parentGroupId,
        index: operation.index,
        maximum: placement.layers.length,
      },
    );
  }

  const common = {
    id: operation.layerId,
    name: operation.name,
    opacity: 1,
    type: operation.layerType,
    visible: true,
    x: 0,
    y: 0,
  } satisfies JsonObject;
  let layer: JsonObject;
  let allocatedCellCount = 0;
  if (operation.layerType === "tilelayer") {
    const width = expectInteger(map.width, `${mapPath}.width`);
    const height = expectInteger(map.height, `${mapPath}.height`);
    allocatedCellCount = width * height;
    if (
      width <= 0 ||
      height <= 0 ||
      !Number.isSafeInteger(allocatedCellCount) ||
      allocatedCellCount > MAX_CREATE_TILE_LAYER_CELLS
    ) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `A new tile layer may allocate at most ${MAX_CREATE_TILE_LAYER_CELLS} cells.`,
        {
          path: mapPath,
          width,
          height,
          actual: Number.isSafeInteger(allocatedCellCount)
            ? allocatedCellCount
            : null,
          limit: MAX_CREATE_TILE_LAYER_CELLS,
        },
      );
    }
    layer = {
      data: Array.from({ length: allocatedCellCount }, () => 0),
      height,
      ...common,
      width,
    };
  } else if (operation.layerType === "objectgroup") {
    layer = {
      draworder: "topdown",
      ...common,
      objects: [],
    };
  } else if (operation.layerType === "group") {
    layer = {
      id: common.id,
      layers: [],
      name: common.name,
      opacity: common.opacity,
      type: common.type,
      visible: common.visible,
      x: common.x,
      y: common.y,
    };
  } else {
    const image = operation.image;
    if (image === undefined) {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "The image layer is missing its pinned image dependency.",
      );
    }
    layer = {
      id: common.id,
      image: image.source,
      imageheight: image.height,
      imagewidth: image.width,
      name: common.name,
      opacity: common.opacity,
      type: common.type,
      visible: common.visible,
      x: common.x,
      y: common.y,
    };
  }

  if (operation.allocatedCellCount !== allocatedCellCount) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The planned layer cell allocation does not match the current map dimensions.",
      {
        path: mapPath,
        planned: operation.allocatedCellCount,
        actual: allocatedCellCount,
      },
    );
  }
  placement.layers.splice(operation.index, 0, layer);
  map.nextlayerid = operation.layerId + 1;
  return { allocatedCellCount };
}

function moveExistingLayer(
  map: JsonObject,
  operation: Extract<
    MapEditOperation,
    { type: "moveLayer" }
  >,
  mapPath: string,
  context: string,
): Omit<
  NonNullable<
    MapEditPlan["summary"]["movedLayers"]
  >[number],
  "operationIndex"
> {
  const allowedKeys = new Set([
    "type",
    "layerId",
    "parentGroupId",
    "index",
  ]);
  const unknownKey = Object.keys(operation).find(
    (key) => !allowedKeys.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }
  assertPositiveInteger(
    operation.layerId,
    `${context}.layerId`,
  );
  if (operation.parentGroupId !== undefined) {
    assertPositiveInteger(
      operation.parentGroupId,
      `${context}.parentGroupId`,
    );
  }
  if (
    !Number.isSafeInteger(operation.index) ||
    operation.index < 0
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.index must be a non-negative safe integer.`,
    );
  }

  const source = findDeletableLayer(
    map,
    operation.layerId,
    mapPath,
  );
  const inspection = inspectLayerSubtree(
    source.object,
    mapPath,
  );
  const targetParentGroupId =
    operation.parentGroupId ?? null;
  if (
    targetParentGroupId !== null &&
    inspection.layerIds.includes(targetParentGroupId)
  ) {
    throw new TiledMcpError(
      "LAYER_MOVE_CYCLE",
      `Layer ${operation.layerId} cannot be moved into itself or one of its descendants.`,
      {
        path: mapPath,
        layerId: operation.layerId,
        parentGroupId: targetParentGroupId,
      },
    );
  }

  const sourcePlacement = layerContainerForParent(
    map,
    source.parentGroupId,
    mapPath,
  );
  if (
    sourcePlacement.layers !== source.container ||
    sourcePlacement.layers[source.index] !== source.object
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Layer ${operation.layerId} moved during change-set planning.`,
      { path: mapPath, layerId: operation.layerId },
    );
  }
  const targetPlacement = layerContainerForParent(
    map,
    targetParentGroupId,
    mapPath,
  );
  const sameContainer =
    sourcePlacement.layers === targetPlacement.layers;
  const maximumTargetIndex = sameContainer
    ? targetPlacement.layers.length - 1
    : targetPlacement.layers.length;
  if (operation.index > maximumTargetIndex) {
    throw new TiledMcpError(
      "LAYER_INDEX_OUT_OF_RANGE",
      sameContainer
        ? `Final index ${operation.index} is outside sibling range 0..${maximumTargetIndex}.`
        : `Final index ${operation.index} is outside target insertion range 0..${maximumTargetIndex}.`,
      {
        path: mapPath,
        layerId: operation.layerId,
        parentGroupId: targetParentGroupId,
        index: operation.index,
        maximumIndex: maximumTargetIndex,
        indexSemantics: "final-index-after-move",
      },
    );
  }
  const resultingDepth =
    targetPlacement.childDepth +
    inspection.maxRelativeDepth;
  if (resultingDepth > MAX_LAYER_DEPTH) {
    throw new TiledMcpError(
      "LAYER_DEPTH_EXCEEDED",
      `Moving layer ${operation.layerId} would exceed the maximum layer depth ${MAX_LAYER_DEPTH}.`,
      {
        path: mapPath,
        layerId: operation.layerId,
        parentGroupId: targetParentGroupId,
        resultingDepth,
        maxDepth: MAX_LAYER_DEPTH,
      },
    );
  }

  const wouldChange =
    !sameContainer || source.index !== operation.index;
  const rawName =
    typeof source.object.name === "string"
      ? source.object.name
      : `Layer ${source.id}`;
  const displayName = boundedDisplayString(rawName);
  if (wouldChange) {
    const [moved] = sourcePlacement.layers.splice(
      source.index,
      1,
    );
    if (moved !== source.object) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `Layer ${operation.layerId} disappeared during change-set planning.`,
        { path: mapPath, layerId: operation.layerId },
      );
    }
    targetPlacement.layers.splice(
      operation.index,
      0,
      moved,
    );
  }

  const renderContextMayChange =
    wouldChange &&
    source.parentGroupId !== targetParentGroupId;
  const descendantLayerCount =
    inspection.layerIds.length - 1;
  const layerIdSample = inspection.layerIds.slice(
    0,
    MAX_LAYER_OPERATION_ID_SAMPLE,
  );
  return {
    layerId: source.id,
    layerType: source.type,
    name: displayName.value,
    nameTruncated: displayName.truncated,
    sourceParentGroupId: source.parentGroupId,
    sourceIndex: source.index,
    targetParentGroupId,
    targetIndex: operation.index,
    subtreeLayerCount: inspection.layerIds.length,
    descendantLayerCount,
    layerIdSample,
    omittedLayerCount:
      inspection.layerIds.length - layerIdSample.length,
    objectCount: inspection.objectIds.length,
    lockedLayerCount: inspection.lockedLayerCount,
    sourceParentLocked: sourcePlacement.parentLocked,
    targetParentLocked: targetPlacement.parentLocked,
    effectivelyLockedLayerCountBefore:
      sourcePlacement.effectiveParentLocked
        ? inspection.layerIds.length
        : inspection.effectivelyLockedLayerCount,
    effectivelyLockedLayerCountAfter:
      targetPlacement.effectiveParentLocked
        ? inspection.layerIds.length
        : inspection.effectivelyLockedLayerCount,
    wouldChange,
    renderOrderMayChange: wouldChange,
    renderContextMayChange,
    affectsDescendants:
      wouldChange &&
      source.type === "group" &&
      descendantLayerCount > 0,
  };
}

// Duplication deliberately has its own exclusive planner because it allocates
// IDs, rewires typed references, and inserts one synthesized subtree.
function duplicateExistingLayer(
  map: JsonObject,
  operation: Extract<
    MapEditOperation,
    { type: "duplicateLayer" }
  >,
  bindings: readonly TilesetBinding[],
  mapPath: string,
  context: string,
  sourceBytes: number | undefined,
): Omit<
  NonNullable<
    MapEditPlan["summary"]["duplicatedLayers"]
  >[number],
  "operationIndex"
> {
  const allowedKeys = new Set([
    "type",
    "layerId",
    "destination",
    "name",
  ]);
  const unknownKey = Object.keys(operation).find(
    (key) => !allowedKeys.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }
  assertPositiveInteger(
    operation.layerId,
    `${context}.layerId`,
  );
  if (operation.name !== undefined) {
    assertBoundedString(
      operation.name,
      `${context}.name`,
    );
  }
  if (
    sourceBytes === undefined ||
    !Number.isSafeInteger(sourceBytes) ||
    sourceBytes < 0
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "duplicateLayer requires the original source byte length.",
      { path: mapPath },
    );
  }

  const source = findDeletableLayer(
    map,
    operation.layerId,
    mapPath,
  );
  const sourcePlacement = layerContainerForParent(
    map,
    source.parentGroupId,
    mapPath,
  );
  if (
    sourcePlacement.layers !== source.container ||
    sourcePlacement.layers[source.index] !== source.object
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Layer ${operation.layerId} moved during change-set planning.`,
      { path: mapPath, layerId: operation.layerId },
    );
  }
  const sourceName = expectString(
    source.object.name,
    `layer ${operation.layerId}.name`,
  );
  const inspection = inspectLayerSubtree(
    source.object,
    mapPath,
  );

  const destination = operation.destination;
  let targetParentGroupId: number | null;
  let requestedIndex: number | undefined;
  let defaultAdjacent = false;
  if (destination === undefined) {
    targetParentGroupId = source.parentGroupId;
    defaultAdjacent = true;
  } else {
    if (!isRecordValue(destination)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.destination must be an object.`,
      );
    }
    if (destination.kind === "sameParent") {
      assertExactObjectKeys(
        destination,
        new Set(["kind", "index"]),
        `${context}.destination`,
      );
      targetParentGroupId = source.parentGroupId;
      requestedIndex = destination.index;
      defaultAdjacent = destination.index === undefined;
    } else if (destination.kind === "root") {
      assertExactObjectKeys(
        destination,
        new Set(["kind", "index"]),
        `${context}.destination`,
      );
      targetParentGroupId = null;
      requestedIndex = destination.index;
    } else if (destination.kind === "group") {
      assertExactObjectKeys(
        destination,
        new Set(["kind", "parentGroupId", "index"]),
        `${context}.destination`,
      );
      assertPositiveInteger(
        destination.parentGroupId,
        `${context}.destination.parentGroupId`,
      );
      targetParentGroupId = destination.parentGroupId;
      requestedIndex = destination.index;
      if (
        inspection.layerIds.includes(
          destination.parentGroupId,
        )
      ) {
        throw new TiledMcpError(
          "DUPLICATE_LAYER_TARGET_IN_SOURCE_SUBTREE",
          `Layer ${operation.layerId} cannot be duplicated into itself or one of its descendants.`,
          {
            path: mapPath,
            layerId: operation.layerId,
            parentGroupId: destination.parentGroupId,
          },
        );
      }
    } else {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.destination.kind must be sameParent, root, or group.`,
      );
    }
  }
  if (
    requestedIndex !== undefined &&
    (!Number.isSafeInteger(requestedIndex) ||
      requestedIndex < 0)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.destination.index must be a non-negative safe integer.`,
    );
  }

  const targetPlacement = layerContainerForParent(
    map,
    targetParentGroupId,
    mapPath,
  );
  const targetIndex = defaultAdjacent
    ? source.index + 1
    : (requestedIndex ?? targetPlacement.layers.length);
  if (targetIndex > targetPlacement.layers.length) {
    throw new TiledMcpError(
      "LAYER_INDEX_OUT_OF_RANGE",
      `Duplicate insertion index ${targetIndex} is outside target range 0..${targetPlacement.layers.length}.`,
      {
        path: mapPath,
        layerId: operation.layerId,
        parentGroupId: targetParentGroupId,
        index: targetIndex,
        maximumIndex: targetPlacement.layers.length,
        indexSemantics: "final-insertion-index",
      },
    );
  }
  const resultingDepth =
    targetPlacement.childDepth +
    inspection.maxRelativeDepth;
  if (resultingDepth > MAX_LAYER_DEPTH) {
    throw new TiledMcpError(
      "LAYER_DEPTH_EXCEEDED",
      `Duplicating layer ${operation.layerId} at the selected destination would exceed the maximum layer depth ${MAX_LAYER_DEPTH}.`,
      {
        path: mapPath,
        layerId: operation.layerId,
        parentGroupId: targetParentGroupId,
        resultingDepth,
        maxDepth: MAX_LAYER_DEPTH,
      },
    );
  }

  const rootLayers = expectArray(
    map.layers,
    `${mapPath}.layers`,
  );
  const layerInventory = inspectLayerTree(
    rootLayers,
    mapPath,
  );
  if (
    layerInventory.count + inspection.layerIds.length >
    MAX_LAYER_COUNT
  ) {
    throw new TiledMcpError(
      "LAYER_LIMIT_EXCEEDED",
      `Duplicating this subtree would exceed the map layer limit ${MAX_LAYER_COUNT}.`,
      {
        path: mapPath,
        existing: layerInventory.count,
        copied: inspection.layerIds.length,
        limit: MAX_LAYER_COUNT,
      },
    );
  }
  const objectIndex = buildObjectEditIndex(
    map,
    mapPath,
  );
  if (
    objectIndex.byId.size + inspection.objectIds.length >
    MAX_OBJECT_COUNT
  ) {
    throw new TiledMcpError(
      "OBJECT_LIMIT_EXCEEDED",
      `Duplicating this subtree would exceed the map object limit ${MAX_OBJECT_COUNT}.`,
      {
        path: mapPath,
        existing: objectIndex.byId.size,
        copied: inspection.objectIds.length,
        limit: MAX_OBJECT_COUNT,
      },
    );
  }
  if (
    inspection.objectIds.length >
    MAX_OBJECT_MUTATIONS
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A duplicateLayer operation may copy at most ${MAX_OBJECT_MUTATIONS} objects.`,
      {
        path: mapPath,
        actual: inspection.objectIds.length,
        limit: MAX_OBJECT_MUTATIONS,
      },
    );
  }

  const nextLayerId = expectInteger(
    map.nextlayerid,
    `${mapPath}.nextlayerid`,
  );
  if (
    nextLayerId <= 0 ||
    nextLayerId <= layerInventory.maximumId
  ) {
    throw new TiledMcpError(
      "NEXT_LAYER_ID_INVALID",
      `${mapPath}.nextlayerid must be greater than every existing layer id.`,
      {
        path: mapPath,
        nextLayerId,
        maximumExistingId: layerInventory.maximumId,
      },
    );
  }
  const nextLayerHighWater =
    nextLayerId + inspection.layerIds.length;
  if (
    !Number.isSafeInteger(nextLayerHighWater) ||
    nextLayerHighWater > MAX_TILED_SIGNED_ID
  ) {
    throw new TiledMcpError(
      "LAYER_ID_EXHAUSTED",
      "The duplicated subtree does not fit in Tiled's signed 32-bit layer id space.",
      {
        path: mapPath,
        nextLayerId,
        copiedLayerCount: inspection.layerIds.length,
        maximumHighWaterMark: MAX_TILED_SIGNED_ID,
      },
    );
  }

  const nextObjectId = expectInteger(
    map.nextobjectid,
    `${mapPath}.nextobjectid`,
  );
  if (
    nextObjectId <= 0 ||
    nextObjectId <= objectIndex.maximumId
  ) {
    throw new TiledMcpError(
      "NEXT_OBJECT_ID_INVALID",
      `${mapPath}.nextobjectid must be greater than every existing object id.`,
      {
        path: mapPath,
        nextObjectId,
        maximumExistingId: objectIndex.maximumId,
      },
    );
  }
  const nextObjectHighWater =
    nextObjectId + inspection.objectIds.length;
  if (
    !Number.isSafeInteger(nextObjectHighWater) ||
    nextObjectHighWater > MAX_TILED_SIGNED_ID
  ) {
    throw new TiledMcpError(
      "OBJECT_ID_EXHAUSTED",
      "The duplicated subtree does not fit in Tiled's signed 32-bit object id space.",
      {
        path: mapPath,
        nextObjectId,
        copiedObjectCount: inspection.objectIds.length,
        maximumHighWaterMark: MAX_TILED_SIGNED_ID,
      },
    );
  }

  const duplicate = expectObject(
    cloneJson(source.object),
    `duplicate of layer ${operation.layerId}`,
  );
  const layerIdMappings: Array<{
    from: number;
    to: number;
  }> = [];
  const objectIdMappings: Array<{
    from: number;
    to: number;
  }> = [];
  const objectIdMap = new Map<number, number>();
  let allocatedCellCount = 0;
  let tileObjectCount = 0;
  let imageReferenceCount = 0;
  let layerAllocationOffset = 0;
  let objectAllocationOffset = 0;

  const allocateIds = (
    layer: JsonObject,
    layerContext: string,
    depth: number,
  ): void => {
    if (depth > MAX_LAYER_DEPTH) {
      throw new TiledMcpError(
        "LAYER_DEPTH_EXCEEDED",
        `Duplicated layer subtree exceeds depth ${MAX_LAYER_DEPTH}.`,
        { path: mapPath, maxDepth: MAX_LAYER_DEPTH },
      );
    }
    const oldLayerId = expectInteger(
      layer.id,
      `${layerContext}.id`,
    );
    const newLayerId =
      nextLayerId + layerAllocationOffset;
    layerAllocationOffset += 1;
    layer.id = newLayerId;
    layerIdMappings.push({
      from: oldLayerId,
      to: newLayerId,
    });

    const type = expectString(
      layer.type,
      `${layerContext}.type`,
    );
    if (type === "tilelayer") {
      const width = expectInteger(
        layer.width,
        `${layerContext}.width`,
      );
      const height = expectInteger(
        layer.height,
        `${layerContext}.height`,
      );
      const data = expectArray(
        layer.data,
        `${layerContext}.data`,
      );
      const cellCount = width * height;
      if (
        width <= 0 ||
        height <= 0 ||
        !Number.isSafeInteger(cellCount) ||
        data.length !== cellCount ||
        allocatedCellCount + cellCount >
          MAX_CELL_WRITES
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A duplicateLayer operation may copy at most ${MAX_CELL_WRITES} finite uncompressed tile cells.`,
          {
            path: mapPath,
            layerId: oldLayerId,
            actual:
              Number.isSafeInteger(cellCount)
                ? allocatedCellCount + cellCount
                : null,
            limit: MAX_CELL_WRITES,
          },
        );
      }
      for (const [index, gid] of data.entries()) {
        assertResolvableGid(
          gid,
          bindings,
          `${layerContext}.data[${index}]`,
        );
      }
      allocatedCellCount += cellCount;
      return;
    }
    if (type === "imagelayer") {
      if (layer.image !== undefined) {
        expectString(
          layer.image,
          `${layerContext}.image`,
        );
        imageReferenceCount += 1;
      }
      return;
    }
    if (type === "objectgroup") {
      const objects = expectArray(
        layer.objects,
        `${layerContext}.objects`,
      );
      for (const [index, value] of objects.entries()) {
        const object = expectObject(
          value,
          `${layerContext}.objects[${index}]`,
        );
        const oldObjectId = expectInteger(
          object.id,
          `${layerContext}.objects[${index}].id`,
        );
        if (
          Object.prototype.hasOwnProperty.call(
            object,
            "template",
          )
        ) {
          throw new TiledMcpError(
            "UNSUPPORTED_DUPLICATE_TEMPLATE",
            `Object ${oldObjectId} uses a template that is not revision-pinned for duplication.`,
            {
              path: mapPath,
              objectId: oldObjectId,
            },
          );
        }
        if (object.gid !== undefined) {
          assertResolvableGid(
            object.gid,
            bindings,
            `${layerContext}.objects[${index}].gid`,
          );
          tileObjectCount += 1;
        }
        const newObjectId =
          nextObjectId + objectAllocationOffset;
        objectAllocationOffset += 1;
        object.id = newObjectId;
        objectIdMap.set(oldObjectId, newObjectId);
        objectIdMappings.push({
          from: oldObjectId,
          to: newObjectId,
        });
      }
      return;
    }
    if (type !== "group") {
      throw new TiledMcpError(
        "LAYER_TYPE_MISMATCH",
        `Layer ${oldLayerId} does not use a supported Tiled layer type.`,
        {
          path: mapPath,
          layerId: oldLayerId,
          layerType: type,
        },
      );
    }
    const children = expectArray(
      layer.layers,
      `${layerContext}.layers`,
    );
    for (const [index, value] of children.entries()) {
      allocateIds(
        expectObject(
          value,
          `${layerContext}.layers[${index}]`,
        ),
        `${layerContext}.layers[${index}]`,
        depth + 1,
      );
    }
  };

  allocateIds(
    duplicate,
    `layer ${operation.layerId} duplicate`,
    0,
  );
  if (
    layerAllocationOffset !== inspection.layerIds.length ||
    objectAllocationOffset !== inspection.objectIds.length
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      "The duplicated subtree changed while IDs were allocated.",
      {
        path: mapPath,
        expectedLayers: inspection.layerIds.length,
        actualLayers: layerAllocationOffset,
        expectedObjects: inspection.objectIds.length,
        actualObjects: objectAllocationOffset,
      },
    );
  }
  if (operation.name !== undefined) {
    duplicate.name = operation.name;
  }

  const referenceSummary =
    rewriteDuplicatePropertyReferences(
      duplicate,
      objectIdMap,
      new Set(objectIndex.byId.keys()),
      mapPath,
    );
  const duplicateText = JSON.stringify(duplicate);
  const serializedDuplicateBytes = Buffer.byteLength(
    duplicateText,
    "utf8",
  );
  if (
    serializedDuplicateBytes >
    MAX_DUPLICATE_LAYER_BYTES
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A duplicated layer subtree may serialize to at most ${MAX_DUPLICATE_LAYER_BYTES} bytes.`,
      {
        path: mapPath,
        actual: serializedDuplicateBytes,
        limit: MAX_DUPLICATE_LAYER_BYTES,
      },
    );
  }
  const projectedSourceBytes =
    sourceBytes + serializedDuplicateBytes + 129;
  if (
    !Number.isSafeInteger(projectedSourceBytes) ||
    projectedSourceBytes > MAX_EDITABLE_DOCUMENT_BYTES
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Duplicating this layer would exceed the ${MAX_EDITABLE_DOCUMENT_BYTES}-byte document limit.`,
      {
        path: mapPath,
        sourceBytes,
        serializedDuplicateBytes,
        projectedUpperBound: Number.isSafeInteger(
          projectedSourceBytes,
        )
          ? projectedSourceBytes
          : null,
        limit: MAX_EDITABLE_DOCUMENT_BYTES,
      },
    );
  }

  targetPlacement.layers.splice(
    targetIndex,
    0,
    duplicate,
  );
  map.nextlayerid = nextLayerHighWater;
  if (inspection.objectIds.length > 0) {
    map.nextobjectid = nextObjectHighWater;
  }

  const duplicateName = boundedDisplayString(
    operation.name ?? sourceName,
  );
  const layerIdMappingSample = layerIdMappings.slice(
    0,
    MAX_LAYER_OPERATION_ID_SAMPLE,
  );
  const objectIdMappingSample = objectIdMappings.slice(
    0,
    MAX_LAYER_OPERATION_ID_SAMPLE,
  );
  return {
    sourceLayerId: source.id,
    createdRootLayerId:
      layerIdMappings[0]?.to ??
      (() => {
        throw new Error(
          "Duplicate layer allocation lost its root ID.",
        );
      })(),
    layerType: source.type,
    name: duplicateName.value,
    nameTruncated: duplicateName.truncated,
    sourceParentGroupId: source.parentGroupId,
    targetParentGroupId,
    sourceIndex: source.index,
    targetIndex,
    copiedLayerCount: inspection.layerIds.length,
    descendantLayerCount:
      inspection.layerIds.length - 1,
    copiedObjectCount: inspection.objectIds.length,
    allocatedCellCount,
    serializedDuplicateBytes,
    layerIdMappingSample,
    omittedLayerMappingCount:
      layerIdMappings.length -
      layerIdMappingSample.length,
    objectIdMappingSample,
    omittedObjectMappingCount:
      objectIdMappings.length -
      objectIdMappingSample.length,
    remappedInternalObjectReferenceCount:
      referenceSummary.remappedInternalObjectReferenceCount,
    retainedExternalObjectReferenceCount:
      referenceSummary.retainedExternalObjectReferenceCount,
    fileReferenceCount:
      referenceSummary.fileReferenceCount +
      imageReferenceCount,
    tileObjectCount,
    lockedLayerCount: inspection.lockedLayerCount,
    effectivelyLockedLayerCount:
      targetPlacement.effectiveParentLocked
        ? inspection.layerIds.length
        : inspection.effectivelyLockedLayerCount,
    renderOrderMayChange: true,
    renderContextMayChange:
      source.parentGroupId !== targetParentGroupId,
    affectsDescendants:
      source.type === "group" &&
      inspection.layerIds.length > 1,
  };
}

function rewriteDuplicatePropertyReferences(
  root: JsonObject,
  copiedObjectIds: ReadonlyMap<number, number>,
  existingObjectIds: ReadonlySet<number>,
  mapPath: string,
): {
  remappedInternalObjectReferenceCount: number;
  retainedExternalObjectReferenceCount: number;
  fileReferenceCount: number;
} {
  let visited = 0;
  let remappedInternalObjectReferenceCount = 0;
  let retainedExternalObjectReferenceCount = 0;
  let fileReferenceCount = 0;

  const scanPropertyEntry = (
    value: JsonValue,
    pointer: string,
    depth: number,
  ): void => {
    visited += 1;
    if (visited > 1_000_000 || depth > 512) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        "The duplicated subtree is too complex to analyze property references safely.",
        { path: mapPath },
      );
    }
    if (!isJsonObject(value)) {
      return;
    }

    if (value.type === "object") {
      const referencedId = value.value;
      if (
        typeof referencedId !== "number" ||
        !Number.isSafeInteger(referencedId) ||
        referencedId < 0
      ) {
        throw new TiledMcpError(
          "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
          "An object property in the duplicated subtree has a malformed reference.",
          {
            path: mapPath,
            jsonPointer: pointer,
          },
        );
      }
      if (referencedId !== 0) {
        const remapped = copiedObjectIds.get(
          referencedId,
        );
        if (remapped !== undefined) {
          value.value = remapped;
          remappedInternalObjectReferenceCount += 1;
        } else if (existingObjectIds.has(referencedId)) {
          retainedExternalObjectReferenceCount += 1;
        } else {
          throw new TiledMcpError(
            "OBJECT_REFERENCE_NOT_FOUND",
            `Object property reference ${referencedId} does not identify an existing object.`,
            {
              path: mapPath,
              objectId: referencedId,
              jsonPointer: pointer,
            },
          );
        }
      }
      return;
    }
    if (value.type === "class") {
      throw new TiledMcpError(
        "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
        "Class properties require a pinned project type schema before a layer can be duplicated safely.",
        {
          path: mapPath,
          jsonPointer: pointer,
        },
      );
    }
    if (value.type === "layer") {
      throw new TiledMcpError(
        "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
        "Non-standard typed layer references are not guessed or rewritten during duplication.",
        {
          path: mapPath,
          jsonPointer: pointer,
        },
      );
    }
    if (value.type === "file") {
      if (typeof value.value !== "string") {
        throw new TiledMcpError(
          "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
          "A file property in the duplicated subtree has a malformed value.",
          {
            path: mapPath,
            jsonPointer: pointer,
          },
        );
      }
      fileReferenceCount += 1;
      return;
    }
    if (value.type === "list") {
      if (!Array.isArray(value.value)) {
        throw new TiledMcpError(
          "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
          "A list property in the duplicated subtree has a malformed value.",
          {
            path: mapPath,
            jsonPointer: pointer,
          },
        );
      }
      const listPointer = appendJsonPointer(
        pointer,
        "value",
      );
      for (const [index, item] of value.value.entries()) {
        scanPropertyEntry(
          item,
          appendJsonPointer(listPointer, index),
          depth + 1,
        );
      }
    }
  };

  const scanOwnerProperties = (
    owner: JsonObject,
    pointer: string,
  ): void => {
    if (
      !Object.prototype.hasOwnProperty.call(
        owner,
        "properties",
      )
    ) {
      return;
    }
    const propertiesPointer = appendJsonPointer(
      pointer,
      "properties",
    );
    if (!Array.isArray(owner.properties)) {
      throw new TiledMcpError(
        "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
        "A layer or object properties member in the duplicated subtree must be an array.",
        {
          path: mapPath,
          jsonPointer: propertiesPointer,
        },
      );
    }
    for (const [index, property] of owner.properties.entries()) {
      if (!isJsonObject(property)) {
        throw new TiledMcpError(
          "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
          "A layer or object property entry in the duplicated subtree must be an object.",
          {
            path: mapPath,
            jsonPointer: appendJsonPointer(
              propertiesPointer,
              index,
            ),
          },
        );
      }
      scanPropertyEntry(
        property,
        appendJsonPointer(propertiesPointer, index),
        0,
      );
    }
  };

  const visitLayer = (
    layer: JsonObject,
    pointer: string,
    depth: number,
  ): void => {
    if (depth > MAX_LAYER_DEPTH) {
      throw new TiledMcpError(
        "LAYER_DEPTH_EXCEEDED",
        `Duplicated layer subtree exceeds depth ${MAX_LAYER_DEPTH}.`,
        { path: mapPath, maxDepth: MAX_LAYER_DEPTH },
      );
    }
    scanOwnerProperties(layer, pointer);
    const type = expectString(
      layer.type,
      `${pointer}/type`,
    );
    if (type === "objectgroup") {
      const objects = expectArray(
        layer.objects,
        `${pointer}/objects`,
      );
      for (const [index, value] of objects.entries()) {
        scanOwnerProperties(
          expectObject(
            value,
            `${pointer}/objects/${index}`,
          ),
          appendJsonPointer(
            appendJsonPointer(pointer, "objects"),
            index,
          ),
        );
      }
      return;
    }
    if (type !== "group") {
      return;
    }
    const layers = expectArray(
      layer.layers,
      `${pointer}/layers`,
    );
    const layersPointer = appendJsonPointer(
      pointer,
      "layers",
    );
    for (const [index, value] of layers.entries()) {
      visitLayer(
        expectObject(
          value,
          `${pointer}/layers/${index}`,
        ),
        appendJsonPointer(layersPointer, index),
        depth + 1,
      );
    }
  };

  visitLayer(root, "", 0);
  return {
    remappedInternalObjectReferenceCount,
    retainedExternalObjectReferenceCount,
    fileReferenceCount,
  };
}

function deleteExistingLayer(
  map: JsonObject,
  operation: Extract<
    MapEditOperation,
    { type: "deleteLayer" }
  >,
  mapPath: string,
  context: string,
): Omit<
  NonNullable<
    MapEditPlan["summary"]["deletedLayers"]
  >[number],
  "operationIndex"
> {
  const allowedKeys = new Set([
    "type",
    "layerId",
    "deleteDescendants",
  ]);
  const unknownKey = Object.keys(operation).find(
    (key) => !allowedKeys.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }
  assertPositiveInteger(
    operation.layerId,
    `${context}.layerId`,
  );
  if (
    operation.deleteDescendants !== undefined &&
    typeof operation.deleteDescendants !== "boolean"
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.deleteDescendants must be a boolean.`,
    );
  }

  const location = findDeletableLayer(
    map,
    operation.layerId,
    mapPath,
  );
  const inspection = inspectLayerSubtree(
    location.object,
    mapPath,
  );
  const descendantLayerCount =
    inspection.layerIds.length - 1;
  if (
    location.type === "group" &&
    descendantLayerCount > 0 &&
    operation.deleteDescendants !== true
  ) {
    throw new TiledMcpError(
      "LAYER_HAS_DESCENDANTS",
      `Group layer ${operation.layerId} contains ${descendantLayerCount} descendant layer(s). Set deleteDescendants to true to confirm recursive deletion.`,
      {
        path: mapPath,
        layerId: operation.layerId,
        descendantLayerCount,
      },
    );
  }

  if (inspection.objectIds.length > 0) {
    const objectIndex = buildObjectEditIndex(map, mapPath);
    for (const objectId of inspection.objectIds) {
      if (!objectIndex.byId.has(objectId)) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `Object ${objectId} disappeared while inspecting layer ${operation.layerId}.`,
          {
            path: mapPath,
            layerId: operation.layerId,
            objectId,
          },
        );
      }
    }
  }

  if (
    location.container[location.index] !==
    location.object
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Layer ${operation.layerId} moved during change-set planning.`,
      { path: mapPath, layerId: operation.layerId },
    );
  }
  const rawName =
    typeof location.object.name === "string"
      ? location.object.name
      : `Layer ${location.id}`;
  const displayName = boundedDisplayString(rawName);

  if (inspection.objectIds.length > 0) {
    assertNoDanglingObjectReferences(
      map,
      new Set(inspection.objectIds),
      mapPath,
      location.object,
    );
  }
  location.container.splice(location.index, 1);

  const layerIdSample = inspection.layerIds.slice(
    0,
    MAX_LAYER_OPERATION_ID_SAMPLE,
  );
  const objectIdSample = inspection.objectIds.slice(
    0,
    MAX_LAYER_OPERATION_ID_SAMPLE,
  );
  return {
    layerId: location.id,
    layerType: location.type,
    name: displayName.value,
    nameTruncated: displayName.truncated,
    parentGroupId: location.parentGroupId,
    index: location.index,
    deletedLayerCount: inspection.layerIds.length,
    descendantLayerCount,
    layerIdSample,
    omittedLayerCount:
      inspection.layerIds.length - layerIdSample.length,
    objectCount: inspection.objectIds.length,
    objectIdSample,
    omittedObjectCount:
      inspection.objectIds.length - objectIdSample.length,
    lockedLayerCount: inspection.lockedLayerCount,
  };
}

function findDeletableLayer(
  map: JsonObject,
  layerId: number,
  mapPath: string,
): DeletableLayerLocation {
  const layers = expectArray(map.layers, `${mapPath}.layers`);
  const found = findDeletableLayerRecursive(
    layers,
    layerId,
    mapPath,
    `${mapPath}.layers`,
    ["layers"],
    null,
  );
  if (found === undefined) {
    throw new TiledMcpError(
      "LAYER_NOT_FOUND",
      `Layer ${layerId} does not exist.`,
      { path: mapPath, layerId },
    );
  }
  return found;
}

function findDeletableLayerRecursive(
  layers: JsonValue[],
  layerId: number,
  mapPath: string,
  context: string,
  containerPath: JsonSourcePath,
  parentGroupId: number | null,
  depth = 0,
  budget: LayerTraversalBudget = { count: 0 },
): DeletableLayerLocation | undefined {
  assertLayerTraversalBudget(layers.length, depth, budget);
  for (const [index, value] of layers.entries()) {
    const layer = expectObject(value, `${context}[${index}]`);
    const id = expectInteger(
      layer.id,
      `${context}[${index}].id`,
    );
    const type = expectString(
      layer.type,
      `${context}[${index}].type`,
    );
    if (id === layerId) {
      if (
        type !== "tilelayer" &&
        type !== "objectgroup" &&
        type !== "imagelayer" &&
        type !== "group"
      ) {
        throw new TiledMcpError(
          "LAYER_TYPE_MISMATCH",
          `Layer ${layerId} does not use a supported Tiled layer type.`,
          { path: mapPath, layerId, layerType: type },
        );
      }
      return {
        object: layer,
        path: [...containerPath, index],
        id,
        type,
        container: layers,
        containerPath,
        index,
        parentGroupId,
      };
    }
    if (type !== "group") {
      continue;
    }
    const nested = findDeletableLayerRecursive(
      expectArray(
        layer.layers,
        `${context}[${index}].layers`,
      ),
      layerId,
      mapPath,
      `${context}[${index}].layers`,
      [...containerPath, index, "layers"],
      id,
      depth + 1,
      budget,
    );
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function inspectLayerSubtree(
  root: JsonObject,
  mapPath: string,
): LayerSubtreeInspection {
  const layerIds: number[] = [];
  const objectIds: number[] = [];
  const seenLayerIds = new Set<number>();
  const seenObjectIds = new Set<number>();
  let lockedLayerCount = 0;
  let effectivelyLockedLayerCount = 0;
  let maxRelativeDepth = 0;

  const visit = (
    layer: JsonObject,
    context: string,
    depth: number,
    inheritedLocked: boolean,
  ): void => {
    if (
      depth > MAX_LAYER_DEPTH ||
      layerIds.length >= MAX_LAYER_COUNT
    ) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `Deleted layer subtree exceeds depth ${MAX_LAYER_DEPTH} or count ${MAX_LAYER_COUNT}.`,
        {
          path: mapPath,
          maxDepth: MAX_LAYER_DEPTH,
          maxLayers: MAX_LAYER_COUNT,
        },
      );
    }
    const id = expectInteger(layer.id, `${context}.id`);
    if (id <= 0 || seenLayerIds.has(id)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        id <= 0
          ? `${mapPath} contains a non-positive layer id.`
          : `${mapPath} contains duplicate layer id ${id}.`,
        { path: mapPath, layerId: id },
      );
    }
    const type = expectString(
      layer.type,
      `${context}.type`,
    );
    if (
      type !== "tilelayer" &&
      type !== "objectgroup" &&
      type !== "imagelayer" &&
      type !== "group"
    ) {
      throw new TiledMcpError(
        "LAYER_TYPE_MISMATCH",
        `Layer ${id} does not use a supported Tiled layer type.`,
        { path: mapPath, layerId: id, layerType: type },
      );
    }
    seenLayerIds.add(id);
    layerIds.push(id);
    maxRelativeDepth = Math.max(
      maxRelativeDepth,
      depth,
    );
    const explicitlyLocked = layer.locked === true;
    if (explicitlyLocked) {
      lockedLayerCount += 1;
    }
    const effectivelyLocked =
      inheritedLocked || explicitlyLocked;
    if (effectivelyLocked) {
      effectivelyLockedLayerCount += 1;
    }

    if (type === "objectgroup") {
      const objects = expectArray(
        layer.objects,
        `${context}.objects`,
      );
      if (
        objectIds.length + objects.length >
        MAX_OBJECT_COUNT
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `Deleted layer subtree contains more than ${MAX_OBJECT_COUNT} objects.`,
          { path: mapPath, limit: MAX_OBJECT_COUNT },
        );
      }
      for (const [index, value] of objects.entries()) {
        const object = expectObject(
          value,
          `${context}.objects[${index}]`,
        );
        const objectId = expectInteger(
          object.id,
          `${context}.objects[${index}].id`,
        );
        if (
          objectId <= 0 ||
          seenObjectIds.has(objectId)
        ) {
          throw new TiledMcpError(
            "INVALID_DOCUMENT",
            objectId <= 0
              ? `${mapPath} contains a non-positive object id.`
              : `${mapPath} contains duplicate object id ${objectId}.`,
            { path: mapPath, objectId },
          );
        }
        seenObjectIds.add(objectId);
        objectIds.push(objectId);
      }
      return;
    }
    if (type !== "group") {
      return;
    }
    const children = expectArray(
      layer.layers,
      `${context}.layers`,
    );
    for (const [index, value] of children.entries()) {
      visit(
        expectObject(
          value,
          `${context}.layers[${index}]`,
        ),
        `${context}.layers[${index}]`,
        depth + 1,
        effectivelyLocked,
      );
    }
  };

  visit(root, `layer ${String(root.id)}`, 0, false);
  return {
    layerIds,
    objectIds,
    lockedLayerCount,
    effectivelyLockedLayerCount,
    maxRelativeDepth,
  };
}

function updateCommonMap(
  map: JsonObject,
  patch: Extract<
    MapEditOperation,
    { type: "updateMap" }
  >["patch"],
  context: string,
): {
  requestedFields: MapPatchField[];
  changedFields: MapPatchField[];
} {
  if (!isRecordValue(patch)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be an object.`,
    );
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must contain at least one field.`,
    );
  }
  const allowedFields = new Set<string>(MAP_PATCH_FIELDS);
  const unknownKey = keys.find(
    (key) => !allowedFields.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }
  const requestedFields = MAP_PATCH_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(patch, field),
  );
  for (const field of requestedFields) {
    assertMapPatchValue(
      field,
      (patch as Record<string, unknown>)[field],
      `${context}.${field}`,
    );
  }

  const changedFields: MapPatchField[] = [];
  for (const field of requestedFields) {
    const jsonKey = mapPatchJsonKey(field);
    const value = (patch as Record<string, unknown>)[field];
    if (field === "backgroundColor" && value === null) {
      if (
        Object.prototype.hasOwnProperty.call(map, jsonKey)
      ) {
        delete map[jsonKey];
        changedFields.push(field);
      }
      continue;
    }
    const currentValue = map[jsonKey];
    if (
      !Object.prototype.hasOwnProperty.call(map, jsonKey) ||
      stableJson(currentValue as JsonValue) !==
        stableJson(value as JsonValue)
    ) {
      map[jsonKey] = value as JsonValue;
      changedFields.push(field);
    }
  }
  return { requestedFields, changedFields };
}

function assertMapPatchValue(
  field: MapPatchField,
  value: unknown,
  context: string,
): void {
  if (field === "className") {
    assertMapClassName(value, context);
    return;
  }
  if (field === "backgroundColor") {
    if (
      value !== null &&
      (typeof value !== "string" ||
        !TILED_COLOR_PATTERN.test(value))
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} must be null, #RRGGBB, or #AARRGGBB.`,
      );
    }
    return;
  }
  if (
    typeof value !== "string" ||
    !MAP_RENDER_ORDERS.has(value)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} is not a supported orthogonal render order.`,
    );
  }
}

function assertMapClassName(
  value: unknown,
  context: string,
): void {
  if (
    typeof value !== "string" ||
    !hasAtMostCodePoints(
      value,
      MAX_MAP_CLASS_NAME_CODE_POINTS,
    )
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be a string of at most ${MAX_MAP_CLASS_NAME_CODE_POINTS} Unicode code points.`,
    );
  }
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

function updateCommonLayer(
  map: JsonObject,
  layerId: number,
  patch: Extract<
    MapEditOperation,
    { type: "updateLayer" }
  >["patch"],
  mapPath: string,
  context: string,
): {
  layer: EditableLayerLocation;
  requestedFields: LayerPatchField[];
  changedFields: LayerPatchField[];
} {
  if (!isRecordValue(patch)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be an object.`,
    );
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must contain at least one field.`,
    );
  }
  const allowedFields = new Set<string>(LAYER_PATCH_FIELDS);
  const unknownKey = keys.find(
    (key) => !allowedFields.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }
  const requestedFields = LAYER_PATCH_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(patch, field),
  );
  for (const field of requestedFields) {
    assertLayerPatchValue(
      field,
      (patch as Record<string, unknown>)[field],
      `${context}.${field}`,
    );
  }

  const layer = findEditableLayer(map, layerId, mapPath);
  const changedFields: LayerPatchField[] = [];
  for (const field of requestedFields) {
    const jsonKey = layerPatchJsonKey(field);
    const value = (patch as Record<string, unknown>)[field];
    if (field === "tintColor" && value === null) {
      if (
        Object.prototype.hasOwnProperty.call(
          layer.object,
          jsonKey,
        )
      ) {
        delete layer.object[jsonKey];
        changedFields.push(field);
      }
      continue;
    }
    const currentValue = layer.object[jsonKey];
    if (
      !Object.prototype.hasOwnProperty.call(
        layer.object,
        jsonKey,
      ) ||
      stableJson(currentValue as JsonValue) !==
        stableJson(value as JsonValue)
    ) {
      layer.object[jsonKey] = value as JsonValue;
      changedFields.push(field);
    }
  }
  return { layer, requestedFields, changedFields };
}

function assertLayerPatchValue(
  field: LayerPatchField,
  value: unknown,
  context: string,
): void {
  if (field === "name" || field === "className") {
    assertBoundedString(value as string, context);
    return;
  }
  if (field === "visible" || field === "locked") {
    if (typeof value !== "boolean") {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} must be a boolean.`,
      );
    }
    return;
  }
  if (field === "opacity") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} must be between 0 and 1.`,
      );
    }
    return;
  }
  if (
    field === "offsetX" ||
    field === "offsetY" ||
    field === "parallaxX" ||
    field === "parallaxY"
  ) {
    assertObjectNumber(value, context);
    return;
  }
  if (field === "tintColor") {
    if (
      value !== null &&
      (typeof value !== "string" ||
        !TILED_COLOR_PATTERN.test(value))
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} must be null, #RRGGBB, or #AARRGGBB.`,
      );
    }
    return;
  }
  if (
    typeof value !== "string" ||
    !LAYER_BLEND_MODES.has(value)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} is not a supported Tiled blend mode.`,
    );
  }
}

function createBasicObject(
  map: JsonObject,
  layerId: number,
  draft: ObjectDraft,
  mapPath: string,
  context: string,
  index: ObjectEditIndex,
  orientation: MapOrientation,
  bindings: readonly TilesetBinding[],
): ObjectLocation {
  if (!isRecordValue(draft)) {
    throw new TiledMcpError("INVALID_ARGUMENT", `${context} must be an object.`);
  }
  const layer = findObjectLayer(map, layerId, mapPath);
  const nextObjectId = expectInteger(map.nextobjectid, `${mapPath}.nextobjectid`);
  if (nextObjectId <= 0 || nextObjectId >= Number.MAX_SAFE_INTEGER) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${mapPath}.nextobjectid must be a positive incrementable integer.`,
      { path: mapPath, nextObjectId },
    );
  }
  if (nextObjectId <= index.maximumId) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${mapPath}.nextobjectid must be greater than every existing object id.`,
      { path: mapPath, nextObjectId, maximumExistingId: index.maximumId },
    );
  }

  assertObjectDraft(draft, context);
  const hasDimensions =
    draft.shape === "rectangle" ||
    draft.shape === "ellipse" ||
    draft.shape === "capsule" ||
    draft.shape === "text" ||
    draft.shape === "tile";
  const object: JsonObject = {
    height: hasDimensions ? (draft.height ?? 0) : 0,
    id: nextObjectId,
    name: draft.name ?? "",
    rotation: draft.rotation ?? 0,
    type: draft.className ?? "",
    visible: draft.visible ?? true,
    width: hasDimensions ? (draft.width ?? 0) : 0,
    x: draft.x,
    y: draft.y,
  };
  if (draft.shape === "polygon" || draft.shape === "polyline") {
    object[draft.shape] = draft.points.map((point) => ({
      x: point.x,
      y: point.y,
    }));
  } else if (draft.shape === "text") {
    object.text = serializeTiledTextObjectData(
      textObjectFieldsFromFlatInput(
        draft as unknown as Readonly<
          Record<string, unknown>
        >,
      ),
    );
  } else if (draft.shape === "tile") {
    object.gid = tileRefToGid(
      draft.tile,
      orientation,
      bindings,
    );
  } else if (draft.shape !== "rectangle") {
    object[draft.shape] = true;
  }
  if (draft.opacity !== undefined) {
    object.opacity = draft.opacity;
  }
  layer.objects.push(object);
  layer.object.objects = layer.objects;
  map.nextobjectid = nextObjectId + 1;
  const location = {
    object,
    objectIndex: layer.objects.length - 1,
    layer,
    ancestors: layer.ancestors,
  };
  index.byId.set(nextObjectId, location);
  index.maximumId = nextObjectId;
  return location;
}

function updateBasicObject(
  objectId: number,
  patch: Extract<MapEditOperation, { type: "updateObject" }>["patch"],
  mapPath: string,
  context: string,
  index: ObjectEditIndex,
  orientation: MapOrientation,
  bindings: readonly TilesetBinding[],
): ObjectLocation {
  if (!isRecordValue(patch)) {
    throw new TiledMcpError("INVALID_ARGUMENT", `${context} must be an object.`);
  }
  const keys = Object.keys(patch);
  const textObjectFields = new Set<string>(
    TEXT_OBJECT_FIELDS,
  );
  const allowedKeys = new Set([
    "x",
    "y",
    "width",
    "height",
    "name",
    "className",
    "rotation",
    "visible",
    "opacity",
    "points",
    "properties",
    "tile",
    ...TEXT_OBJECT_FIELDS,
  ]);
  if (keys.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must contain at least one field.`,
    );
  }
  const unknownKey = keys.find((key) => !allowedKeys.has(key));
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }

  const location = findObjectLocation(index, objectId, mapPath);
  const shape = assertBasicEditableObject(location.object, objectId, mapPath);
  const hasTextPatch = hasTextObjectFields(
    patch as Readonly<Record<string, unknown>>,
  );
  if (hasTextPatch && shape !== "text") {
    throw new TiledMcpError(
      "OBJECT_SHAPE_MISMATCH",
      "Text-specific fields can be updated only on text objects.",
      { path: mapPath, objectId, shape },
    );
  }
  const hasPointsPatch =
    Object.prototype.hasOwnProperty.call(
      patch,
      "points",
    );
  if (
    hasPointsPatch &&
    shape !== "polygon" &&
    shape !== "polyline"
  ) {
    throw new TiledMcpError(
      "OBJECT_SHAPE_MISMATCH",
      "Points can be updated only on polygon or polyline objects.",
      { path: mapPath, objectId, shape },
    );
  }
  if (
    shape === "point" &&
    (Object.prototype.hasOwnProperty.call(patch, "width") ||
      Object.prototype.hasOwnProperty.call(patch, "height"))
  ) {
    throw new TiledMcpError(
      "OBJECT_SHAPE_MISMATCH",
      "Point objects do not have editable width or height.",
      { path: mapPath, objectId },
    );
  }
  if (
    (shape === "polygon" || shape === "polyline") &&
    (Object.prototype.hasOwnProperty.call(patch, "width") ||
      Object.prototype.hasOwnProperty.call(patch, "height"))
  ) {
    throw new TiledMcpError(
      "OBJECT_SHAPE_MISMATCH",
      "Polygon and polyline objects do not have editable width or height.",
      { path: mapPath, objectId, shape },
    );
  }
  const hasTilePatch =
    Object.prototype.hasOwnProperty.call(
      patch,
      "tile",
    );
  if (hasTilePatch && shape !== "tile") {
    throw new TiledMcpError(
      "OBJECT_SHAPE_MISMATCH",
      "The tile reference can be replaced only on existing tile objects.",
      { path: mapPath, objectId, shape },
    );
  }
  assertObjectPatch(patch, context);
  if (hasPointsPatch) {
    assertObjectPathPoints(
      patch.points,
      shape as "polygon" | "polyline",
      `${context}.points`,
      "INVALID_ARGUMENT",
    );
  }
  if (hasTilePatch) {
    location.object.gid = tileRefToGid(
      patch.tile as TileRef,
      orientation,
      bindings,
    );
  }
  const hasPropertiesPatch =
    patch.properties !== undefined;
  if (hasPropertiesPatch) {
    validatePropertiesPatch(
      patch.properties!,
      `${context}.properties`,
    );
  }

  if (hasTextPatch) {
    location.object.text =
      applyTextObjectFieldsPatch(
        location.object.text,
        patch as Readonly<Record<string, unknown>>,
      );
  }
  if (hasPointsPatch) {
    const points = patch.points as ObjectPathPoint[];
    location.object[
      shape as "polygon" | "polyline"
    ] = points.map((point) => ({
      x: point.x,
      y: point.y,
    }));
  }
  if (hasPropertiesPatch) {
    applyPropertiesPatch(
      location.object,
      patch.properties!,
      `${mapPath} object ${objectId}.properties`,
      { path: mapPath, objectId },
    );
  }
  for (const key of keys) {
    const value = patch[key as keyof typeof patch];
    if (
      key === "points" ||
      key === "properties" ||
      key === "tile" ||
      textObjectFields.has(key)
    ) {
      continue;
    } else if (key === "className") {
      location.object.type = value as string;
    } else {
      location.object[key] = value as JsonValue;
    }
  }
  return location;
}

function deleteBasicObjects(
  map: JsonObject,
  objectIds: readonly number[],
  mapPath: string,
  index: ObjectEditIndex,
): ObjectLocation[] {
  const locations = objectIds.map((objectId) => {
    const location = findObjectLocation(index, objectId, mapPath);
    assertBasicEditableObject(location.object, objectId, mapPath);
    return location;
  });
  const byLayer = new Map<
    JsonObject,
    { layer: ObjectLayerView; targets: Set<JsonObject> }
  >();
  for (const location of locations) {
    const existing = byLayer.get(location.layer.object);
    if (existing) {
      existing.targets.add(location.object);
    } else {
      byLayer.set(location.layer.object, {
        layer: location.layer,
        targets: new Set([location.object]),
      });
    }
  }
  for (const { layer, targets } of byLayer.values()) {
    const currentObjects = expectArray(
      layer.object.objects,
      `layer ${layer.id}.objects`,
    );
    const filtered = currentObjects.filter(
      (value) => !isJsonObject(value) || !targets.has(value),
    );
    if (currentObjects.length - filtered.length !== targets.size) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        "An object disappeared from its layer during change-set planning.",
        { path: mapPath, layerId: layer.id },
      );
    }
    layer.object.objects = filtered;
    layer.objects = filtered;
  }
  assertNoDanglingObjectReferences(map, new Set(objectIds), mapPath);
  for (const objectId of objectIds) {
    index.byId.delete(objectId);
  }
  return locations;
}

function assertNoDanglingObjectReferences(
  map: JsonObject,
  deletedIds: ReadonlySet<number>,
  mapPath: string,
  ignoredSubtree?: JsonObject,
): void {
  let visited = 0;

  const scan = (
    value: JsonValue,
    pointer: string,
    depth: number,
    isPropertyEntry: boolean,
  ): void => {
    if (value === ignoredSubtree) {
      return;
    }
    visited += 1;
    if (visited > 1_000_000 || depth > 512) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        "Map is too complex to check object references safely.",
        { path: mapPath },
      );
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        scan(item, appendJsonPointer(pointer, index), depth + 1, false);
      }
      return;
    }
    if (!isJsonObject(value)) {
      return;
    }
    if (
      isPropertyEntry &&
      value.type === "object" &&
      typeof value.value === "number" &&
      Number.isSafeInteger(value.value) &&
      deletedIds.has(value.value)
    ) {
      const propertyName = boundedDisplayString(value.name).value;
      throw new TiledMcpError(
        "OBJECT_IN_USE",
        `Object ${value.value} is still referenced by object property ${JSON.stringify(propertyName)}.`,
        {
          path: mapPath,
          objectId: value.value,
          propertyName,
          jsonPointer: pointer,
        },
      );
    }
    if (isPropertyEntry && value.type === "class") {
      const propertyName = boundedDisplayString(value.name).value;
      throw new TiledMcpError(
        "UNSUPPORTED_OBJECT_REFERENCE_ANALYSIS",
        `Cannot safely delete objects while class property ${JSON.stringify(propertyName)} may contain typed object references.`,
        {
          path: mapPath,
          propertyName,
          jsonPointer: pointer,
        },
      );
    }
    if (
      isPropertyEntry &&
      value.type === "list" &&
      Array.isArray(value.value)
    ) {
      const listPointer = appendJsonPointer(pointer, "value");
      for (const [index, item] of value.value.entries()) {
        scan(
          item,
          appendJsonPointer(listPointer, index),
          depth + 1,
          true,
        );
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (
        isPropertyEntry &&
        value.type === "list" &&
        key === "value" &&
        Array.isArray(item)
      ) {
        continue;
      }
      const childPointer = appendJsonPointer(pointer, key);
      if (key === "properties" && Array.isArray(item)) {
        for (const [index, property] of item.entries()) {
          scan(
            property,
            appendJsonPointer(childPointer, index),
            depth + 1,
            true,
          );
        }
      } else {
        scan(item, childPointer, depth + 1, false);
      }
    }
  };

  scan(map, "", 0, false);
}

function appendJsonPointer(
  pointer: string,
  segment: string | number,
): string {
  const escaped = String(segment)
    .replace(/~/gu, "~0")
    .replace(/\//gu, "~1")
    .slice(0, 128);
  return `${pointer}/${escaped}`.slice(0, 1_024);
}

function assertObjectDraft(draft: ObjectDraft, context: string): void {
  const commonKeys = new Set([
    "shape",
    "x",
    "y",
    "name",
    "className",
    "rotation",
    "visible",
    "opacity",
  ]);
  if (
    draft.shape !== "rectangle" &&
    draft.shape !== "point" &&
    draft.shape !== "ellipse" &&
    draft.shape !== "capsule" &&
    draft.shape !== "polygon" &&
    draft.shape !== "polyline" &&
    draft.shape !== "text" &&
    draft.shape !== "tile"
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.shape must be rectangle, point, ellipse, capsule, polygon, polyline, text or tile.`,
    );
  }
  if (draft.shape === "polygon" || draft.shape === "polyline") {
    commonKeys.add("points");
  } else if (draft.shape === "text") {
    commonKeys.add("width");
    commonKeys.add("height");
    for (const field of TEXT_OBJECT_FIELDS) {
      commonKeys.add(field);
    }
  } else if (draft.shape === "tile") {
    commonKeys.add("tile");
    commonKeys.add("width");
    commonKeys.add("height");
  } else if (draft.shape !== "point") {
    commonKeys.add("width");
    commonKeys.add("height");
  }
  const unknownKey = Object.keys(draft).find((key) => !commonKeys.has(key));
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }
  assertObjectNumber(draft.x, `${context}.x`);
  assertObjectNumber(draft.y, `${context}.y`);
  if (draft.shape === "polygon" || draft.shape === "polyline") {
    assertObjectPathPoints(
      draft.points,
      draft.shape,
      `${context}.points`,
      "INVALID_ARGUMENT",
    );
  } else if (draft.shape === "tile") {
    for (const dimension of [
      "width",
      "height",
    ] as const) {
      const value = draft[dimension];
      assertObjectSize(
        value,
        `${context}.${dimension}`,
      );
      if ((value as number) <= 0) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context}.${dimension} must be an explicit positive number for a tile object.`,
          { dimension },
        );
      }
    }
  } else if (draft.shape !== "point") {
    const sizedDraft = draft as ObjectDraft & {
      width?: unknown;
      height?: unknown;
    };
    if (
      Object.prototype.hasOwnProperty.call(
        draft,
        "width",
      )
    ) {
      assertObjectSize(sizedDraft.width, `${context}.width`);
    }
    if (
      Object.prototype.hasOwnProperty.call(
        draft,
        "height",
      )
    ) {
      assertObjectSize(sizedDraft.height, `${context}.height`);
    }
  }
  assertOptionalObjectFields(draft, context);
  if (draft.shape === "text") {
    assertTextObjectFlatInput(
      draft as unknown as Readonly<
        Record<string, unknown>
      >,
      context,
      true,
    );
  }
}

function assertObjectPatch(
  patch: Extract<MapEditOperation, { type: "updateObject" }>["patch"],
  context: string,
): void {
  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "x",
    )
  ) {
    assertObjectNumber(patch.x, `${context}.x`);
  }
  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "y",
    )
  ) {
    assertObjectNumber(patch.y, `${context}.y`);
  }
  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "width",
    )
  ) {
    assertObjectSize(patch.width, `${context}.width`);
  }
  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "height",
    )
  ) {
    assertObjectSize(patch.height, `${context}.height`);
  }
  assertOptionalObjectFields(patch, context);
  if (
    hasTextObjectFields(
      patch as Readonly<Record<string, unknown>>,
    )
  ) {
    assertTextObjectFlatInput(
      patch as Readonly<Record<string, unknown>>,
      context,
      false,
    );
  }
}

function assertOptionalObjectFields(
  value: {
    name?: string;
    className?: string;
    rotation?: number;
    visible?: boolean;
    opacity?: number;
  },
  context: string,
): void {
  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "name",
    )
  ) {
    assertBoundedString(value.name, `${context}.name`);
  }
  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "className",
    )
  ) {
    assertBoundedString(value.className, `${context}.className`);
  }
  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "rotation",
    )
  ) {
    assertObjectNumber(value.rotation, `${context}.rotation`);
  }
  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "visible",
    ) &&
    typeof value.visible !== "boolean"
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.visible must be a boolean.`,
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "opacity",
    ) &&
    (typeof value.opacity !== "number" ||
      !Number.isFinite(value.opacity) ||
      value.opacity < 0 ||
      value.opacity > 1)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.opacity must be between 0 and 1.`,
    );
  }
}

function assertObjectNumber(value: unknown, context: string): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > MAX_ABSOLUTE_OBJECT_NUMBER
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be a finite number between -${MAX_ABSOLUTE_OBJECT_NUMBER} and ${MAX_ABSOLUTE_OBJECT_NUMBER}.`,
    );
  }
}

function assertObjectSize(value: unknown, context: string): void {
  assertObjectNumber(value, context);
  if ((value as number) < 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must not be negative.`,
    );
  }
}

function assertTextObjectFlatInput(
  value: Readonly<Record<string, unknown>>,
  context: string,
  requireText: boolean,
): void {
  try {
    if (requireText) {
      textObjectFieldsFromFlatInput(value);
    } else {
      measureTextObjectPayloadBytes(value);
    }
  } catch (error) {
    if (error instanceof TextObjectValidationError) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.${error.field}: ${error.message}`,
        { field: error.field },
      );
    }
    throw error;
  }
}

function assertTextObjectPayloadBudget(
  actual: number,
): void {
  if (
    actual >
    MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A change set may contain at most ${MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET} canonical UTF-8 bytes of text-object fields.`,
      {
        actual,
        limit:
          MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET,
      },
    );
  }
}

function assertObjectPropertyPatchBudget(
  actual: number,
): void {
  if (
    actual >
    MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A change set may contain at most ${MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET} canonical UTF-8 bytes of object property writes.`,
      {
        actual,
        limit:
          MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET,
      },
    );
  }
}

function assertObjectShapePointBudget(
  actual: number,
): void {
  if (
    actual >
    MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A change set may contain at most ${MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET} polygon/polyline points across create and update operations.`,
      {
        actual,
        limit:
          MAX_OBJECT_SHAPE_POINTS_PER_CHANGE_SET,
      },
    );
  }
}

function writeLayerGid(layer: TileLayerView, x: number, y: number, gid: number): void {
  if (layer.chunked !== undefined) {
    writeChunkedViewGid(layer.chunked, x, y, gid);
    return;
  }
  const index = (y - layer.y) * layer.width + (x - layer.x);
  layer.data[index] = gid;
  layer.object.data = layer.data;
}

/**
 * Asserts one written rectangle of a chunked layer stays inside the
 * bounded infinite-map coordinate range; dense layers keep their exact
 * in-bounds check at the call sites.
 */
function assertChunkedRegionBounded(
  layer: TileLayerView,
  operationIndex: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (
    Math.abs(x) > 1_000_000_000 ||
    Math.abs(y) > 1_000_000_000 ||
    Math.abs(x + width - 1) > 1_000_000_000 ||
    Math.abs(y + height - 1) > 1_000_000_000
  ) {
    throw new TiledMcpError(
      "REGION_OUT_OF_BOUNDS",
      `operations[${operationIndex}] writes outside the bounded infinite-map coordinate range.`,
      { layerId: layer.id, x, y, width, height },
    );
  }
}

/**
 * Distinct sparse local ids of one collection binding actually used by
 * the preview scene: region-clipped tile-layer cells plus resolved tile
 * objects, ascending.
 */
function chunkedFillBounds(
  view: ChunkedCellView,
): {
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const chunk of view.structure.chunks) {
    minX = Math.min(minX, chunk.x);
    minY = Math.min(minY, chunk.y);
    maxX = Math.max(maxX, chunk.x + chunk.width);
    maxY = Math.max(maxY, chunk.y + chunk.height);
  }
  if (!Number.isFinite(minX)) {
    return null;
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Serializes a written chunked layer back into its map object in Tiled
 * 1.12.2 canonical save form and records it for the chunked write-back
 * member patches. Net no-op writes leave the stored members untouched.
 */
function finalizeChunkedTileLayerWrite(
  layer: TileLayerView,
  map: JsonObject,
  mapPath: string,
  chunkedTileLayerIds: Set<number>,
): void {
  if (layer.chunked === undefined) {
    return;
  }
  chunkedTileLayerIds.add(layer.id);
  if (!layer.chunked.dirty) {
    return;
  }
  const chunkSize = readMapChunkSize(map, mapPath);
  const serialized = serializeChunkedCells({
    cells: layer.chunked.cells,
    chunkWidth: chunkSize.width,
    chunkHeight: chunkSize.height,
    encoding:
      layer.object.encoding === "base64" ? "base64" : "array",
    compression:
      layer.object.compression === undefined ||
      layer.object.compression === ""
        ? ""
        : String(layer.object.compression),
    layerId: layer.id,
    mapPath,
  });
  layer.object.chunks = serialized.chunks as unknown as JsonValue;
  layer.object.width = serialized.width;
  layer.object.height = serialized.height;
  layer.object.startx = serialized.startX;
  layer.object.starty = serialized.startY;
}

function readReplaceTilesRegion(
  value: unknown,
  operationIndex: number,
): { x: number; y: number; width: number; height: number } {
  if (!isRecordValue(value)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `operations[${operationIndex}].region must be an object.`,
    );
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ["height", "width", "x", "y"];
  const actualKeys = Object.keys(record).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some(
      (key, index) => key !== expectedKeys[index],
    )
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `operations[${operationIndex}].region must contain exactly x, y, width and height.`,
    );
  }
  const context = `operations[${operationIndex}].region`;
  const { x, y, width, height } = record;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} coordinates and dimensions must be numbers.`,
    );
  }
  assertSafeInteger(x, `${context}.x`);
  assertSafeInteger(y, `${context}.y`);
  assertPositiveInteger(width, `${context}.width`);
  assertPositiveInteger(height, `${context}.height`);
  if (
    !Number.isSafeInteger(x + width) ||
    !Number.isSafeInteger(y + height)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} endpoints must be safe integers.`,
    );
  }
  return {
    x,
    y,
    width,
    height,
  };
}

function readStampPattern(
  value: unknown,
  operationIndex: number,
): Array<Array<TileRef | null>> {
  const context = `operations[${operationIndex}].pattern`;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be a non-empty two-dimensional array.`,
    );
  }
  if (value.length > MAX_STAMP_PATTERN_EDGE) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A stamp pattern may have at most ${MAX_STAMP_PATTERN_EDGE} rows.`,
      {
        limit: MAX_STAMP_PATTERN_EDGE,
        actual: value.length,
      },
    );
  }
  const firstRow = value[0];
  if (!Array.isArray(firstRow) || firstRow.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}[0] must be a non-empty row.`,
    );
  }
  const width = firstRow.length;
  if (width > MAX_STAMP_PATTERN_EDGE) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A stamp pattern row may have at most ${MAX_STAMP_PATTERN_EDGE} cells.`,
      {
        limit: MAX_STAMP_PATTERN_EDGE,
        actual: width,
      },
    );
  }
  for (const [rowIndex, row] of value.entries()) {
    if (!Array.isArray(row) || row.length === 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}[${rowIndex}] must be a non-empty row.`,
      );
    }
    if (row.length !== width) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} must be rectangular; row ${rowIndex} has ${row.length} cells instead of ${width}.`,
      );
    }
  }
  const cellCount = value.length * width;
  if (
    !Number.isSafeInteger(cellCount) ||
    cellCount > MAX_STAMP_PATTERN_CELLS
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A stamp pattern may contain at most ${MAX_STAMP_PATTERN_CELLS} cells.`,
      {
        limit: MAX_STAMP_PATTERN_CELLS,
        actual: cellCount,
      },
    );
  }
  return value as Array<Array<TileRef | null>>;
}

function removeUnusedTilesetReference(
  map: JsonObject,
  bindings: readonly TilesetBinding[],
  tilesetAssetId: string,
  mapPath: string,
): Omit<
  NonNullable<
    MapEditPlan["summary"]["removedTilesets"]
  >[number],
  "operationIndex"
> {
  const binding = bindings.find(
    (candidate) =>
      candidate.assetId === tilesetAssetId,
  );
  if (binding === undefined) {
    throw new TiledMcpError(
      "TILESET_NOT_FOUND",
      `The requested tileset asset is not referenced by ${mapPath}.`,
      { mapPath, tilesetAssetId },
    );
  }

  const entries = expectArray(
    map.tilesets,
    `${mapPath}.tilesets`,
  );
  const index = entries.findIndex((value, entryIndex) => {
    const entry = expectObject(
      value,
      `${mapPath}.tilesets[${entryIndex}]`,
    );
    return (
      expectInteger(
        entry.firstgid,
        `${mapPath}.tilesets[${entryIndex}].firstgid`,
      ) === binding.firstGid
    );
  });
  if (index < 0) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `The serialized tileset entry for ${tilesetAssetId} is missing.`,
      {
        path: mapPath,
        tilesetAssetId,
        firstGid: binding.firstGid,
      },
    );
  }
  const entry = expectObject(
    entries[index],
    `${mapPath}.tilesets[${index}]`,
  );
  const source = expectString(
    entry.source,
    `${mapPath}.tilesets[${index}].source`,
  );
  const usage = inspectTilesetUsage(
    map,
    bindings,
    tilesetAssetId,
    mapPath,
  );

  entries.splice(index, 1);
  map.tilesets = entries;
  return {
    assetId: binding.assetId,
    tilesetPath: binding.path,
    source,
    tilesetRevision: binding.revision,
    name: binding.name,
    nameTruncated: binding.nameTruncated,
    index,
    tileCount: binding.tileCount,
    gidSpan: binding.gidSpan,
    firstGid: binding.firstGid,
    lastGid:
      binding.firstGid + binding.gidSpan - 1,
    scannedCellCount: usage.scannedCellCount,
    scannedObjectCount: usage.scannedObjectCount,
  };
}

