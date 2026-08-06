import {
  TiledMcpError,
  asTiledMcpError,
} from "../errors.js";
import {
  type JsonObject,
  type JsonValue,
  expectArray,
  expectInteger,
  expectObject,
  expectString,
  isJsonObject,
  stableJson,
} from "../formats/json.js";
import {
  type JsonArrayDeletion,
  type JsonArrayInsertion,
  type JsonArrayMove,
  type JsonObjectMemberPatch,
  type JsonSourcePath,
} from "../formats/jsonSourcePatch.js";
import {
  MAX_NATIVE_PREVIEW_OBJECTS,
  MAX_NATIVE_PREVIEW_OBJECT_POINTS,
  MAX_NATIVE_PREVIEW_TILE_COLLISION_SHAPES,
  type NativePreviewCollisionShapeInput,
  type NativePreviewCollisionShapeKind,
  type NativePreviewObjectInput,
} from "../images/mapPreview.js";
import {
  MAX_TILE_RENDER_LOCAL_IDS,
} from "../images/tilesetSheet.js";
import {
  type DocumentStore,
} from "../storage/documentStore.js";
import {
  type MapOrientation,
  decodeGid,
} from "./gid.js";
import {
  type BasicEditableObjectShape,
  type EditableContext,
  type EditableLayerLocation,
  type EmbeddedTilesetBinding,
  LAYER_PATCH_FIELDS,
  LAYER_PATCH_JSON_KEYS,
  type LayerPatchField,
  type LayerTraversalBudget,
  MAP_PATCH_FIELDS,
  MAP_PATCH_JSON_KEYS,
  MAP_RENDER_ORDERS,
  MAX_ABSOLUTE_OBJECT_NUMBER,
  MAX_ADD_TILESET_GID_SCANS,
  MAX_CREATE_TILE_LAYER_CELLS,
  MAX_DIAGNOSTICS,
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_LAYER_COUNT,
  MAX_LAYER_DEPTH,
  MAX_MAP_CLASS_NAME_CODE_POINTS,
  MAX_OBJECT_COUNT,
  MAX_OBJECT_DISPLAY_STRING_LENGTH,
  MAX_OBJECT_SHAPE_POINTS,
  MAX_OBJECT_STRING_LENGTH,
  MAX_REMOVE_TILESET_GID_SCANS,
  MAX_TILED_SIGNED_ID,
  MAX_TILESET_COUNT,
  MAX_USAGE_DISTINCT_TILES,
  MAX_USAGE_LAYER_SUMMARIES,
  MAX_USAGE_RESULT_BYTES,
  MAX_USAGE_SCAN_VALUES,
  MAX_USAGE_TILESET_SUMMARIES,
  MAX_USAGE_UNUSED_LOCAL_ID_SAMPLE,
  MIN_POLYGON_OBJECT_POINTS,
  MIN_POLYLINE_OBJECT_POINTS,
  type MapPatchField,
  type ObjectEditIndex,
  type ObjectLayerView,
  type ObjectLocation,
  type PlanCreateLayerInput,
  type ProspectiveImageBinding,
  type ProspectiveTilesetBinding,
  REVISION_PATTERN,
  TILED_COLOR_PATTERN,
  type TileLayerView,
  type TilesetBinding,
  type TilesetUsageInspection,
  type TilesetUsageReference,
} from "./mapDomain.js";
import {
  type PreviewScene,
} from "./previewScene.js";
import {
  projectScalarProperties,
} from "./propertyEdits.js";
import {
  type EffectiveTextObjectFields,
  TextObjectValidationError,
  parseTiledTextObjectData,
} from "./textObjects.js";
import {
  createChunkedCellView,
  decodeChunkCells,
  decodeEncodedTileLayerData,
  encodeTileLayerCells,
  readChunkedTileLayerStructure,
  resolveTileLayerCells,
} from "./tileData.js";
import {
  MAX_TILESET_METADATA_ENTRIES,
  assertAtlasTileDefinition,
} from "./tilesetDetails.js";
import {
  type Diagnostic,
  type MapEditPlan,
  type ObjectPathPoint,
  type ResolvedAddTilesetToMapOperation,
  type ResolvedCreateLayerOperation,
  type TileRef,
} from "./types.js";
import {
  createHash,
} from "node:crypto";
import {
  posix,
} from "node:path";
import { encodeGid } from "./gid.js";
import { MAX_LAYER_NAME_LENGTH } from "./mapDomain.js";
import { readChunkedViewGid } from "./tileData.js";
import { MAX_TILESET_INPUT_EDGE } from "../images/tilesetSheet.js";
export function resolveAddTilesetToMapOperation(
  context: EditableContext,
  prospective: ProspectiveTilesetBinding,
): ResolvedAddTilesetToMapOperation {
  const entries = expectArray(
    context.loaded.document.tilesets,
    `${context.loaded.path}.tilesets`,
  );
  if (entries.length >= MAX_TILESET_COUNT) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A map may reference at most ${MAX_TILESET_COUNT} tilesets in the MVP.`,
      {
        path: context.loaded.path,
        limit: MAX_TILESET_COUNT,
        actual: entries.length,
      },
    );
  }
  assertSerializedTilesetOrder(entries, context.loaded.path);

  const duplicate = context.bindings.find(
    (binding) =>
      binding.path === prospective.path ||
      binding.assetId === prospective.assetId,
  );
  if (duplicate !== undefined) {
    if (duplicate.path === prospective.path) {
      throw new TiledMcpError(
        "TILESET_ALREADY_REFERENCED",
        `${context.loaded.path} already references ${prospective.path}.`,
        {
          mapPath: context.loaded.path,
          tilesetPath: prospective.path,
          assetId: prospective.assetId,
          firstGid: duplicate.firstGid,
        },
      );
    }
    throw new TiledMcpError(
      "ASSET_ID_COLLISION",
      "Two distinct external tileset paths resolved to the same opaque asset id.",
      {
        assetId: prospective.assetId,
        existingPath: duplicate.path,
        prospectivePath: prospective.path,
      },
    );
  }

  assertCurrentMapGidsResolve(
    expectArray(context.loaded.document.layers, `${context.loaded.path}.layers`),
    context.bindings,
    context.loaded.path,
  );

  let firstGid = 1;
  for (const binding of context.bindings) {
    const afterRange = binding.firstGid + binding.gidSpan;
    if (!Number.isSafeInteger(afterRange)) {
      throw new TiledMcpError(
        "GID_RANGE_EXHAUSTED",
        "An existing tileset GID range exceeds safe integer bounds.",
        {
          path: context.loaded.path,
          assetId: binding.assetId,
          firstGid: binding.firstGid,
          tileCount: binding.tileCount,
          gidSpan: binding.gidSpan,
        },
      );
    }
    firstGid = Math.max(firstGid, afterRange);
  }
  const lastGid = firstGid + prospective.gidSpan - 1;
  if (
    !Number.isSafeInteger(firstGid) ||
    !Number.isSafeInteger(lastGid) ||
    firstGid <= 0 ||
    lastGid > 0x0fffffff
  ) {
    throw new TiledMcpError(
      "GID_RANGE_EXHAUSTED",
      "The prospective tileset does not fit in Tiled's 28-bit base GID range.",
      {
        path: context.loaded.path,
        tilesetPath: prospective.path,
        firstGid,
        tileCount: prospective.tileCount,
        gidSpan: prospective.gidSpan,
        maximumBaseGid: 0x0fffffff,
      },
    );
  }

  const source = posix.relative(
    posix.dirname(context.loaded.path),
    prospective.path,
  );
  if (
    source.length === 0 ||
    source.includes("\\") ||
    posix.isAbsolute(source) ||
    posix.normalize(source) !== source
  ) {
    throw new TiledMcpError(
      "INVALID_PROJECT_PATH",
      "The prospective tileset could not be represented by a canonical map-relative POSIX source.",
      {
        mapPath: context.loaded.path,
        tilesetPath: prospective.path,
        source,
      },
    );
  }
  return {
    type: "addTilesetToMap",
    tilesetPath: prospective.path,
    source,
    assetId: prospective.assetId,
    tilesetRevision: prospective.revision,
    tileCount: prospective.tileCount,
    gidSpan: prospective.gidSpan,
    firstGid,
  };
}

export function inspectTilesetUsage(
  map: JsonObject,
  bindings: readonly TilesetBinding[],
  tilesetAssetId: string,
  mapPath: string,
  localId?: number,
): TilesetUsageInspection {
  const result: TilesetUsageInspection = {
    scannedCellCount: 0,
    scannedObjectCount: 0,
  };
  const targetBinding = bindings.find(
    (binding) =>
      binding.assetId === tilesetAssetId,
  );
  if (targetBinding === undefined) {
    throw new TiledMcpError(
      "TILESET_NOT_FOUND",
      `The requested tileset asset is not referenced by ${mapPath}.`,
      { mapPath, tilesetAssetId },
    );
  }
  const traversalBudget: LayerTraversalBudget = {
    count: 0,
  };

  const record = (
    gid: JsonValue | undefined,
    reference: TilesetUsageReference,
    context: string,
  ): void => {
    if (
      typeof gid !== "number" ||
      !Number.isSafeInteger(gid) ||
      gid < 0 ||
      gid > 0xffffffff
    ) {
      throw new TiledMcpError(
        "INVALID_TILE_DATA",
        `${context} must be an unsigned 32-bit GID.`,
        { context },
      );
    }
    const tile = gidToTileRef(
      gid,
      "orthogonal",
      bindings,
    );
    if (
      tile === null ||
      tile.tileset.kind !== "external" ||
      tile.tileset.assetId !== tilesetAssetId ||
      (localId !== undefined &&
        tile.localId !== localId)
    ) {
      return;
    }
    throw new TiledMcpError(
      "TILESET_IN_USE",
      localId === undefined
        ? `Tileset ${tilesetAssetId} is still referenced by a ${reference.kind === "cell" ? "tile cell" : "tile object"}. Clear or replace every matching reference before removing the binding.`
        : `Tile ${localId} of tileset ${tilesetAssetId} is still referenced by a ${reference.kind === "cell" ? "tile cell" : "tile object"}. Clear or replace every matching reference before removing the entry.`,
      {
        ...(localId === undefined
          ? {}
          : { localId }),
        path: mapPath,
        tilesetAssetId,
        tilesetPath: targetBinding.path,
        firstGid: targetBinding.firstGid,
        lastGid:
          targetBinding.firstGid +
          targetBinding.gidSpan -
          1,
        cellReferenceCount:
          reference.kind === "cell" ? 1 : 0,
        objectReferenceCount:
          reference.kind === "object" ? 1 : 0,
        referenceCount: 1,
        referenceCountIsLowerBound: true,
        referenceSample: [reference],
        reference,
        scanStoppedAtFirstReference: true,
        scannedCellCount:
          result.scannedCellCount,
        scannedObjectCount:
          result.scannedObjectCount,
      },
    );
  };

  const visitLayers = (
    layers: JsonValue[],
    context: string,
    depth: number,
  ): void => {
    assertLayerTraversalBudget(
      layers.length,
      depth,
      traversalBudget,
    );
    for (const [layerIndex, layerValue] of layers.entries()) {
      const layerContext = `${context}[${layerIndex}]`;
      const layer = expectObject(
        layerValue,
        layerContext,
      );
      const layerId = expectInteger(
        layer.id,
        `${layerContext}.id`,
      );
      const layerType = expectString(
        layer.type,
        `${layerContext}.type`,
      );
      if (layerType === "group") {
        visitLayers(
          expectArray(
            layer.layers,
            `${layerContext}.layers`,
          ),
          `${layerContext}.layers`,
          depth + 1,
        );
        continue;
      }
      if (layerType === "imagelayer") {
        continue;
      }
      if (layerType === "objectgroup") {
        const objects = expectArray(
          layer.objects,
          `${layerContext}.objects`,
        );
        for (
          const [objectIndex, objectValue]
          of objects.entries()
        ) {
          consumeRemoveTilesetScanBudget(
            0,
            1,
            result,
            mapPath,
          );
          const objectContext =
            `${layerContext}.objects[${objectIndex}]`;
          const object = expectObject(
            objectValue,
            objectContext,
          );
          const objectId = expectInteger(
            object.id,
            `${objectContext}.id`,
          );
          if (
            Object.prototype.hasOwnProperty.call(
              object,
              "template",
            )
          ) {
            throw new TiledMcpError(
              "UNSUPPORTED_TILESET_REMOVAL_TEMPLATE",
              `Object ${objectId} uses a template whose hidden tile reference cannot be revision-pinned for tileset removal. Instantiate or remove the template object first, or keep the tileset binding.`,
              {
                path: mapPath,
                layerId,
                objectId,
              },
            );
          }
          if (object.gid === undefined) {
            continue;
          }
          record(
            object.gid,
            {
              kind: "object",
              layerId,
              objectId,
            },
            `${objectContext}.gid`,
          );
        }
        continue;
      }
      if (layerType !== "tilelayer") {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${layerContext}.type is not a supported Tiled layer type.`,
          { path: mapPath, layerId, layerType },
        );
      }
      const width = expectInteger(
        layer.width,
        `${layerContext}.width`,
      );
      const height = expectInteger(
        layer.height,
        `${layerContext}.height`,
      );
      assertPositiveInteger(
        width,
        `${layerContext}.width`,
      );
      assertPositiveInteger(
        height,
        `${layerContext}.height`,
      );
      const cellCount = width * height;
      // The removal scan only reads cells; encoded layers decode without
      // touching their stored bytes.
      const data = resolveTileLayerCells(
        layer,
        layerId,
        mapPath,
        cellCount,
        "read",
        "Removing a tileset reference supports only finite JSON tile layers with numeric data arrays.",
      );
      if (
        !Number.isSafeInteger(cellCount) ||
        data.length !== cellCount
      ) {
        throw new TiledMcpError(
          "INVALID_TILE_DATA",
          `Layer ${layerId} data length does not match width × height.`,
          {
            layerId,
            expected: cellCount,
            actual: data.length,
          },
        );
      }
      const layerX = readOptionalInteger(
        layer.x,
        `${layerContext}.x`,
        0,
      );
      const layerY = readOptionalInteger(
        layer.y,
        `${layerContext}.y`,
        0,
      );
      for (const [gidIndex, gid] of data.entries()) {
        consumeRemoveTilesetScanBudget(
          1,
          0,
          result,
          mapPath,
        );
        record(
          gid,
          {
            kind: "cell",
            layerId,
            x: layerX + (gidIndex % width),
            y:
              layerY +
              Math.floor(gidIndex / width),
          },
          `${layerContext}.data[${gidIndex}]`,
        );
      }
    }
  };

  visitLayers(
    expectArray(map.layers, `${mapPath}.layers`),
    `${mapPath}.layers`,
    0,
  );
  return result;
}

function consumeRemoveTilesetScanBudget(
  cellCount: number,
  objectCount: number,
  usage: TilesetUsageInspection,
  mapPath: string,
): void {
  const nextCount = cellCount + objectCount;
  const scanned =
    usage.scannedCellCount +
    usage.scannedObjectCount;
  if (
    !Number.isSafeInteger(cellCount) ||
    cellCount < 0 ||
    !Number.isSafeInteger(objectCount) ||
    objectCount < 0 ||
    !Number.isSafeInteger(nextCount) ||
    scanned + nextCount >
      MAX_REMOVE_TILESET_GID_SCANS
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Removing a tileset may scan at most ${MAX_REMOVE_TILESET_GID_SCANS} existing tile cells and objects.`,
      {
        path: mapPath,
        limit: MAX_REMOVE_TILESET_GID_SCANS,
        scanned,
        nextCount,
      },
    );
  }
  usage.scannedCellCount += cellCount;
  usage.scannedObjectCount += objectCount;
}

export function resolveCreateLayerOperation(
  context: EditableContext,
  input: Pick<
    PlanCreateLayerInput,
    "layerType" | "name" | "parentGroupId" | "index" | "imagePath"
  >,
  prospectiveImage?: ProspectiveImageBinding,
): ResolvedCreateLayerOperation {
  if (
    input.layerType !== "tilelayer" &&
    input.layerType !== "objectgroup" &&
    input.layerType !== "imagelayer" &&
    input.layerType !== "group"
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "layerType must be tilelayer, objectgroup, imagelayer or group.",
    );
  }
  assertBoundedString(input.name, "name");
  if (input.name.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "name must not be empty.",
    );
  }
  if (input.parentGroupId !== undefined) {
    assertPositiveInteger(input.parentGroupId, "parentGroupId");
  }
  if (
    input.index !== undefined &&
    (!Number.isSafeInteger(input.index) || input.index < 0)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "index must be a non-negative safe integer.",
    );
  }

  const map = context.loaded.document;
  const rootLayers = expectArray(
    map.layers,
    `${context.loaded.path}.layers`,
  );
  const inventory = inspectLayerTree(rootLayers, context.loaded.path);
  if (inventory.count >= MAX_LAYER_COUNT) {
    throw new TiledMcpError(
      "LAYER_LIMIT_EXCEEDED",
      `A map may contain at most ${MAX_LAYER_COUNT} layers.`,
      {
        path: context.loaded.path,
        limit: MAX_LAYER_COUNT,
        actual: inventory.count,
      },
    );
  }

  const nextLayerId = expectInteger(
    map.nextlayerid,
    `${context.loaded.path}.nextlayerid`,
  );
  if (
    nextLayerId <= 0 ||
    nextLayerId <= inventory.maximumId
  ) {
    throw new TiledMcpError(
      "NEXT_LAYER_ID_INVALID",
      `${context.loaded.path}.nextlayerid must be greater than every existing layer id.`,
      {
        path: context.loaded.path,
        nextLayerId,
        maximumExistingId: inventory.maximumId,
      },
    );
  }
  if (nextLayerId >= MAX_TILED_SIGNED_ID) {
    throw new TiledMcpError(
      "LAYER_ID_EXHAUSTED",
      `${context.loaded.path}.nextlayerid cannot be incremented within Tiled's signed 32-bit id space.`,
      {
        path: context.loaded.path,
        nextLayerId,
        maximumAllocatableLayerId: MAX_TILED_SIGNED_ID - 1,
      },
    );
  }

  const placement = layerContainerForParent(
    map,
    input.parentGroupId,
    context.loaded.path,
  );
  if (placement.childDepth > MAX_LAYER_DEPTH) {
    throw new TiledMcpError(
      "LAYER_LIMIT_EXCEEDED",
      `Creating this layer would exceed the maximum layer depth ${MAX_LAYER_DEPTH}.`,
      {
        path: context.loaded.path,
        parentGroupId: input.parentGroupId ?? null,
        childDepth: placement.childDepth,
        limit: MAX_LAYER_DEPTH,
      },
    );
  }
  const index = input.index ?? placement.layers.length;
  if (index < 0 || index > placement.layers.length) {
    throw new TiledMcpError(
      "LAYER_INDEX_OUT_OF_RANGE",
      `index must be between 0 and ${placement.layers.length} for the selected layer container.`,
      {
        path: context.loaded.path,
        parentGroupId: input.parentGroupId ?? null,
        index,
        minimum: 0,
        maximum: placement.layers.length,
      },
    );
  }

  let allocatedCellCount = 0;
  if (input.layerType === "tilelayer") {
    const cellCount = context.width * context.height;
    if (
      !Number.isSafeInteger(cellCount) ||
      cellCount > MAX_CREATE_TILE_LAYER_CELLS
    ) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `A new tile layer may allocate at most ${MAX_CREATE_TILE_LAYER_CELLS} cells.`,
        {
          path: context.loaded.path,
          width: context.width,
          height: context.height,
          actual: Number.isSafeInteger(cellCount) ? cellCount : null,
          limit: MAX_CREATE_TILE_LAYER_CELLS,
        },
      );
    }
    allocatedCellCount = cellCount;
  }

  if (
    (input.layerType === "imagelayer") !==
    (prospectiveImage !== undefined)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      input.layerType === "imagelayer"
        ? "An image layer requires a validated imagePath."
        : "Only an image layer may carry an image dependency.",
    );
  }
  if (
    prospectiveImage !== undefined &&
    input.imagePath !== prospectiveImage.path
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "The validated image path does not match imagePath.",
      {
        imagePath: input.imagePath,
        validatedPath: prospectiveImage.path,
      },
    );
  }

  return {
    type: "createLayer",
    layerType: input.layerType,
    layerId: nextLayerId,
    name: input.name,
    parentGroupId: input.parentGroupId ?? null,
    index,
    allocatedCellCount,
    ...(prospectiveImage === undefined
      ? {}
      : {
          image: {
            assetId: prospectiveImage.assetId,
            path: prospectiveImage.path,
            source: relativeProjectReference(
              context.loaded.path,
              prospectiveImage.path,
              "image",
            ),
            revision: prospectiveImage.revision,
            width: prospectiveImage.width,
            height: prospectiveImage.height,
          },
        }),
  };
}

export function inspectLayerTree(
  layers: JsonValue[],
  mapPath: string,
): { count: number; maximumId: number } {
  let count = 0;
  let maximumId = 0;
  const seen = new Set<number>();
  const visit = (
    entries: JsonValue[],
    context: string,
    depth: number,
  ): void => {
    if (
      depth > MAX_LAYER_DEPTH ||
      count + entries.length > MAX_LAYER_COUNT
    ) {
      throw new TiledMcpError(
        "LAYER_LIMIT_EXCEEDED",
        `Layer tree exceeds depth ${MAX_LAYER_DEPTH} or count ${MAX_LAYER_COUNT}.`,
        { path: mapPath },
      );
    }
    count += entries.length;
    for (const [index, value] of entries.entries()) {
      const layer = expectObject(value, `${context}[${index}]`);
      const id = expectInteger(layer.id, `${context}[${index}].id`);
      if (id <= 0 || seen.has(id)) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          id <= 0
            ? `${mapPath} contains a non-positive layer id.`
            : `${mapPath} contains duplicate layer id ${id}.`,
          { path: mapPath, layerId: id },
        );
      }
      seen.add(id);
      maximumId = Math.max(maximumId, id);
      if (layer.type === "group") {
        visit(
          expectArray(layer.layers, `${context}[${index}].layers`),
          `${context}[${index}].layers`,
          depth + 1,
        );
      }
    }
  };
  visit(layers, `${mapPath}.layers`, 0);
  return { count, maximumId };
}

export function layerContainerForParent(
  map: JsonObject,
  parentGroupId: number | null | undefined,
  mapPath: string,
): {
  layers: JsonValue[];
  path: JsonSourcePath;
  childDepth: number;
  parentLocked: boolean;
  effectiveParentLocked: boolean;
} {
  const rootLayers = expectArray(map.layers, `${mapPath}.layers`);
  if (parentGroupId === undefined || parentGroupId === null) {
    return {
      layers: rootLayers,
      path: ["layers"],
      childDepth: 0,
      parentLocked: false,
      effectiveParentLocked: false,
    };
  }
  const located = findLayerRecursive(
    rootLayers,
    parentGroupId,
    `${mapPath}.layers`,
    ["layers"],
  );
  if (located === undefined) {
    throw new TiledMcpError(
      "LAYER_NOT_FOUND",
      `Parent layer ${parentGroupId} does not exist.`,
      {
        path: mapPath,
        layerId: parentGroupId,
        role: "parent",
      },
    );
  }
  if (located.object.type !== "group") {
    throw new TiledMcpError(
      "LAYER_TYPE_MISMATCH",
      `Parent layer ${parentGroupId} is not a group layer.`,
      {
        path: mapPath,
        layerId: parentGroupId,
        role: "parent",
      },
    );
  }
  const numericSegments = located.path.filter(
    (segment): segment is number => typeof segment === "number",
  ).length;
  return {
    layers: expectArray(
      located.object.layers,
      `group layer ${parentGroupId}.layers`,
    ),
    path: [...located.path, "layers"],
    childDepth: numericSegments,
    parentLocked: located.object.locked === true,
    effectiveParentLocked:
      isLayerPathEffectivelyLocked(map, located.path),
  };
}

export function relativeProjectReference(
  fromPath: string,
  targetPath: string,
  kind: string,
): string {
  const source = posix.relative(posix.dirname(fromPath), targetPath);
  if (
    source.length === 0 ||
    source.includes("\\") ||
    posix.isAbsolute(source) ||
    posix.normalize(source) !== source
  ) {
    throw new TiledMcpError(
      "INVALID_PROJECT_PATH",
      `The prospective ${kind} could not be represented by a canonical map-relative POSIX source.`,
      { fromPath, targetPath, source },
    );
  }
  return source;
}

/**
 * Tiled allocates the next map-level firstgid from Tileset::nextTileId(), not
 * from the serialized tilecount. For an atlas this is normally tilecount, but
 * an explicit high tile definition also raises nextTileId and reserves the
 * intervening local-ID gap. Preserve that high-water mark even though the M1
 * TileRef profile only exposes the contiguous atlas cells.
 */
/**
 * Validates one embedded map tileset entry for the read-only profile.
 * Mirrors Tiled 1.12.2's embedded-variant reader: the entry carries the
 * same members as an external TSJ document (minus `type`/`version`, which
 * the writer emits only for standalone files) plus `firstgid`. Embedded
 * image collections and the pre-1.5 `terrains` member fail closed.
 */
export function readEmbeddedTilesetBinding(
  mapPath: string,
  entry: JsonObject,
  sourceIndex: number,
  firstGid: number,
): EmbeddedTilesetBinding {
  const context = `${mapPath}.tilesets[${sourceIndex}]`;
  if (entry.terrains !== undefined) {
    throw new TiledMcpError(
      "UNSUPPORTED_FORMAT",
      `${context} uses the pre-1.5 terrains member; its Wang-set conversion semantics are not supported.`,
      { path: mapPath, sourceIndex },
    );
  }
  if (typeof entry.image !== "string") {
    throw new TiledMcpError(
      "UNSUPPORTED_TILESET",
      `${context} is an embedded image-collection tileset; only embedded atlas tilesets are readable.`,
      { path: mapPath, sourceIndex },
    );
  }
  const tileCount = expectInteger(
    entry.tilecount,
    `${context}.tilecount`,
  );
  const gidSpan = tilesetGidSpan(
    entry,
    context,
    tileCount,
  );
  if (firstGid + gidSpan - 1 > 0x0fffffff) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} has an invalid tilecount.`,
      { path: mapPath, sourceIndex, tileCount, gidSpan },
    );
  }
  const displayName = boundedDisplayString(
    expectString(entry.name, `${context}.name`),
  );
  return {
    kind: "embedded",
    sourceIndex,
    firstGid,
    tileCount,
    gidSpan,
    name: displayName.value,
    nameTruncated: displayName.truncated,
    document: entry,
  };
}

export function tilesetGidSpan(
  document: JsonObject,
  path: string,
  tileCount: number,
): number {
  if (!Number.isSafeInteger(tileCount) || tileCount <= 0) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${path}.tilecount must be a positive safe integer.`,
      { path, tileCount },
    );
  }
  let gidSpan = tileCount;
  if (document.nexttileid !== undefined) {
    const nextTileId = expectInteger(
      document.nexttileid,
      `${path}.nexttileid`,
    );
    if (nextTileId <= 0 || nextTileId > 0x0fffffff) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${path}.nexttileid is outside the supported base-GID space.`,
        { path, nextTileId, maximumNextTileId: 0x0fffffff },
      );
    }
    gidSpan = Math.max(gidSpan, nextTileId);
  }
  const tileValues =
    document.tiles === undefined
      ? []
      : expectArray(document.tiles, `${path}.tiles`);
  if (tileValues.length > MAX_TILESET_METADATA_ENTRIES) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${path} has more than ${MAX_TILESET_METADATA_ENTRIES} tile metadata entries.`,
      {
        path,
        actual: tileValues.length,
        limit: MAX_TILESET_METADATA_ENTRIES,
      },
    );
  }

  for (const [index, value] of tileValues.entries()) {
    const tile = expectObject(value, `${path}.tiles[${index}]`);
    const localId = expectInteger(
      tile.id,
      `${path}.tiles[${index}].id`,
    );
    if (localId < 0 || localId >= 0x0fffffff) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${path}.tiles[${index}].id is outside the supported base-GID space.`,
        { path, index, localId, maximumLocalId: 0x0ffffffe },
      );
    }
    gidSpan = Math.max(gidSpan, localId + 1);
  }
  return gidSpan;
}

function assertSerializedTilesetOrder(
  entries: readonly JsonValue[],
  mapPath: string,
): void {
  let previousFirstGid = 0;
  for (const [index, value] of entries.entries()) {
    const entry = expectObject(value, `${mapPath}.tilesets[${index}]`);
    const firstGid = expectInteger(
      entry.firstgid,
      `${mapPath}.tilesets[${index}].firstgid`,
    );
    if (firstGid <= previousFirstGid) {
      throw new TiledMcpError(
        "UNSORTED_TILESET_REFERENCES",
        "Adding a tileset requires existing map references to be stored in strictly increasing firstgid order.",
        {
          path: mapPath,
          index,
          previousFirstGid,
          firstGid,
        },
      );
    }
    previousFirstGid = firstGid;
  }
}

function assertCurrentMapGidsResolve(
  layers: readonly JsonValue[],
  bindings: readonly TilesetBinding[],
  mapPath: string,
  depth = 0,
  budget: { scanned: number } = { scanned: 0 },
): void {
  if (depth > MAX_LAYER_DEPTH) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Layer tree exceeds depth ${MAX_LAYER_DEPTH}.`,
      { path: mapPath, maxDepth: MAX_LAYER_DEPTH },
    );
  }
  for (const [layerIndex, layerValue] of layers.entries()) {
    const layer = expectObject(
      layerValue,
      `${mapPath}.layers[${layerIndex}]`,
    );
    const type = expectString(
      layer.type,
      `${mapPath}.layers[${layerIndex}].type`,
    );
    if (type === "group") {
      assertCurrentMapGidsResolve(
        expectArray(
          layer.layers,
          `${mapPath}.layers[${layerIndex}].layers`,
        ),
        bindings,
        mapPath,
        depth + 1,
        budget,
      );
      continue;
    }
    if (type === "tilelayer") {
      const data = expectArray(
        layer.data,
        `${mapPath}.layers[${layerIndex}].data`,
      );
      consumeGidScanBudget(data.length, budget, mapPath);
      for (const [gidIndex, gid] of data.entries()) {
        assertResolvableGid(
          gid,
          bindings,
          `${mapPath}.layers[${layerIndex}].data[${gidIndex}]`,
        );
      }
      continue;
    }
    if (type !== "objectgroup") {
      continue;
    }
    const objects = expectArray(
      layer.objects,
      `${mapPath}.layers[${layerIndex}].objects`,
    );
    consumeGidScanBudget(objects.length, budget, mapPath);
    for (const [objectIndex, objectValue] of objects.entries()) {
      const object = expectObject(
        objectValue,
        `${mapPath}.layers[${layerIndex}].objects[${objectIndex}]`,
      );
      if (object.gid !== undefined) {
        assertResolvableGid(
          object.gid,
          bindings,
          `${mapPath}.layers[${layerIndex}].objects[${objectIndex}].gid`,
        );
      }
    }
  }
}

function consumeGidScanBudget(
  count: number,
  budget: { scanned: number },
  mapPath: string,
): void {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    budget.scanned + count > MAX_ADD_TILESET_GID_SCANS
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Adding a tileset may scan at most ${MAX_ADD_TILESET_GID_SCANS} existing tile cells and objects.`,
      {
        path: mapPath,
        limit: MAX_ADD_TILESET_GID_SCANS,
        scanned: budget.scanned,
        nextCount: count,
      },
    );
  }
  budget.scanned += count;
}

export function assertResolvableGid(
  value: JsonValue | undefined,
  bindings: readonly TilesetBinding[],
  context: string,
): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  ) {
    throw new TiledMcpError(
      "INVALID_TILE_DATA",
      `${context} must be an unsigned 32-bit GID.`,
      { context },
    );
  }
  if (value !== 0) {
    gidToTileRef(value, "orthogonal", bindings);
  }
}

export function readCollectionTileIds(
  document: JsonObject,
  tilesetPath: string,
): Set<number> {
  const entries = expectArray(
    document.tiles,
    `${tilesetPath}.tiles`,
  );
  const localIds = new Set<number>();
  for (const [index, value] of entries.entries()) {
    const entry = expectObject(
      value,
      `${tilesetPath}.tiles[${index}]`,
    );
    const id = expectInteger(
      entry.id,
      `${tilesetPath}.tiles[${index}].id`,
    );
    if (id < 0 || localIds.has(id)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${tilesetPath}.tiles[${index}].id must be a unique nonnegative integer.`,
        { path: tilesetPath, index, id },
      );
    }
    if (
      typeof entry.image !== "string" ||
      entry.image.length === 0
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${tilesetPath}.tiles[${index}] must carry a per-tile image in an image-collection tileset.`,
        { path: tilesetPath, index, id },
      );
    }
    for (const field of [
      "imagewidth",
      "imageheight",
    ] as const) {
      const size = entry[field];
      if (
        size !== undefined &&
        (typeof size !== "number" ||
          !Number.isSafeInteger(size) ||
          size <= 0)
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${tilesetPath}.tiles[${index}].${field} must be a positive integer.`,
          { path: tilesetPath, index, id },
        );
      }
    }
    localIds.add(id);
  }
  return localIds;
}

export function gidToTileRef(
  gid: number,
  orientation: MapOrientation,
  bindings: readonly TilesetBinding[],
  embeddedBindings?: readonly EmbeddedTilesetBinding[],
): TileRef | null {
  const decoded = decodeGid(gid, orientation);
  if (decoded.baseGid === 0) {
    return null;
  }
  let lower = 0;
  let upper = bindings.length - 1;
  let bindingIndex = -1;
  while (lower <= upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const candidate = bindings[middle];
    if (candidate !== undefined && candidate.firstGid <= decoded.baseGid) {
      bindingIndex = middle;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  const binding =
    bindingIndex < 0 ? undefined : bindings[bindingIndex];
  let embeddedMatch: EmbeddedTilesetBinding | undefined;
  if (embeddedBindings !== undefined) {
    for (const candidate of embeddedBindings) {
      if (
        candidate.firstGid <= decoded.baseGid &&
        (embeddedMatch === undefined ||
          candidate.firstGid > embeddedMatch.firstGid)
      ) {
        embeddedMatch = candidate;
      }
    }
  }
  if (
    embeddedMatch !== undefined &&
    (binding === undefined ||
      embeddedMatch.firstGid > binding.firstGid)
  ) {
    const localId =
      decoded.baseGid - embeddedMatch.firstGid;
    if (localId >= embeddedMatch.tileCount) {
      throw new TiledMcpError(
        "GID_OUT_OF_RANGE",
        `GID ${decoded.baseGid} falls outside embedded tileset ${embeddedMatch.name}.`,
        {
          gid: decoded.baseGid,
          embeddedSourceIndex:
            embeddedMatch.sourceIndex,
        },
      );
    }
    return {
      tileset: {
        kind: "embedded",
        sourceIndex: embeddedMatch.sourceIndex,
      },
      localId,
      transform: decoded.transform,
    };
  }
  if (!binding) {
    throw new TiledMcpError("GID_OUT_OF_RANGE", `GID ${decoded.baseGid} has no tileset.`);
  }
  const localId = decoded.baseGid - binding.firstGid;
  const insideRange =
    binding.localIds !== undefined
      ? binding.localIds.has(localId)
      : localId >= 0 &&
        localId < binding.tileCount;
  if (!insideRange) {
    throw new TiledMcpError(
      "GID_OUT_OF_RANGE",
      `GID ${decoded.baseGid} falls outside tileset ${binding.name}.`,
      { gid: decoded.baseGid, tilesetAssetId: binding.assetId },
    );
  }
  return {
    tileset: { kind: "external", assetId: binding.assetId },
    localId,
    transform: decoded.transform,
  };
}

/**
 * Re-encodes actually-written encoded tile layers before source patching.
 * A layer's `data` member flips from string to array exactly when the first
 * real cell write lands (writeLayerGid syncs the decoded view back), so
 * untouched encoded layers keep their exact original bytes. A written layer
 * whose decoded cells ended up identical to the original gets its original
 * string restored, preserving the exact-byte net no-op collapse.
 */
export function reencodeWrittenTileLayers(
  edited: JsonObject,
  original: JsonObject,
  affectedTileLayerIds: readonly number[],
  mapPath: string,
): void {
  for (const layerId of affectedTileLayerIds) {
    const located = findLayerRecursive(
      expectArray(
        edited.layers,
        `${mapPath}.layers`,
      ),
      layerId,
      `${mapPath}.layers`,
      ["layers"],
    );
    if (located === undefined) {
      continue;
    }
    const layer = located.object;
    const editedCells = layer.data;
    if (
      layer.encoding !== "base64" ||
      !Array.isArray(editedCells)
    ) {
      continue;
    }
    const compression =
      layer.compression === undefined ||
      layer.compression === ""
        ? ""
        : String(layer.compression);
    const originalLocated = findLayerRecursive(
      expectArray(
        original.layers,
        `${mapPath}.layers`,
      ),
      layerId,
      `${mapPath}.layers`,
      ["layers"],
    );
    const originalLayer = originalLocated?.object;
    if (
      originalLayer !== undefined &&
      typeof originalLayer.data === "string" &&
      originalLayer.encoding === "base64" &&
      (originalLayer.compression === undefined ||
      originalLayer.compression === ""
        ? ""
        : String(originalLayer.compression)) ===
        compression
    ) {
      const originalCells =
        decodeEncodedTileLayerData(
          originalLayer,
          layerId,
          mapPath,
          editedCells.length,
        );
      if (
        originalCells.length ===
          editedCells.length &&
        originalCells.every(
          (cell, index) =>
            cell === editedCells[index],
        )
      ) {
        layer.data = originalLayer.data;
        continue;
      }
    }
    layer.data = encodeTileLayerCells(
      editedCells,
      compression,
      layerId,
      mapPath,
    );
  }
}

export function findChunkedTileLayer(
  map: JsonObject,
  layerId: number,
  mapPath: string,
): {
  object: JsonObject;
  id: number;
  name: string;
} {
  const layers = expectArray(
    map.layers,
    `${mapPath}.layers`,
  );
  const located = findLayerRecursive(
    layers,
    layerId,
    `${mapPath}.layers`,
    ["layers"],
  );
  if (!located) {
    throw new TiledMcpError(
      "LAYER_NOT_FOUND",
      `Layer ${layerId} does not exist.`,
      { path: mapPath, layerId },
    );
  }
  const found = located.object;
  if (found.type !== "tilelayer") {
    throw new TiledMcpError(
      "LAYER_TYPE_MISMATCH",
      `Layer ${layerId} is not a tile layer.`,
      { path: mapPath, layerId },
    );
  }
  if (!("chunks" in found)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Layer ${layerId} of an infinite map must use chunked storage.`,
      { path: mapPath, layerId },
    );
  }
  return {
    object: found,
    id: expectInteger(
      found.id,
      `layer ${layerId}.id`,
    ),
    name:
      typeof found.name === "string"
        ? found.name
        : `Layer ${layerId}`,
  };
}

export function findTileLayer(
  map: JsonObject,
  layerId: number,
  mapPath: string,
  mode: "read" | "edit" = "edit",
  allowChunked = false,
): TileLayerView {
  const layers = expectArray(map.layers, `${mapPath}.layers`);
  const located = findLayerRecursive(
    layers,
    layerId,
    `${mapPath}.layers`,
    ["layers"],
  );
  if (!located) {
    throw new TiledMcpError("LAYER_NOT_FOUND", `Layer ${layerId} does not exist.`, {
      path: mapPath,
      layerId,
    });
  }
  const found = located.object;
  if (found.type !== "tilelayer") {
    throw new TiledMcpError("LAYER_TYPE_MISMATCH", `Layer ${layerId} is not a tile layer.`, {
      path: mapPath,
      layerId,
    });
  }
  if (allowChunked && "chunks" in found) {
    return {
      object: found,
      path: located.path,
      id: expectInteger(found.id, `layer ${layerId}.id`),
      name: typeof found.name === "string" ? found.name : `Layer ${layerId}`,
      x: readOptionalInteger(found.x, `layer ${layerId}.x`, 0),
      y: readOptionalInteger(found.y, `layer ${layerId}.y`, 0),
      width: readOptionalInteger(found.width, `layer ${layerId}.width`, 0),
      height: readOptionalInteger(found.height, `layer ${layerId}.height`, 0),
      data: [],
      chunked: createChunkedCellView(found, layerId, mapPath),
    };
  }
  const width = expectInteger(found.width, `layer ${layerId}.width`);
  const height = expectInteger(found.height, `layer ${layerId}.height`);
  assertPositiveInteger(width, `layer ${layerId}.width`);
  assertPositiveInteger(height, `layer ${layerId}.height`);
  const data = resolveTileLayerCells(
    found,
    layerId,
    mapPath,
    width * height,
    mode,
    "MVP editing supports only finite JSON tile layers with numeric data arrays.",
  );
  if (data.length !== width * height) {
    throw new TiledMcpError(
      "INVALID_TILE_DATA",
      `Layer ${layerId} data length does not match width × height.`,
      { layerId, expected: width * height, actual: data.length },
    );
  }
  return {
    object: found,
    path: located.path,
    id: expectInteger(found.id, `layer ${layerId}.id`),
    name: typeof found.name === "string" ? found.name : `Layer ${layerId}`,
    x: readOptionalInteger(found.x, `layer ${layerId}.x`, 0),
    y: readOptionalInteger(found.y, `layer ${layerId}.y`, 0),
    width,
    height,
    data,
  };
}

export function assertEditableLayerIdentities(
  layers: JsonValue[],
  mapPath: string,
): void {
  const ids = new Set<number>();
  const visit = (
    entries: JsonValue[],
    context: string,
    depth: number,
    budget: LayerTraversalBudget,
  ): void => {
    assertLayerTraversalBudget(entries.length, depth, budget);
    for (const [index, value] of entries.entries()) {
      const layer = expectObject(value, `${context}[${index}]`);
      const id = expectInteger(layer.id, `${context}[${index}].id`);
      if (id <= 0) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${mapPath} contains a non-positive layer id.`,
          { path: mapPath, layerId: id },
        );
      }
      if (ids.has(id)) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${mapPath} contains duplicate layer id ${id}.`,
          { path: mapPath, layerId: id },
        );
      }
      ids.add(id);
      if (layer.type === "group") {
        visit(
          expectArray(layer.layers, `${context}[${index}].layers`),
          `${context}[${index}].layers`,
          depth + 1,
          budget,
        );
      }
    }
  };

  visit(layers, `${mapPath}.layers`, 0, { count: 0 });
}

export function collectObjectLocationsFromLayer(
  layer: ObjectLayerView,
  mapPath: string,
): ObjectLocation[] {
  if (layer.objects.length > MAX_OBJECT_COUNT) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Map contains more than ${MAX_OBJECT_COUNT} objects.`,
      { path: mapPath, limit: MAX_OBJECT_COUNT },
    );
  }
  const locations = layer.objects.map((value, objectIndex) => ({
    object: expectObject(
      value,
      `${mapPath} object layer ${layer.id}.objects[${objectIndex}]`,
    ),
    objectIndex,
    layer,
    ancestors: layer.ancestors,
  }));
  assertUniqueObjectIds(locations, mapPath);
  return locations;
}

function assertUniqueObjectIds(
  locations: readonly ObjectLocation[],
  mapPath: string,
): void {
  const ids = new Set<number>();
  for (const location of locations) {
    const id = expectInteger(location.object.id, `${mapPath} object id`);
    if (id <= 0) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${mapPath} contains a non-positive object id.`,
        { path: mapPath, objectId: id },
      );
    }
    if (ids.has(id)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${mapPath} contains duplicate object id ${id}.`,
        { path: mapPath, objectId: id },
      );
    }
    ids.add(id);
  }
}

export function buildObjectEditIndex(
  map: JsonObject,
  mapPath: string,
): ObjectEditIndex {
  const locations = collectObjectLocations(map, mapPath);
  const byId = new Map<number, ObjectLocation>();
  let maximumId = 0;
  for (const location of locations) {
    const id = expectInteger(location.object.id, `${mapPath} object id`);
    byId.set(id, location);
    maximumId = Math.max(maximumId, id);
  }
  return { byId, maximumId };
}

export function findObjectLocation(
  index: ObjectEditIndex,
  objectId: number,
  mapPath: string,
): ObjectLocation {
  const found = index.byId.get(objectId);
  if (!found) {
    throw new TiledMcpError(
      "OBJECT_NOT_FOUND",
      `Object ${objectId} does not exist in ${mapPath}.`,
      { path: mapPath, objectId },
    );
  }
  return found;
}

export function summarizeMapRootProperties(
  map: JsonObject,
  mapPath: string,
): {
  renderOrder:
    | "right-down"
    | "right-up"
    | "left-down"
    | "left-up";
  backgroundColor?: string;
  className?: string;
  classNameTruncated?: true;
} {
  const rawRenderOrder =
    map.renderorder === undefined
      ? "right-down"
      : map.renderorder;
  if (
    typeof rawRenderOrder !== "string" ||
    !MAP_RENDER_ORDERS.has(rawRenderOrder)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${mapPath}.renderorder is not a supported orthogonal render order.`,
      {
        path: mapPath,
        renderOrder: rawRenderOrder,
      },
    );
  }
  const backgroundColor = map.backgroundcolor;
  if (
    backgroundColor !== undefined &&
    (typeof backgroundColor !== "string" ||
      !TILED_COLOR_PATTERN.test(backgroundColor))
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${mapPath}.backgroundcolor must be #RRGGBB or #AARRGGBB.`,
      { path: mapPath },
    );
  }
  const className = map.class;
  if (
    className !== undefined &&
    typeof className !== "string"
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${mapPath}.class must be a string.`,
      { path: mapPath },
    );
  }
  const boundedClassName =
    className === undefined
      ? undefined
      : boundedMapClassName(className);
  return {
    renderOrder: rawRenderOrder as
      | "right-down"
      | "right-up"
      | "left-down"
      | "left-up",
    ...(backgroundColor === undefined
      ? {}
      : { backgroundColor }),
    ...(boundedClassName === undefined
      ? {}
      : {
          className: boundedClassName.value,
          ...(boundedClassName.truncated
            ? { classNameTruncated: true as const }
            : {}),
        }),
  };
}

export function mapPatchJsonKey(field: MapPatchField): string {
  return MAP_PATCH_JSON_KEYS[field];
}

function boundedMapClassName(value: string): {
  value: string;
  truncated: boolean;
} {
  let displayEnd = 0;
  let codePointCount = 0;
  for (const codePoint of value) {
    codePointCount += 1;
    if (
      codePointCount >
      MAX_MAP_CLASS_NAME_CODE_POINTS
    ) {
      return {
        value: value.slice(0, displayEnd),
        truncated: true,
      };
    }
    displayEnd += codePoint.length;
  }
  return { value, truncated: false };
}

export function findEditableLayer(
  map: JsonObject,
  layerId: number,
  mapPath: string,
): EditableLayerLocation {
  const layers = expectArray(map.layers, `${mapPath}.layers`);
  const located = findLayerRecursive(
    layers,
    layerId,
    `${mapPath}.layers`,
    ["layers"],
  );
  if (located === undefined) {
    throw new TiledMcpError(
      "LAYER_NOT_FOUND",
      `Layer ${layerId} does not exist.`,
      { path: mapPath, layerId },
    );
  }
  const type = expectString(
    located.object.type,
    `layer ${layerId}.type`,
  );
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
    object: located.object,
    path: located.path,
    id: expectInteger(
      located.object.id,
      `layer ${layerId}.id`,
    ),
    type,
  };
}

export function layerPatchJsonKey(field: LayerPatchField): string {
  return LAYER_PATCH_JSON_KEYS[field];
}

export function assertObjectPathPoints(
  value: unknown,
  shape: "polygon" | "polyline",
  context: string,
  errorCode: "INVALID_ARGUMENT" | "INVALID_DOCUMENT",
): void {
  const minimum =
    shape === "polygon"
      ? MIN_POLYGON_OBJECT_POINTS
      : MIN_POLYLINE_OBJECT_POINTS;
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > MAX_OBJECT_SHAPE_POINTS
  ) {
    throw new TiledMcpError(
      errorCode,
      `${context} must contain between ${minimum} and ${MAX_OBJECT_SHAPE_POINTS} points for a ${shape}.`,
      {
        shape,
        count: Array.isArray(value) ? value.length : null,
        min: minimum,
        max: MAX_OBJECT_SHAPE_POINTS,
      },
    );
  }
  for (const [pointIndex, point] of value.entries()) {
    if (!isRecordValue(point)) {
      throw new TiledMcpError(
        errorCode,
        `${context}[${pointIndex}] must be an object with exactly x and y.`,
        { shape, pointIndex },
      );
    }
    const keys = Object.keys(point).sort();
    if (keys.length !== 2 || keys[0] !== "x" || keys[1] !== "y") {
      throw new TiledMcpError(
        errorCode,
        `${context}[${pointIndex}] must contain exactly x and y.`,
        { shape, pointIndex },
      );
    }
    assertObjectPathCoordinate(
      point.x,
      `${context}[${pointIndex}].x`,
      errorCode,
    );
    assertObjectPathCoordinate(
      point.y,
      `${context}[${pointIndex}].y`,
      errorCode,
    );
  }
}

export function assertBoundedString(value: unknown, context: string): void {
  if (typeof value !== "string" || value.length > MAX_OBJECT_STRING_LENGTH) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be a string of at most ${MAX_OBJECT_STRING_LENGTH} characters.`,
    );
  }
}

function assertStoredTextObjectData(
  value: unknown,
  objectId: number,
  mapPath: string,
): EffectiveTextObjectFields {
  try {
    return parseTiledTextObjectData(value);
  } catch (error) {
    if (error instanceof TextObjectValidationError) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `Object ${objectId}.text is not in the bounded editable text profile: ${error.message}`,
        {
          path: mapPath,
          objectId,
          field: error.field,
        },
      );
    }
    throw error;
  }
}

interface PendingTileObjectFrame {
  entryIndex: number;
  objectId: number;
  assetId: string;
  localId: number;
  flipH: boolean;
  flipV: boolean;
  flipD: boolean;
  rawWidth: number;
  rawHeight: number;
}

export interface PreparedNativePreviewObjectDebug {
  objects: NativePreviewObjectInput[];
  pendingTileFrames: PendingTileObjectFrame[];
  tileObjectCollision: boolean;
}

export function prepareNativePreviewObjectDebug(
  map: JsonObject,
  mapPath: string,
  objectIds: readonly number[] | undefined,
  bindings: readonly TilesetBinding[],
  tileObjectCollision: boolean,
): PreparedNativePreviewObjectDebug | undefined {
  if (objectIds === undefined) {
    if (tileObjectCollision) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "overlays.tileObjectCollision requires overlays.objectIds.",
      );
    }
    return undefined;
  }
  if (
    !Array.isArray(objectIds) ||
    objectIds.length < 1 ||
    objectIds.length > MAX_NATIVE_PREVIEW_OBJECTS
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `overlays.objectIds must contain between 1 and ${MAX_NATIVE_PREVIEW_OBJECTS} IDs when provided.`,
      {
        count: Array.isArray(objectIds)
          ? objectIds.length
          : null,
        min: 1,
        max: MAX_NATIVE_PREVIEW_OBJECTS,
      },
    );
  }
  const seen = new Set<number>();
  for (const [sourceIndex, objectId] of objectIds.entries()) {
    if (!Number.isSafeInteger(objectId) || objectId <= 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "overlays.objectIds must contain positive safe integers.",
        { sourceIndex, objectId },
      );
    }
    if (seen.has(objectId)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `overlays.objectIds contains duplicate object ID ${objectId}.`,
        { sourceIndex, objectId },
      );
    }
    seen.add(objectId);
  }

  const index = buildObjectEditIndex(map, mapPath);
  const selected: NativePreviewObjectInput[] = [];
  const pendingTileFrames: PendingTileObjectFrame[] =
    [];
  let pointCount = 0;
  for (const [sourceIndex, objectId] of objectIds.entries()) {
    const location = findObjectLocation(
      index,
      objectId,
      mapPath,
    );
    if (
      !Object.prototype.hasOwnProperty.call(
        location.object,
        "template",
      ) &&
      Object.prototype.hasOwnProperty.call(
        location.object,
        "gid",
      )
    ) {
      pendingTileFrames.push(
        prepareTileObjectFrameEntry(
          location,
          objectId,
          sourceIndex,
          selected,
          bindings,
          mapPath,
        ),
      );
      continue;
    }
    const shape = assertBasicEditableObject(
      location.object,
      objectId,
      mapPath,
    );
    assertNativePreviewObjectRenderContext(
      location,
      objectId,
      mapPath,
    );
    const common = {
      sourceIndex,
      objectId,
      layerId: location.layer.id,
      x: location.object.x as number,
      y: location.object.y as number,
      rotation: displayNumber(
        location.object.rotation,
        0,
      ),
    };
    if (
      shape === "rectangle" ||
      shape === "ellipse" ||
      shape === "capsule"
    ) {
      selected.push({
        ...common,
        shape,
        representation: "geometry-outline",
        width: displayNumber(
          location.object.width,
          0,
        ),
        height: displayNumber(
          location.object.height,
          0,
        ),
      });
      continue;
    }
    if (shape === "text") {
      selected.push({
        ...common,
        shape,
        representation: "text-box-only",
        width: displayNumber(location.object.width, 0),
        height: displayNumber(location.object.height, 0),
      });
      continue;
    }
    if (shape === "point") {
      selected.push({
        ...common,
        shape,
        representation: "geometry-outline",
      });
      continue;
    }

    const points = expectArray(
      location.object[shape],
      `object ${objectId}.${shape}`,
    ).map((value, pointIndex) => {
      const point = expectObject(
        value,
        `object ${objectId}.${shape}[${pointIndex}]`,
      );
      return {
        x: point.x as number,
        y: point.y as number,
      };
    });
    pointCount += points.length;
    if (
      !Number.isSafeInteger(pointCount) ||
      pointCount > MAX_NATIVE_PREVIEW_OBJECT_POINTS
    ) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `Native object debug overlay may contain at most ${MAX_NATIVE_PREVIEW_OBJECT_POINTS} polygon/polyline points.`,
        {
          actual: pointCount,
          limit: MAX_NATIVE_PREVIEW_OBJECT_POINTS,
          sourceIndex,
          objectId,
        },
      );
    }
    selected.push({
      ...common,
      shape,
      representation: "geometry-outline",
      points,
    });
  }
  return {
    objects: selected,
    pendingTileFrames,
    tileObjectCollision,
  };
}

const TILESET_OBJECT_ALIGNMENTS = new Set([
  "unspecified",
  "topleft",
  "top",
  "topright",
  "left",
  "center",
  "right",
  "bottomleft",
  "bottom",
  "bottomright",
]);

function prepareTileObjectFrameEntry(
  location: ObjectLocation,
  objectId: number,
  sourceIndex: number,
  selected: NativePreviewObjectInput[],
  bindings: readonly TilesetBinding[],
  mapPath: string,
): PendingTileObjectFrame {
  const object = location.object;
  const gid = object.gid;
  if (
    typeof gid !== "number" ||
    !Number.isSafeInteger(gid) ||
    gid < 0 ||
    gid > 0xffffffff
  ) {
    throw new TiledMcpError(
      "INVALID_TILE_DATA",
      `Object ${objectId}.gid must be an unsigned 32-bit GID.`,
      { path: mapPath, objectId },
    );
  }
  const tileRef = gidToTileRef(
    gid,
    "orthogonal",
    bindings,
  );
  if (tileRef === null) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId}.gid must reference a tile; tile objects cannot use the empty GID.`,
      { path: mapPath, objectId },
    );
  }
  const conflictingMarker = [
    "point",
    "ellipse",
    "capsule",
    "polygon",
    "polyline",
    "text",
  ].find((marker) =>
    Object.prototype.hasOwnProperty.call(
      object,
      marker,
    ),
  );
  if (conflictingMarker !== undefined) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId} combines gid with the ${conflictingMarker} shape marker.`,
      {
        path: mapPath,
        objectId,
        feature: conflictingMarker,
      },
    );
  }
  assertNativePreviewObjectRenderContext(
    location,
    objectId,
    mapPath,
  );
  const rawWidth = readTileObjectDimension(
    object.width,
    objectId,
    "width",
    mapPath,
  );
  const rawHeight = readTileObjectDimension(
    object.height,
    objectId,
    "height",
    mapPath,
  );
  if (tileRef.tileset.kind !== "external") {
    throw new TiledMcpError(
      "INTERNAL_ERROR",
      "Preview scenes only reference external tilesets.",
      { objectId },
    );
  }
  const transform = tileRef.transform as
    | {
        flipH?: boolean;
        flipV?: boolean;
        flipD?: boolean;
      }
    | undefined;
  const pending: PendingTileObjectFrame = {
    entryIndex: selected.length,
    objectId,
    assetId: tileRef.tileset.assetId,
    localId: tileRef.localId,
    flipH: transform?.flipH === true,
    flipV: transform?.flipV === true,
    flipD: transform?.flipD === true,
    rawWidth,
    rawHeight,
  };
  selected.push({
    sourceIndex,
    objectId,
    layerId: location.layer.id,
    x: object.x as number,
    y: object.y as number,
    rotation: displayNumber(object.rotation, 0),
    shape: "tile",
    representation: "tile-frame-only",
    width: 0,
    height: 0,
    boxOffsetX: 0,
    boxOffsetY: 0,
  });
  return pending;
}

function readTileObjectDimension(
  value: JsonValue | undefined,
  objectId: number,
  field: "width" | "height",
  mapPath: string,
): number {
  if (value === undefined) {
    return 0;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_ABSOLUTE_OBJECT_NUMBER
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId}.${field} must be a finite nonnegative number.`,
      { path: mapPath, objectId, field },
    );
  }
  return value;
}

export function readTilesetObjectAlignment(
  document: JsonObject,
  tilesetPath: string,
): string {
  const value = document.objectalignment;
  if (value === undefined) {
    return "unspecified";
  }
  if (
    typeof value !== "string" ||
    !TILESET_OBJECT_ALIGNMENTS.has(value)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${tilesetPath}.objectalignment is not a supported Tiled alignment.`,
      { path: tilesetPath, value },
    );
  }
  return value;
}

export function readTilesetTileOffset(
  document: JsonObject,
  tilesetPath: string,
): { x: number; y: number } {
  const value = document.tileoffset;
  if (value === undefined) {
    return { x: 0, y: 0 };
  }
  if (!isRecordValue(value)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${tilesetPath}.tileoffset must be an object.`,
      { path: tilesetPath },
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "x,y"
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${tilesetPath}.tileoffset must contain exactly x and y.`,
      { path: tilesetPath },
    );
  }
  for (const axis of ["x", "y"] as const) {
    const component = record[axis];
    if (
      typeof component !== "number" ||
      !Number.isSafeInteger(component) ||
      Math.abs(component) >
        MAX_ABSOLUTE_OBJECT_NUMBER
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${tilesetPath}.tileoffset.${axis} must be a bounded integer.`,
        { path: tilesetPath, axis },
      );
    }
  }
  return {
    x: record.x as number,
    y: record.y as number,
  };
}

export interface TileObjectFrameTileset {
  tileWidth: number;
  tileHeight: number;
  objectAlignment: string;
  tileOffsetX: number;
  tileOffsetY: number;
  collision: ReadonlyMap<
    number,
    readonly TileCollisionSource[]
  >;
}

interface TileCollisionSource {
  kind: NativePreviewCollisionShapeKind;
  x: number;
  y: number;
  rotation: number;
  width: number;
  height: number;
  points?: ObjectPathPoint[];
}

const MAX_TILESET_COLLISION_TILE_SCAN = 100_000;
const COLLISION_GROUP_ALLOWED_KEYS = new Set([
  "class",
  "color",
  "draworder",
  "id",
  "locked",
  "mode",
  "name",
  "objects",
  "offsetx",
  "offsety",
  "opacity",
  "parallaxx",
  "parallaxy",
  "properties",
  "tintcolor",
  "type",
  "visible",
  "x",
  "y",
]);
const COLLISION_OBJECT_ALLOWED_KEYS = new Set([
  "capsule",
  "class",
  "ellipse",
  "height",
  "id",
  "name",
  "opacity",
  "point",
  "polygon",
  "polyline",
  "properties",
  "rotation",
  "text",
  "type",
  "visible",
  "width",
  "x",
  "y",
]);

export function readTilesetCollisionSources(
  document: JsonObject,
  tilesetPath: string,
  localIds: ReadonlySet<number>,
): Map<number, readonly TileCollisionSource[]> {
  const fillMode = document.fillmode;
  if (
    fillMode !== undefined &&
    fillMode !== "stretch"
  ) {
    throw new TiledMcpError(
      "UNSUPPORTED_RENDER_FEATURE",
      `${tilesetPath} uses a non-default fillmode, whose collision scaling is not supported.`,
      { path: tilesetPath, feature: "fillmode" },
    );
  }
  const collision = new Map<
    number,
    readonly TileCollisionSource[]
  >();
  if (document.tiles === undefined) {
    return collision;
  }
  const tiles = expectArray(
    document.tiles,
    `${tilesetPath}.tiles`,
  );
  if (tiles.length > MAX_TILESET_COLLISION_TILE_SCAN) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${tilesetPath}.tiles exceeds the ${MAX_TILESET_COLLISION_TILE_SCAN}-entry collision scan limit.`,
      {
        limit: MAX_TILESET_COLLISION_TILE_SCAN,
        actual: tiles.length,
      },
    );
  }
  for (const [tileIndex, value] of tiles.entries()) {
    const tile = expectObject(
      value,
      `${tilesetPath}.tiles[${tileIndex}]`,
    );
    const localId = expectInteger(
      tile.id,
      `${tilesetPath}.tiles[${tileIndex}].id`,
    );
    if (
      !localIds.has(localId) ||
      tile.objectgroup === undefined
    ) {
      continue;
    }
    collision.set(
      localId,
      readTileCollisionObjects(
        tile.objectgroup,
        `${tilesetPath}.tiles[${tileIndex}].objectgroup`,
        tilesetPath,
      ),
    );
  }
  return collision;
}

function readTileCollisionObjects(
  value: JsonValue,
  context: string,
  tilesetPath: string,
): readonly TileCollisionSource[] {
  const group = expectObject(value, context);
  if (group.type !== "objectgroup") {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context}.type must be "objectgroup".`,
      { path: tilesetPath },
    );
  }
  const unknownGroupKey = Object.keys(group).find(
    (key) => !COLLISION_GROUP_ALLOWED_KEYS.has(key),
  );
  if (unknownGroupKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} contains unsupported member ${unknownGroupKey}.`,
      { path: tilesetPath, member: unknownGroupKey },
    );
  }
  const objects = expectArray(
    group.objects,
    `${context}.objects`,
  );
  if (
    objects.length >
    MAX_NATIVE_PREVIEW_TILE_COLLISION_SHAPES
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${context}.objects exceeds the ${MAX_NATIVE_PREVIEW_TILE_COLLISION_SHAPES}-shape collision limit.`,
      {
        limit:
          MAX_NATIVE_PREVIEW_TILE_COLLISION_SHAPES,
        actual: objects.length,
      },
    );
  }
  return objects.map((objectValue, objectIndex) =>
    readTileCollisionObject(
      objectValue,
      `${context}.objects[${objectIndex}]`,
      tilesetPath,
    ),
  );
}

function readTileCollisionObject(
  value: JsonValue,
  context: string,
  tilesetPath: string,
): TileCollisionSource {
  const object = expectObject(value, context);
  for (const feature of [
    "gid",
    "template",
  ] as const) {
    if (
      Object.prototype.hasOwnProperty.call(
        object,
        feature,
      )
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_OBJECT_PROFILE",
        `${context} uses ${feature}, which is outside supported tile collision shapes.`,
        { path: tilesetPath, feature },
      );
    }
  }
  const unknownKey = Object.keys(object).find(
    (key) => !COLLISION_OBJECT_ALLOWED_KEYS.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} contains unsupported member ${unknownKey}.`,
      { path: tilesetPath, member: unknownKey },
    );
  }
  const markers = [
    "polygon",
    "polyline",
    "ellipse",
    "capsule",
    "point",
    "text",
  ].filter((marker) =>
    Object.prototype.hasOwnProperty.call(
      object,
      marker,
    ),
  );
  if (markers.length > 1) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} contains conflicting shape markers.`,
      { path: tilesetPath },
    );
  }
  const marker = markers[0];
  const readCoordinate = (
    field: "x" | "y" | "rotation",
  ): number => {
    const raw = object[field];
    if (raw === undefined) {
      return 0;
    }
    if (
      typeof raw !== "number" ||
      !Number.isFinite(raw) ||
      Math.abs(raw) > MAX_ABSOLUTE_OBJECT_NUMBER
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.${field} must be a bounded finite number.`,
        { path: tilesetPath, field },
      );
    }
    return raw;
  };
  const readExtent = (
    field: "width" | "height",
  ): number => {
    const raw = object[field];
    if (raw === undefined) {
      return 0;
    }
    if (
      typeof raw !== "number" ||
      !Number.isFinite(raw) ||
      raw < 0 ||
      raw > MAX_ABSOLUTE_OBJECT_NUMBER
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.${field} must be a bounded nonnegative number.`,
        { path: tilesetPath, field },
      );
    }
    return raw;
  };
  const common = {
    x: readCoordinate("x"),
    y: readCoordinate("y"),
    rotation: readCoordinate("rotation"),
    width: readExtent("width"),
    height: readExtent("height"),
  };
  if (
    marker === "polygon" ||
    marker === "polyline"
  ) {
    assertObjectPathPoints(
      object[marker],
      marker,
      `${context}.${marker}`,
      "INVALID_DOCUMENT",
    );
    return {
      kind: marker,
      ...common,
      points: (
        object[marker] as unknown as ObjectPathPoint[]
      ).map((point) => ({
        x: point.x,
        y: point.y,
      })),
    };
  }
  if (
    marker === "ellipse" ||
    marker === "capsule" ||
    marker === "point"
  ) {
    if (object[marker] !== true) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.${marker} must be true when present.`,
        { path: tilesetPath, feature: marker },
      );
    }
    return { kind: marker, ...common };
  }
  if (marker === "text") {
    // Tiled's collision shape path draws a text object as its plain bounds
    // rectangle.
    expectObject(object.text, `${context}.text`);
    return { kind: "rectangle", ...common };
  }
  return { kind: "rectangle", ...common };
}

export function buildTileCollisionShapeInputs(
  pending: PendingTileObjectFrame,
  frame: TileObjectFrameTileset,
  effective: {
    width: number;
    height: number;
    alignmentOffsetX: number;
    alignmentOffsetY: number;
  },
): NativePreviewCollisionShapeInput[] {
  const sources =
    frame.collision.get(pending.localId) ?? [];
  const scaleX = effective.width / frame.tileWidth;
  const scaleY =
    effective.height / frame.tileHeight;
  let rotated = false;
  let flipH = pending.flipH;
  let flipV = pending.flipV;
  let fragmentX =
    effective.width / 2 +
    frame.tileOffsetX * scaleX;
  let fragmentY =
    effective.height / 2 +
    frame.tileOffsetY * scaleY;
  if (pending.flipD) {
    rotated = true;
    const wasFlippedH = pending.flipH;
    flipH = pending.flipV;
    flipV = !wasFlippedH;
    const halfDiff =
      effective.height / 2 - effective.width / 2;
    fragmentX += halfDiff;
    fragmentY += halfDiff;
  }
  const signedScaleX = (flipH ? -1 : 1) * scaleX;
  const signedScaleY = (flipV ? -1 : 1) * scaleY;
  const linearA = rotated ? 0 : signedScaleX;
  const linearB = rotated ? signedScaleX : 0;
  const linearC = rotated ? -signedScaleY : 0;
  const linearD = rotated ? 0 : signedScaleY;
  return sources.map((source) => {
    const radians =
      (((source.rotation % 360) + 360) % 360) *
      (Math.PI / 180);
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const localX = source.x - frame.tileWidth / 2;
    const localY = source.y - frame.tileHeight / 2;
    const transform = [
      linearA * cosine + linearC * sine,
      linearB * cosine + linearD * sine,
      linearA * -sine + linearC * cosine,
      linearB * -sine + linearD * cosine,
      fragmentX -
        effective.alignmentOffsetX +
        linearA * localX +
        linearC * localY,
      fragmentY -
        effective.alignmentOffsetY +
        linearB * localX +
        linearD * localY,
    ] as const;
    for (const value of transform) {
      if (
        !Number.isFinite(value) ||
        Math.abs(value) >
          MAX_ABSOLUTE_OBJECT_NUMBER
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `Object ${pending.objectId} collision transform is outside the supported numeric range.`,
          { objectId: pending.objectId },
        );
      }
    }
    if (
      source.kind === "polygon" ||
      source.kind === "polyline"
    ) {
      return {
        kind: source.kind,
        transform,
        points: (source.points ?? []).map(
          (point) => ({ x: point.x, y: point.y }),
        ),
      };
    }
    if (source.kind === "point") {
      return { kind: source.kind, transform };
    }
    return {
      kind: source.kind,
      transform,
      width: source.width,
      height: source.height,
    };
  });
}

/**
 * Tiled resolves "unspecified" to bottom-left on orthogonal maps; the offset
 * is subtracted from the object anchor to reach the frame's top-left corner.
 */
export function tileObjectAlignmentOffset(
  alignment: string,
  width: number,
  height: number,
): { x: number; y: number } {
  switch (alignment) {
    case "topleft":
      return { x: 0, y: 0 };
    case "top":
      return { x: width / 2, y: 0 };
    case "topright":
      return { x: width, y: 0 };
    case "left":
      return { x: 0, y: height / 2 };
    case "center":
      return { x: width / 2, y: height / 2 };
    case "right":
      return { x: width, y: height / 2 };
    case "bottom":
      return { x: width / 2, y: height };
    case "bottomright":
      return { x: width, y: height };
    default:
      return { x: 0, y: height };
  }
}

function assertNativePreviewObjectRenderContext(
  location: ObjectLocation,
  objectId: number,
  mapPath: string,
): void {
  for (const [ancestorIndex, ancestor] of
    location.ancestors.entries()) {
    assertNativePreviewObjectLayerPosition({
      layer: ancestor,
      context: `${mapPath} ancestor group ${ancestorIndex}`,
      objectId,
      layerId: location.layer.id,
      role: "group",
    });
  }
  assertNativePreviewObjectLayerPosition({
    layer: location.layer.object,
    context: `${mapPath} object layer ${location.layer.id}`,
    objectId,
    layerId: location.layer.id,
    role: "object-layer",
  });
}

function assertNativePreviewObjectLayerPosition(input: {
  layer: JsonObject;
  context: string;
  objectId: number;
  layerId: number;
  role: "group" | "object-layer";
}): void {
  for (const field of ["x", "y"] as const) {
    const value = input.layer[field] ?? 0;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${input.context}.${field} must be a safe integer.`,
        {
          path: input.context,
          objectId: input.objectId,
          layerId: input.layerId,
          field,
          value,
        },
      );
    }
    if (value !== 0) {
      throw unsupportedNativePreviewObjectPosition(
        input,
        input.role === "group"
          ? `group-${field}`
          : `object-layer-${field}`,
        field,
        value,
      );
    }
  }
  for (const [field, fallback] of [
    ["offsetx", 0],
    ["offsety", 0],
    ["parallaxx", 1],
    ["parallaxy", 1],
  ] as const) {
    const value = input.layer[field] ?? fallback;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${input.context}.${field} must be a finite number.`,
        {
          path: input.context,
          objectId: input.objectId,
          layerId: input.layerId,
          field,
          value,
        },
      );
    }
    if (value !== fallback) {
      throw unsupportedNativePreviewObjectPosition(
        input,
        field,
        field,
        value,
      );
    }
  }
}

function unsupportedNativePreviewObjectPosition(
  input: {
    context: string;
    objectId: number;
    layerId: number;
    role: "group" | "object-layer";
  },
  feature: string,
  field: string,
  value: number,
): TiledMcpError {
  return new TiledMcpError(
    "UNSUPPORTED_RENDER_FEATURE",
    `Native object debug overlay does not support non-default ${input.role} ${field}.`,
    {
      path: input.context,
      objectId: input.objectId,
      layerId: input.layerId,
      feature,
      value,
    },
  );
}

export function assertBasicEditableObject(
  object: JsonObject,
  objectId: number,
  mapPath: string,
): BasicEditableObjectShape {
  const unsupportedKeys = [
    "template",
  ];
  const unsupported = unsupportedKeys.find((key) =>
    Object.prototype.hasOwnProperty.call(object, key),
  );
  if (unsupported !== undefined) {
    throw new TiledMcpError(
      "UNSUPPORTED_OBJECT_PROFILE",
      `Object ${objectId} uses ${unsupported}, which is outside bounded object editing.`,
      { path: mapPath, objectId, feature: unsupported },
    );
  }
  const shapeMarkers = [
    "point",
    "ellipse",
    "capsule",
    "polygon",
    "polyline",
    "text",
  ] as const;
  if (
    Object.prototype.hasOwnProperty.call(
      object,
      "gid",
    )
  ) {
    const conflicting = shapeMarkers.find(
      (marker) =>
        Object.prototype.hasOwnProperty.call(
          object,
          marker,
        ),
    );
    if (conflicting !== undefined) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `Object ${objectId} combines gid with the ${conflicting} shape marker.`,
        {
          path: mapPath,
          objectId,
          feature: conflicting,
        },
      );
    }
    assertStoredObjectNumber(
      object.x,
      `object ${objectId}.x`,
      mapPath,
      objectId,
    );
    assertStoredObjectNumber(
      object.y,
      `object ${objectId}.y`,
      mapPath,
      objectId,
    );
    return "tile";
  }
  const presentShapeMarkers =
    shapeMarkers.filter((marker) =>
      Object.prototype.hasOwnProperty.call(
        object,
        marker,
      ),
    );
  for (const marker of presentShapeMarkers) {
    if (marker === "text") {
      assertStoredTextObjectData(
        object.text,
        objectId,
        mapPath,
      );
    } else if (marker === "polygon" || marker === "polyline") {
      assertObjectPathPoints(
        object[marker],
        marker,
        `object ${objectId}.${marker}`,
        "INVALID_DOCUMENT",
      );
    } else if (object[marker] !== true) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `Object ${objectId}.${marker} must be true when present.`,
        { path: mapPath, objectId, feature: marker },
      );
    }
  }
  if (presentShapeMarkers.length > 1) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId} contains conflicting shape markers.`,
      {
        path: mapPath,
        objectId,
        shapeMarkers: presentShapeMarkers,
      },
    );
  }
  const shape =
    presentShapeMarkers[0] ?? "rectangle";
  assertStoredObjectNumber(
    object.x,
    `object ${objectId}.x`,
    mapPath,
    objectId,
  );
  assertStoredObjectNumber(
    object.y,
    `object ${objectId}.y`,
    mapPath,
    objectId,
  );
  if (shape === "polygon" || shape === "polyline") {
    for (const field of ["width", "height"] as const) {
      if (
        Object.prototype.hasOwnProperty.call(
          object,
          field,
        )
      ) {
        assertStoredPathDimension(
          object[field],
          `object ${objectId}.${field}`,
          mapPath,
          objectId,
        );
      }
    }
  } else {
    const dimensionsMayBeOmitted =
      shape === "ellipse" ||
      shape === "capsule" ||
      shape === "text";
    if (
      !dimensionsMayBeOmitted ||
      Object.prototype.hasOwnProperty.call(
        object,
        "width",
      )
    ) {
      assertStoredObjectSize(
        object.width,
        `object ${objectId}.width`,
        mapPath,
        objectId,
      );
    }
    if (
      !dimensionsMayBeOmitted ||
      Object.prototype.hasOwnProperty.call(
        object,
        "height",
      )
    ) {
      assertStoredObjectSize(
        object.height,
        `object ${objectId}.height`,
        mapPath,
        objectId,
      );
    }
  }
  if (object.rotation !== undefined) {
    assertStoredObjectNumber(
      object.rotation,
      `object ${objectId}.rotation`,
      mapPath,
      objectId,
    );
  }
  if (object.name !== undefined && typeof object.name !== "string") {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId}.name must be a string.`,
      { path: mapPath, objectId },
    );
  }
  if (object.type !== undefined && typeof object.type !== "string") {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId}.type must be a string.`,
      { path: mapPath, objectId },
    );
  }
  if (object.visible !== undefined && typeof object.visible !== "boolean") {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId}.visible must be a boolean.`,
      { path: mapPath, objectId },
    );
  }
  if (
    object.opacity !== undefined &&
    (typeof object.opacity !== "number" ||
      !Number.isFinite(object.opacity) ||
      object.opacity < 0 ||
      object.opacity > 1)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Object ${objectId}.opacity must be between 0 and 1.`,
      { path: mapPath, objectId },
    );
  }
  return shape;
}

export function summarizeObjectLocation(
  location: ObjectLocation,
): Record<string, unknown> {
  const objectId = expectInteger(
    location.object.id,
    `object layer ${location.layer.id} object id`,
  );
  const name = boundedDisplayString(location.object.name);
  const className = boundedDisplayString(location.object.type);
  const layerName = boundedDisplayString(location.layer.name);
  return {
    id: objectId,
    layerId: location.layer.id,
    layerName: layerName.value,
    ...(layerName.truncated ? { layerNameTruncated: true } : {}),
    name: name.value,
    ...(name.truncated ? { nameTruncated: true } : {}),
    className: className.value,
    ...(className.truncated ? { classNameTruncated: true } : {}),
    shape: objectShape(location.object),
    x: displayNumber(location.object.x, 0),
    y: displayNumber(location.object.y, 0),
    width: displayNumber(location.object.width, 0),
    height: displayNumber(location.object.height, 0),
    rotation: displayNumber(location.object.rotation, 0),
    visible: location.object.visible !== false,
    opacity:
      typeof location.object.opacity === "number" &&
      Number.isFinite(location.object.opacity)
        ? location.object.opacity
        : 1,
  };
}

export function describeEditableObject(
  location: ObjectLocation,
  shape: BasicEditableObjectShape,
  mapPath: string,
  orientation: MapOrientation,
  bindings: readonly TilesetBinding[],
): Record<string, unknown> {
  const objectId = expectInteger(
    location.object.id,
    `${mapPath} object id`,
  );
  const name = boundedDisplayString(location.object.name);
  const className = boundedDisplayString(location.object.type);
  const layerName = boundedDisplayString(location.layer.name);
  const properties = projectScalarProperties(
    location.object,
    `${mapPath} object ${objectId}.properties`,
    { path: mapPath, objectId },
  );
  const common = {
    id: objectId,
    layerId: location.layer.id,
    layerName: layerName.value,
    ...(layerName.truncated
      ? { layerNameTruncated: true }
      : {}),
    name: name.value,
    ...(name.truncated ? { nameTruncated: true } : {}),
    className: className.value,
    ...(className.truncated
      ? { classNameTruncated: true }
      : {}),
    shape,
    x: location.object.x as number,
    y: location.object.y as number,
    rotation: displayNumber(location.object.rotation, 0),
    visible: location.object.visible !== false,
    opacity:
      typeof location.object.opacity === "number"
        ? location.object.opacity
        : 1,
    properties: properties.entries,
    propertyCount: properties.total,
    ...(properties.truncated
      ? { propertiesTruncated: true }
      : {}),
  };

  if (
    shape === "rectangle" ||
    shape === "ellipse" ||
    shape === "capsule"
  ) {
    return {
      ...common,
      width: displayNumber(location.object.width, 0),
      height: displayNumber(location.object.height, 0),
    };
  }
  if (shape === "polygon" || shape === "polyline") {
    return {
      ...common,
      points: expectArray(
        location.object[shape],
        `object ${objectId}.${shape}`,
      ).map((value, pointIndex) => {
        const point = expectObject(
          value,
          `object ${objectId}.${shape}[${pointIndex}]`,
        );
        return {
          x: point.x as number,
          y: point.y as number,
        };
      }),
    };
  }
  if (shape === "text") {
    const text = assertStoredTextObjectData(
      location.object.text,
      objectId,
      mapPath,
    );
    return {
      ...common,
      width: displayNumber(location.object.width, 0),
      height: displayNumber(location.object.height, 0),
      ...text,
    };
  }
  if (shape === "tile") {
    const gid = expectInteger(
      location.object.gid,
      `object ${objectId}.gid`,
    );
    const tile = gidToTileRef(
      gid,
      orientation,
      bindings,
    );
    if (tile === null) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `Object ${objectId} carries an empty gid.`,
        { path: mapPath, objectId },
      );
    }
    return {
      ...common,
      width: displayNumber(location.object.width, 0),
      height: displayNumber(location.object.height, 0),
      tile,
    };
  }
  return common;
}

export function boundedDisplayString(value: JsonValue | undefined): {
  value: string;
  truncated: boolean;
} {
  if (typeof value !== "string") {
    return { value: "", truncated: false };
  }
  let displayEnd = 0;
  let codePointCount = 0;
  for (const codePoint of value) {
    codePointCount += 1;
    if (codePointCount > MAX_OBJECT_DISPLAY_STRING_LENGTH) {
      return {
        value: value.slice(0, displayEnd),
        truncated: true,
      };
    }
    displayEnd += codePoint.length;
  }
  return { value, truncated: false };
}

function displayNumber(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function objectShape(object: JsonObject): string {
  if (typeof object.template === "string") {
    return "template";
  }
  if (typeof object.gid === "number") {
    return "tile";
  }
  for (const shape of [
    "point",
    "ellipse",
    "capsule",
    "polygon",
    "polyline",
    "text",
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(object, shape)) {
      return shape;
    }
  }
  return "rectangle";
}

export function sourcePatchPathsForSummary(
  map: JsonObject,
  summary: MapEditPlan["summary"],
  mapPath: string,
): JsonSourcePath[] {
  const paths: JsonSourcePath[] = [];
  const chunkedIds = new Set(
    summary.chunkedTileLayerIds ?? [],
  );
  for (const layerId of summary.affectedTileLayerIds) {
    if (chunkedIds.has(layerId)) {
      continue;
    }
    paths.push([...findTileLayer(map, layerId, mapPath).path, "data"]);
  }
  for (const layerId of summary.affectedObjectLayerIds) {
    paths.push([...findObjectLayer(map, layerId, mapPath).path, "objects"]);
  }
  if (summary.createdObjectIds.length > 0) {
    paths.push(["nextobjectid"]);
  }
  if ((summary.addedTilesets?.length ?? 0) > 0) {
    paths.push(["tilesets"]);
  }
  if ((summary.createdLayers?.length ?? 0) > 0) {
    paths.push(["nextlayerid"]);
  }
  const duplicatedLayers = summary.duplicatedLayers ?? [];
  if (duplicatedLayers.length > 0) {
    paths.push(["nextlayerid"]);
    if (
      duplicatedLayers.some(
        (duplicated) =>
          duplicated.copiedObjectCount > 0,
      )
    ) {
      paths.push(["nextobjectid"]);
    }
  }
  for (const resize of summary.mapResizes ?? []) {
    const widthChanged =
      resize.newWidth !== resize.oldWidth;
    const heightChanged =
      resize.newHeight !== resize.oldHeight;
    if (widthChanged) {
      paths.push(["width"]);
    }
    if (heightChanged) {
      paths.push(["height"]);
    }
    if (!widthChanged && !heightChanged) {
      continue;
    }
    for (const layerId of resize.resizedTileLayerIds) {
      const layerPath = findTileLayer(
        map,
        layerId,
        mapPath,
      ).path;
      if (widthChanged) {
        paths.push([...layerPath, "width"]);
      }
      if (heightChanged) {
        paths.push([...layerPath, "height"]);
      }
    }
  }
  return paths;
}

export function sourceArrayInsertionsForSummary(
  map: JsonObject,
  summary: MapEditPlan["summary"],
  mapPath: string,
): JsonArrayInsertion[] {
  const createdLayers = summary.createdLayers ?? [];
  const duplicatedLayers =
    summary.duplicatedLayers ?? [];
  if (
    createdLayers.length + duplicatedLayers.length >
    1
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "A layer insertion change set may insert only one root element.",
    );
  }
  return [
    ...createdLayers.map((created) => ({
      path: layerContainerForParent(
        map,
        created.parentGroupId,
        mapPath,
      ).path,
      index: created.index,
    })),
    ...duplicatedLayers.map((duplicated) => ({
      path: layerContainerForParent(
        map,
        duplicated.targetParentGroupId,
        mapPath,
      ).path,
      index: duplicated.targetIndex,
    })),
  ];
}

export function sourceArrayDeletionsForSummary(
  map: JsonObject,
  summary: MapEditPlan["summary"],
  mapPath: string,
): JsonArrayDeletion[] {
  const deletedLayers = summary.deletedLayers ?? [];
  const removedTilesets =
    summary.removedTilesets ?? [];
  if (
    deletedLayers.length +
      removedTilesets.length >
    1
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "A change set may delete only one selected array element.",
    );
  }
  return [
    ...deletedLayers.map((deleted) => ({
      path: layerContainerForParent(
        map,
        deleted.parentGroupId,
        mapPath,
      ).path,
      index: deleted.index,
    })),
    ...removedTilesets.map((removed) => ({
      path: ["tilesets"],
      index: removed.index,
    })),
  ];
}

export function sourceArrayMovesForSummary(
  sourceMap: JsonObject,
  summary: MapEditPlan["summary"],
  mapPath: string,
): JsonArrayMove[] {
  const movedLayers = summary.movedLayers ?? [];
  if (movedLayers.length > 1) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "A layer-move change set may move only one selected layer subtree.",
    );
  }
  return movedLayers
    .filter((move) => move.wouldChange)
    .map((move) => ({
      sourcePath: layerContainerForParent(
        sourceMap,
        move.sourceParentGroupId,
        mapPath,
      ).path,
      sourceIndex: move.sourceIndex,
      targetPath: layerContainerForParent(
        sourceMap,
        move.targetParentGroupId,
        mapPath,
      ).path,
      targetIndex: move.targetIndex,
    }));
}

export function sourceObjectMemberPatchesForSummary(
  map: JsonObject,
  summary: MapEditPlan["summary"],
  mapPath: string,
): JsonObjectMemberPatch[] {
  const patches: JsonObjectMemberPatch[] = [];
  const seen = new Set<string>();
  for (const transcode of summary.transcodes ?? []) {
    if (!transcode.wouldChange) {
      continue;
    }
    const layerPath = findTileLayer(
      map,
      transcode.layerId,
      mapPath,
      "edit",
      true,
    ).path;
    patches.push({
      path: layerPath,
      key: "encoding",
    });
    patches.push({
      path: layerPath,
      key: "compression",
    });
  }
  for (const layerId of summary.chunkedTileLayerIds ?? []) {
    const layerPath = findTileLayer(
      map,
      layerId,
      mapPath,
      "edit",
      true,
    ).path;
    for (const key of [
      "chunks",
      "width",
      "height",
      "startx",
      "starty",
    ]) {
      patches.push({ path: layerPath, key });
    }
  }
  for (const update of summary.mapUpdates ?? []) {
    for (const field of update.changedFields) {
      if (!isMapPatchField(field)) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          `Map update summary contains unsupported field ${field}.`,
          {
            path: mapPath,
            field,
          },
        );
      }
      const patch = {
        path: [] as JsonSourcePath,
        key: mapPatchJsonKey(field),
      };
      const identity = JSON.stringify([
        ...patch.path,
        patch.key,
      ]);
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      patches.push(patch);
    }
  }
  for (const update of summary.layerUpdates ?? []) {
    if (update.changedFields.length === 0) {
      continue;
    }
    const layer = findEditableLayer(
      map,
      update.layerId,
      mapPath,
    );
    for (const field of update.changedFields) {
      if (!isLayerPatchField(field)) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          `Layer update summary contains unsupported field ${field}.`,
          {
            path: mapPath,
            layerId: update.layerId,
            field,
          },
        );
      }
      const patch = {
        path: layer.path,
        key: layerPatchJsonKey(field),
      };
      const identity = JSON.stringify([
        ...patch.path,
        patch.key,
      ]);
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      patches.push(patch);
    }
  }
  for (const resize of summary.mapResizes ?? []) {
    for (const layerId of resize.shiftedImageLayerIds) {
      const layer = findEditableLayer(
        map,
        layerId,
        mapPath,
      );
      for (const [key, delta] of [
        ["offsetx", resize.pixelOffsetX],
        ["offsety", resize.pixelOffsetY],
      ] as const) {
        if (delta === 0) {
          continue;
        }
        const patch = {
          path: layer.path,
          key,
        };
        const identity = JSON.stringify([
          ...patch.path,
          patch.key,
        ]);
        if (seen.has(identity)) {
          continue;
        }
        seen.add(identity);
        patches.push(patch);
      }
    }
  }
  return patches;
}

function isMapPatchField(
  value: string,
): value is MapPatchField {
  return (MAP_PATCH_FIELDS as readonly string[]).includes(
    value,
  );
}

function isLayerPatchField(
  value: string,
): value is LayerPatchField {
  return (LAYER_PATCH_FIELDS as readonly string[]).includes(
    value,
  );
}

function findLayerRecursive(
  layers: JsonValue[],
  layerId: number,
  context: string,
  path: JsonSourcePath,
  depth = 0,
  budget: LayerTraversalBudget = { count: 0 },
  ancestors: readonly JsonObject[] = [],
): {
  object: JsonObject;
  path: JsonSourcePath;
  ancestors: readonly JsonObject[];
} | undefined {
  assertLayerTraversalBudget(layers.length, depth, budget);
  for (const [index, value] of layers.entries()) {
    const layer = expectObject(value, `${context}[${index}]`);
    if (layer.id === layerId) {
      return {
        object: layer,
        path: [...path, index],
        ancestors,
      };
    }
    if (layer.type === "group" && Array.isArray(layer.layers)) {
      const nested = findLayerRecursive(
        layer.layers,
        layerId,
        `${context}[${index}].layers`,
        [...path, index, "layers"],
        depth + 1,
        budget,
        [...ancestors, layer],
      );
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

export function collectSceneCollectionIds(
  scene: PreviewScene,
  binding: TilesetBinding,
  orientation: MapOrientation,
): number[] {
  const ids = new Set<number>();
  const lastGid =
    binding.firstGid + binding.gidSpan - 1;
  const record = (baseGid: number): void => {
    if (
      baseGid < binding.firstGid ||
      baseGid > lastGid
    ) {
      return;
    }
    const localId = baseGid - binding.firstGid;
    if (binding.localIds?.has(localId) !== true) {
      throw new TiledMcpError(
        "GID_OUT_OF_RANGE",
        `GID ${baseGid} points at a removed image-collection tile.`,
        {
          gid: baseGid,
          assetId: binding.assetId,
          localId,
        },
      );
    }
    ids.add(localId);
  };
  const region = scene.region;
  for (const layer of scene.layers) {
    const minX = Math.max(region.x, layer.x);
    const minY = Math.max(region.y, layer.y);
    const maxX = Math.min(
      region.x + region.width,
      layer.x + layer.width,
    );
    const maxY = Math.min(
      region.y + region.height,
      layer.y + layer.height,
    );
    for (let y = minY; y < maxY; y += 1) {
      for (let x = minX; x < maxX; x += 1) {
        const gid =
          layer.data[
            (y - layer.y) * layer.width +
              (x - layer.x)
          ];
        if (
          typeof gid !== "number" ||
          gid === 0
        ) {
          continue;
        }
        record(
          decodeGid(gid, orientation).baseGid,
        );
      }
    }
  }
  for (const objectLayer of scene.objectLayers) {
    for (const object of objectLayer.objects) {
      if (
        object.tileRender?.assetId ===
        binding.assetId
      ) {
        record(
          binding.firstGid +
            object.tileRender.localId,
        );
      }
    }
  }
  return [...ids].sort(
    (left, right) => left - right,
  );
}

/**
 * Sparse-id profile of a collection binding, or undefined for atlases.
 */
export function collectionProfileOf(binding: {
  collection?: true;
  localIds?: ReadonlySet<number>;
  gidSpan: number;
}):
  | { localIds: ReadonlySet<number>; idSpan: number }
  | undefined {
  if (
    binding.collection !== true ||
    binding.localIds === undefined
  ) {
    return undefined;
  }
  return {
    localIds: binding.localIds,
    idSpan: binding.gidSpan,
  };
}

/**
 * Union of the stored chunk rectangles: the flood-fill bounds of an
 * infinite layer, matching Tiled 1.12.2's used-chunk bounds. Returns
 * null for a layer with no chunks.
 */
export function collectLayerSummaries(
  layers: JsonValue[],
  context: string,
  infinite = false,
  depth = 0,
  budget: LayerTraversalBudget = { count: 0 },
): Array<Record<string, unknown>> {
  assertLayerTraversalBudget(layers.length, depth, budget);
  return layers.map((value, index) => {
    const layer = expectObject(value, `${context}[${index}]`);
    const displayName = boundedDisplayString(layer.name);
    const layerType = expectString(
      layer.type,
      `${context}[${index}].type`,
    );
    if (
      layerType !== "tilelayer" &&
      layerType !== "objectgroup" &&
      layerType !== "imagelayer" &&
      layerType !== "group"
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}[${index}].type is not a supported Tiled layer type.`,
        {
          layerType,
        },
      );
    }
    const summary: Record<string, unknown> = {
      id: expectInteger(layer.id, `${context}[${index}].id`),
      name: displayName.value,
      ...(displayName.truncated ? { nameTruncated: true } : {}),
      type: layerType,
      visible: layer.visible !== false,
      opacity: typeof layer.opacity === "number" ? layer.opacity : 1,
    };
    if (layerType === "tilelayer") {
      const chunked =
        infinite && "chunks" in layer;
      const width = expectInteger(
        layer.width,
        `${context}[${index}].width`,
      );
      const height = expectInteger(
        layer.height,
        `${context}[${index}].height`,
      );
      // Chunked bounds may legitimately be 0 × 0 for an empty layer.
      if (
        (chunked && (width < 0 || height < 0)) ||
        (!chunked && (width <= 0 || height <= 0))
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${context}[${index}] tile layer dimensions must be positive integers.`,
          {
            width,
            height,
          },
        );
      }
      summary.width = width;
      summary.height = height;
      if (chunked) {
        summary.startX = expectInteger(
          layer.startx ?? 0,
          `${context}[${index}].startx`,
        );
        summary.startY = expectInteger(
          layer.starty ?? 0,
          `${context}[${index}].starty`,
        );
        summary.chunked = true;
      }
      summary.x = expectInteger(
        layer.x ?? 0,
        `${context}[${index}].x`,
      );
      summary.y = expectInteger(
        layer.y ?? 0,
        `${context}[${index}].y`,
      );
    }
    if (layerType === "imagelayer") {
      // The image an image layer points at is the whole reason it exists --
      // it is the reference someone traces over. Reporting the layer without
      // it left a caller able to see that a "Reference" layer was there but
      // not what it referenced, and no other read exposed it either.
      //
      // Path only, deliberately. A revision would have to be hashed from the
      // file, and image-layer images are not part of the map's dependency
      // set, so pinning one here would put fresh I/O on every summary read
      // and imply a guarantee the rest of the pipeline does not make.
      // `repeatX`/`repeatY` travel with it because they change what the
      // reference looks like when it is drawn.
      if (typeof layer.image === "string") {
        summary.image = { path: layer.image };
      }
      if (layer.repeatx === true) {
        summary.repeatX = true;
      }
      if (layer.repeaty === true) {
        summary.repeatY = true;
      }
      summary.x = expectInteger(
        layer.x ?? 0,
        `${context}[${index}].x`,
      );
      summary.y = expectInteger(
        layer.y ?? 0,
        `${context}[${index}].y`,
      );
    }
    if (layerType === "group") {
      summary.layers = collectLayerSummaries(
        expectArray(
          layer.layers,
          `${context}[${index}].layers`,
        ),
        `${context}[${index}].layers`,
        infinite,
        depth + 1,
        budget,
      );
    }
    return summary;
  });
}

export function planId(value: Omit<MapEditPlan, "id">): string {
  const canonical = stableJson(value as unknown as JsonValue);
  return `changeset:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function assertPlanShape(plan: MapEditPlan): void {
  if (
    !isRecordValue(plan) ||
    plan.kind !== "mapEdit" ||
    plan.version !== 1 ||
    typeof plan.id !== "string" ||
    typeof plan.mapPath !== "string" ||
    typeof plan.baseRevision !== "string" ||
    !isRecordValue(plan.dependencyRevisions) ||
    !Array.isArray(plan.operations) ||
    !isRecordValue(plan.summary)
  ) {
    throw new TiledMcpError("INVALID_CHANGE_SET", "The supplied change set is malformed.");
  }
  try {
    assertDependencyRevisionRecord(plan.dependencyRevisions);
    if (plan.prospectiveDependencyRevisions !== undefined) {
      assertDependencyRevisionRecord(plan.prospectiveDependencyRevisions);
    }
  } catch {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The change set contains malformed dependency revisions.",
    );
  }
}

export function assertDependencyRevisions(
  expected: Record<string, string>,
  actual: Record<string, string>,
): void {
  assertDependencyRevisionRecord(expected);
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some(
      (key, index) => key !== actualKeys[index] || expected[key] !== actual[key],
    )
  ) {
    throw new TiledMcpError(
      "DEPENDENCY_REVISION_CONFLICT",
      "A referenced tileset changed after this change set was planned.",
      {
        expectedCount: expectedKeys.length,
        actualCount: actualKeys.length,
        differences: dependencyDifferenceSample(expected, actual),
      },
    );
  }
}

export function assertRootAtlasTileDefinitions(
  document: JsonObject,
  path: string,
  tileCount: number,
): void {
  if (document.tiles === undefined) {
    return;
  }
  const entries = expectArray(
    document.tiles,
    `${path}.tiles`,
  );
  const seenLocalIds = new Set<number>();
  for (const [index, value] of entries.entries()) {
    const tile = expectObject(
      value,
      `${path}.tiles[${index}]`,
    );
    const localId = expectInteger(
      tile.id,
      `${path}.tiles[${index}].id`,
    );
    if (localId < 0 || localId >= tileCount) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${path}.tiles[${index}].id is outside the tileset local ID range.`,
        {
          path,
          sourceIndex: index,
          localId,
          tileCount,
        },
      );
    }
    if (seenLocalIds.has(localId)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${path} contains duplicate tile metadata for local ID ${localId}.`,
        { path, localId },
      );
    }
    seenLocalIds.add(localId);
    assertAtlasTileDefinition(
      tile,
      path,
      localId,
    );
  }
}

export function assertSelectedLocalIds(
  localIds: readonly number[],
  tileCount: number,
  path: string,
): void {
  if (
    !Array.isArray(localIds) ||
    localIds.length < 1 ||
    localIds.length > MAX_TILE_RENDER_LOCAL_IDS
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `localIds must contain between 1 and ${MAX_TILE_RENDER_LOCAL_IDS} entries.`,
      {
        actual: Array.isArray(localIds)
          ? localIds.length
          : null,
        limit: MAX_TILE_RENDER_LOCAL_IDS,
      },
    );
  }
  const seen = new Set<number>();
  for (const [index, localId] of localIds.entries()) {
    if (!Number.isSafeInteger(localId)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `localIds[${index}] must be a safe integer.`,
        { index, localId },
      );
    }
    if (localId < 0 || localId >= tileCount) {
      throw new TiledMcpError(
        "TILE_ID_OUT_OF_RANGE",
        `Tile ${localId} is outside ${path}.`,
        {
          path,
          index,
          localId,
          tileCount,
        },
      );
    }
    if (seen.has(localId)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `localIds contains duplicate tile ID ${localId}.`,
        { index, localId },
      );
    }
    seen.add(localId);
  }
}

export function assertOptionalRevision(
  revision: string | undefined,
  context: string,
): void {
  if (revision !== undefined && !REVISION_PATTERN.test(revision)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be a SHA-256 revision returned by TiledMCP.`,
      { context },
    );
  }
}

export function assertRequiredRevision(
  revision: string,
  context: string,
): void {
  if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be a SHA-256 revision returned by TiledMCP.`,
      { context },
    );
  }
}

/**
 * Re-read a document's revision and fail if it moved since it was pinned.
 *
 * `activity` completes the sentence "<path> changed while ..." and is required
 * so each caller reports what it was doing; the guard itself -- the re-read,
 * the comparison and the error shape -- lives here rather than at every site.
 */
export async function assertRevisionUnchanged(
  store: DocumentStore,
  path: string,
  expectedRevision: string,
  errorCode: "REVISION_CONFLICT" | "DEPENDENCY_REVISION_CONFLICT",
  activity: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const actualRevision = await store.readRevision(path);
  if (actualRevision !== expectedRevision) {
    throw new TiledMcpError(
      errorCode,
      `${path} changed while ${activity}.`,
      {
        path,
        ...details,
        expectedRevision,
        actualRevision,
      },
    );
  }
}

export function assertDependencyRevisionRecord(
  revisions: Record<string, string>,
): void {
  if (!isRecordValue(revisions)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "expectedDependencyRevisions must be an object.",
    );
  }
  const entries = Object.entries(revisions);
  if (entries.length > MAX_TILESET_COUNT) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `At most ${MAX_TILESET_COUNT} dependency revisions may be supplied.`,
      { limit: MAX_TILESET_COUNT, actual: entries.length },
    );
  }
  for (const [index, [assetId, revision]] of entries.entries()) {
    if (
      assetId.length === 0 ||
      assetId.length > 128 ||
      typeof revision !== "string" ||
      !REVISION_PATTERN.test(revision)
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `Dependency revision entry ${index} is malformed.`,
        { index, assetIdLength: assetId.length },
      );
    }
  }
}

function dependencyDifferenceSample(
  expected: Record<string, string>,
  actual: Record<string, string>,
): Array<{
  assetId: string;
  expectedRevision: string | null;
  actualRevision: string | null;
}> {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const differences: Array<{
    assetId: string;
    expectedRevision: string | null;
    actualRevision: string | null;
  }> = [];
  for (const assetId of [...keys].sort()) {
    if (expected[assetId] === actual[assetId]) {
      continue;
    }
    differences.push({
      assetId,
      expectedRevision: expected[assetId] ?? null,
      actualRevision: actual[assetId] ?? null,
    });
    if (differences.length === 32) {
      break;
    }
  }
  return differences;
}

interface UsageTileCounter {
  assetId: string;
  localId: number;
  bindingIndex: number;
  cellReferences: number;
  objectReferences: number;
  transformedReferences: number;
}

interface UsageTilesetCounter {
  binding: TilesetBinding;
  bindingIndex: number;
  tiles: Map<number, UsageTileCounter>;
  cellReferences: number;
  objectReferences: number;
  transformedReferences: number;
}

export function analyzeUsageDocument(input: {
  map: JsonObject;
  mapPath: string;
  bindings: readonly TilesetBinding[];
  topTileLimit: number;
  infinite: boolean;
}): Record<string, unknown> {
  const counters = input.bindings.map(
    (binding, bindingIndex): UsageTilesetCounter => ({
      binding,
      bindingIndex,
      tiles: new Map<number, UsageTileCounter>(),
      cellReferences: 0,
      objectReferences: 0,
      transformedReferences: 0,
    }),
  );
  const counterByAssetId = new Map(
    counters.map((counter) => [
      counter.binding.assetId,
      counter,
    ]),
  );
  let uniqueTileCount = 0;
  let nonEmptyCellCount = 0;
  let tileObjectCount = 0;
  let identityReferenceCount = 0;
  let transformedReferenceCount = 0;
  let tileCellCount = 0;
  let objectCount = 0;
  let tileLayerCount = 0;
  let objectLayerCount = 0;
  let imageLayerCount = 0;
  let groupLayerCount = 0;
  const rawFlagCounts = new Map<number, number>();
  const layerDensities: Array<{
    layerId: number;
    name: string;
    nameTruncated: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    cellCount: number;
    nonEmptyCellCount: number;
  }> = [];

  const recordGid = (
    value: unknown,
    source: "cell" | "object",
    context: string,
  ): boolean => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 0xffffffff
    ) {
      throw new TiledMcpError(
        "INVALID_TILE_DATA",
        `${context} must be an unsigned 32-bit GID.`,
        { context },
      );
    }
    const tile = gidToTileRef(
      value,
      "orthogonal",
      input.bindings,
    );
    if (tile === null) {
      return false;
    }
    if (tile.tileset.kind !== "external") {
      throw new TiledMcpError(
        "INTERNAL_ERROR",
        "Usage analysis only references external tilesets.",
        { context },
      );
    }
    const counter = counterByAssetId.get(
      tile.tileset.assetId,
    );
    if (counter === undefined) {
      throw new TiledMcpError(
        "GID_OUT_OF_RANGE",
        `${context} resolved to an unknown tileset binding.`,
        { context, tilesetAssetId: tile.tileset.assetId },
      );
    }
    let usage = counter.tiles.get(tile.localId);
    if (usage === undefined) {
      uniqueTileCount += 1;
      if (uniqueTileCount > MAX_USAGE_DISTINCT_TILES) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `Usage analysis may aggregate at most ${MAX_USAGE_DISTINCT_TILES} distinct tiles.`,
          {
            path: input.mapPath,
            limit: MAX_USAGE_DISTINCT_TILES,
            actual: uniqueTileCount,
          },
        );
      }
      usage = {
        assetId: tile.tileset.assetId,
        localId: tile.localId,
        bindingIndex: counter.bindingIndex,
        cellReferences: 0,
        objectReferences: 0,
        transformedReferences: 0,
      };
      counter.tiles.set(tile.localId, usage);
    }
    if (source === "cell") {
      usage.cellReferences += 1;
      counter.cellReferences += 1;
    } else {
      usage.objectReferences += 1;
      counter.objectReferences += 1;
    }
    const rawFlags = tile.transform?.rawFlags ?? 0;
    rawFlagCounts.set(
      rawFlags,
      (rawFlagCounts.get(rawFlags) ?? 0) + 1,
    );
    const transformed = rawFlags !== 0;
    if (transformed) {
      usage.transformedReferences += 1;
      counter.transformedReferences += 1;
      transformedReferenceCount += 1;
    } else {
      identityReferenceCount += 1;
    }
    return true;
  };

  const scan = { entries: 0 };
  const traversalBudget: LayerTraversalBudget = { count: 0 };
  const visitLayers = (
    layers: JsonValue[],
    context: string,
    depth: number,
  ): void => {
    assertLayerTraversalBudget(
      layers.length,
      depth,
      traversalBudget,
    );
    for (const [layerIndex, layerValue] of layers.entries()) {
      const layerContext = `${context}[${layerIndex}]`;
      const layer = expectObject(layerValue, layerContext);
      const layerId = expectInteger(
        layer.id,
        `${layerContext}.id`,
      );
      const layerType = expectString(
        layer.type,
        `${layerContext}.type`,
      );
      if (layerType === "group") {
        groupLayerCount += 1;
        visitLayers(
          expectArray(
            layer.layers,
            `${layerContext}.layers`,
          ),
          `${layerContext}.layers`,
          depth + 1,
        );
        continue;
      }
      if (layerType === "imagelayer") {
        imageLayerCount += 1;
        continue;
      }
      if (layerType === "objectgroup") {
        objectLayerCount += 1;
        const objects = expectArray(
          layer.objects,
          `${layerContext}.objects`,
        );
        consumeUsageScanBudget(
          objects.length,
          scan,
          input.mapPath,
        );
        objectCount += objects.length;
        for (const [objectIndex, objectValue] of objects.entries()) {
          const object = expectObject(
            objectValue,
            `${layerContext}.objects[${objectIndex}]`,
          );
          if (object.gid === undefined) {
            continue;
          }
          if (
            recordGid(
              object.gid,
              "object",
              `${layerContext}.objects[${objectIndex}].gid`,
            )
          ) {
            tileObjectCount += 1;
          }
        }
        continue;
      }
      if (layerType !== "tilelayer") {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${layerContext}.type is not a supported Tiled layer type.`,
          { path: input.mapPath, layerId, layerType },
        );
      }

      tileLayerCount += 1;
      if (input.infinite && "chunks" in layer) {
        const structure =
          readChunkedTileLayerStructure(
            layer,
            layerId,
            input.mapPath,
          );
        consumeUsageScanBudget(
          structure.totalChunkCells,
          scan,
          input.mapPath,
        );
        tileCellCount +=
          structure.totalChunkCells;
        let layerNonEmptyCellCount = 0;
        for (const [
          chunkIndex,
          chunk,
        ] of structure.chunks.entries()) {
          const cells = decodeChunkCells(
            chunk,
            layer,
            layerId,
            input.mapPath,
          );
          for (const [
            gidIndex,
            gid,
          ] of cells.entries()) {
            if (
              recordGid(
                gid,
                "cell",
                `${layerContext}.chunks[${chunkIndex}].data[${gidIndex}]`,
              )
            ) {
              nonEmptyCellCount += 1;
              layerNonEmptyCellCount += 1;
            }
          }
        }
        const name = boundedDisplayString(
          layer.name,
        );
        layerDensities.push({
          layerId,
          name: name.value,
          nameTruncated: name.truncated,
          x: structure.startX,
          y: structure.startY,
          width: structure.width,
          height: structure.height,
          cellCount: structure.totalChunkCells,
          nonEmptyCellCount:
            layerNonEmptyCellCount,
        });
        continue;
      }
      const width = expectInteger(
        layer.width,
        `${layerContext}.width`,
      );
      const height = expectInteger(
        layer.height,
        `${layerContext}.height`,
      );
      assertPositiveInteger(width, `${layerContext}.width`);
      assertPositiveInteger(height, `${layerContext}.height`);
      const x = readOptionalInteger(
        layer.x,
        `${layerContext}.x`,
        0,
      );
      const y = readOptionalInteger(
        layer.y,
        `${layerContext}.y`,
        0,
      );
      const cellCount = width * height;
      if (!Number.isSafeInteger(cellCount)) {
        throw new TiledMcpError(
          "INVALID_TILE_DATA",
          `Layer ${layerId} dimensions overflow the cell count.`,
          { layerId },
        );
      }
      const data = resolveTileLayerCells(
        layer,
        layerId,
        input.mapPath,
        cellCount,
        "read",
        "Usage analysis supports only finite JSON tile layers with numeric data arrays.",
      );
      if (data.length !== cellCount) {
        throw new TiledMcpError(
          "INVALID_TILE_DATA",
          `Layer ${layerId} data length does not match width × height.`,
          {
            layerId,
            expected: cellCount,
            actual: data.length,
          },
        );
      }
      consumeUsageScanBudget(
        data.length,
        scan,
        input.mapPath,
      );
      tileCellCount += data.length;
      let layerNonEmptyCellCount = 0;
      for (const [gidIndex, gid] of data.entries()) {
        if (
          recordGid(
            gid,
            "cell",
            `${layerContext}.data[${gidIndex}]`,
          )
        ) {
          nonEmptyCellCount += 1;
          layerNonEmptyCellCount += 1;
        }
      }
      const name = boundedDisplayString(layer.name);
      layerDensities.push({
        layerId,
        name: name.value,
        nameTruncated: name.truncated,
        x,
        y,
        width,
        height,
        cellCount,
        nonEmptyCellCount: layerNonEmptyCellCount,
      });
    }
  };

  visitLayers(
    expectArray(input.map.layers, `${input.mapPath}.layers`),
    `${input.mapPath}.layers`,
    0,
  );

  const allTileCounters = counters.flatMap((counter) =>
    [...counter.tiles.values()],
  );
  allTileCounters.sort(compareUsageTileCounters);
  const topTileItems = allTileCounters
    .slice(0, input.topTileLimit)
    .map(usageTileCounterResult);

  const usedCounters = counters.filter(
    (counter) =>
      counter.cellReferences + counter.objectReferences > 0,
  );
  const unusedCounters = counters.filter(
    (counter) =>
      counter.cellReferences + counter.objectReferences === 0,
  );
  const sortedTilesetCounters = [...counters].sort(
    (left, right) => {
      const leftUsed =
        left.cellReferences + left.objectReferences > 0;
      const rightUsed =
        right.cellReferences + right.objectReferences > 0;
      return (
        Number(leftUsed) - Number(rightUsed) ||
        left.binding.firstGid - right.binding.firstGid
      );
    },
  );
  const tilesetItems = sortedTilesetCounters
    .slice(0, MAX_USAGE_TILESET_SUMMARIES)
    .map((counter) =>
      usageTilesetCounterResult(
        counter,
        MAX_USAGE_UNUSED_LOCAL_ID_SAMPLE,
      ),
    );
  layerDensities.sort(
    (left, right) =>
      left.nonEmptyCellCount * right.cellCount -
        right.nonEmptyCellCount * left.cellCount ||
      left.layerId - right.layerId,
  );
  const layerDensityItems = layerDensities
    .slice(0, MAX_USAGE_LAYER_SUMMARIES)
    .map((layer) => ({
      layerId: layer.layerId,
      name: layer.name,
      ...(layer.nameTruncated
        ? { nameTruncated: true }
        : {}),
      bounds: {
        x: layer.x,
        y: layer.y,
        width: layer.width,
        height: layer.height,
      },
      cellCount: layer.cellCount,
      emptyCellCount:
        layer.cellCount - layer.nonEmptyCellCount,
      nonEmptyCellCount: layer.nonEmptyCellCount,
      density:
        layer.nonEmptyCellCount / layer.cellCount,
    }));
  const rawFlagUsage = [...rawFlagCounts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([rawFlags, referenceCount]) => ({
      rawFlags,
      referenceCount,
    }));

  return {
    scope: {
      tileLayers: "all-recursive",
      tileObjects: "all-recursive",
      visibility: "ignored",
      tileIdentity: "external-asset-id-plus-local-id",
      transformAggregation: "base-tile",
      unusedLocalIdDomain:
        "atlas-local-ids-zero-to-tilecount-exclusive",
    },
    scan: {
      tileCellCount,
      objectCount,
      valueCount: scan.entries,
      limit: MAX_USAGE_SCAN_VALUES,
    },
    totals: {
      tileLayerCount,
      objectLayerCount,
      imageLayerCount,
      groupLayerCount,
      emptyTileCellCount:
        tileCellCount - nonEmptyCellCount,
      nonEmptyTileCellCount: nonEmptyCellCount,
      tileObjectCount,
      referenceCount:
        nonEmptyCellCount + tileObjectCount,
      distinctUsedTileCount: uniqueTileCount,
      usedTilesetCount: usedCounters.length,
      unusedTilesetCount: unusedCounters.length,
    },
    transforms: {
      identityReferenceCount,
      transformedReferenceCount,
      rawFlagUsage,
    },
    layerDensity: {
      total: layerDensities.length,
      returned: layerDensityItems.length,
      omitted:
        layerDensities.length - layerDensityItems.length,
      truncated:
        layerDensities.length > layerDensityItems.length,
      order: "density-asc-then-layer-id",
      items: layerDensityItems,
    },
    tilesets: {
      total: counters.length,
      returned: tilesetItems.length,
      omitted: counters.length - tilesetItems.length,
      truncated: counters.length > tilesetItems.length,
      order: "unused-first-then-firstgid",
      items: tilesetItems,
    },
    topTiles: {
      limit: input.topTileLimit,
      returned: topTileItems.length,
      distinctUsedTileCount: uniqueTileCount,
      truncated:
        uniqueTileCount > topTileItems.length,
      order:
        "reference-count-desc-then-firstgid-localid",
      items: topTileItems,
    },
  };
}

function consumeUsageScanBudget(
  count: number,
  budget: { entries: number },
  mapPath: string,
): void {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    budget.entries + count > MAX_USAGE_SCAN_VALUES
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Usage analysis may scan at most ${MAX_USAGE_SCAN_VALUES} tile cells and objects.`,
      {
        path: mapPath,
        limit: MAX_USAGE_SCAN_VALUES,
        scanned: budget.entries,
        nextCount: count,
      },
    );
  }
  budget.entries += count;
}

function compareUsageTileCounters(
  left: UsageTileCounter,
  right: UsageTileCounter,
): number {
  const leftTotal =
    left.cellReferences + left.objectReferences;
  const rightTotal =
    right.cellReferences + right.objectReferences;
  return (
    rightTotal - leftTotal ||
    left.bindingIndex - right.bindingIndex ||
    left.localId - right.localId
  );
}

function usageTileCounterResult(
  usage: UsageTileCounter,
): Record<string, unknown> {
  return {
    tile: {
      tileset: {
        kind: "external",
        assetId: usage.assetId,
      },
      localId: usage.localId,
    },
    references: {
      total:
        usage.cellReferences + usage.objectReferences,
      tileCells: usage.cellReferences,
      tileObjects: usage.objectReferences,
      transformed: usage.transformedReferences,
    },
  };
}

function usageTilesetCounterResult(
  counter: UsageTilesetCounter,
  unusedLocalIdLimit: number,
): Record<string, unknown> {
  const totalReferences =
    counter.cellReferences + counter.objectReferences;
  const unusedLocalIdSample: number[] = [];
  for (
    let localId = 0;
    localId < counter.binding.tileCount &&
    unusedLocalIdSample.length < unusedLocalIdLimit;
    localId += 1
  ) {
    if (!counter.tiles.has(localId)) {
      unusedLocalIdSample.push(localId);
    }
  }
  const unusedLocalIdCount =
    counter.binding.tileCount - counter.tiles.size;
  return {
    assetId: counter.binding.assetId,
    name: counter.binding.name,
    ...(counter.binding.nameTruncated
      ? { nameTruncated: true }
      : {}),
    firstGid: counter.binding.firstGid,
    tileCount: counter.binding.tileCount,
    gidSpan: counter.binding.gidSpan,
    unused: totalReferences === 0,
    referenceCount: totalReferences,
    tileCellReferenceCount: counter.cellReferences,
    tileObjectReferenceCount: counter.objectReferences,
    transformedReferenceCount:
      counter.transformedReferences,
    usedLocalIdCount: counter.tiles.size,
    unusedLocalIds: {
      count: unusedLocalIdCount,
      sample: unusedLocalIdSample,
      truncated:
        unusedLocalIdCount > unusedLocalIdSample.length,
    },
  };
}

export function readUsageLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  context: string,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) ||
    selected <= 0 ||
    selected > maximum
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be an integer between 1 and ${maximum}.`,
      { context, maximum },
    );
  }
  return selected;
}

export function assertUsageAnalysisResultSize(
  result: Record<string, unknown>,
): void {
  const byteLength = Buffer.byteLength(
    JSON.stringify(result),
    "utf8",
  );
  if (byteLength > MAX_USAGE_RESULT_BYTES) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Usage analysis results may contain at most ${MAX_USAGE_RESULT_BYTES} serialized bytes.`,
      {
        limit: MAX_USAGE_RESULT_BYTES,
        actual: byteLength,
      },
    );
  }
}

export function validateLayers(
  layers: JsonValue[],
  diagnostics: Diagnostic[],
  seenIds: Set<number>,
  seenObjectIds: Set<number>,
  pointer: string,
  mapWidth: number,
  mapHeight: number,
  depth = 0,
  budget: LayerTraversalBudget = { count: 0 },
  objectBudget: { count: number } = { count: 0 },
): void {
  if (diagnostics.length >= MAX_DIAGNOSTICS) {
    return;
  }
  if (depth > MAX_LAYER_DEPTH || budget.count + layers.length > MAX_LAYER_COUNT) {
    diagnostics.push(
      errorDiagnostic(
        "LAYER_LIMIT_EXCEEDED",
        `Layer tree exceeds depth ${MAX_LAYER_DEPTH} or count ${MAX_LAYER_COUNT}.`,
        pointer,
      ),
    );
    return;
  }
  budget.count += layers.length;
  for (const [index, value] of layers.entries()) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      return;
    }
    const layerPointer = `${pointer}/${index}`;
    if (!isJsonObject(value)) {
      diagnostics.push(errorDiagnostic("LAYER_INVALID", "Layer must be an object.", layerPointer));
      continue;
    }
    if (
      typeof value.id !== "number" ||
      !Number.isSafeInteger(value.id) ||
      value.id <= 0
    ) {
      diagnostics.push(
        errorDiagnostic(
          "LAYER_ID_INVALID",
          "Layer id must be a positive integer.",
          `${layerPointer}/id`,
        ),
      );
    } else if (seenIds.has(value.id)) {
      diagnostics.push(
        errorDiagnostic("LAYER_ID_DUPLICATE", `Duplicate layer id ${value.id}.`, `${layerPointer}/id`),
      );
    } else {
      seenIds.add(value.id);
    }
    if (value.type === "group") {
      if (!Array.isArray(value.layers)) {
        diagnostics.push(
          errorDiagnostic(
            "GROUP_LAYERS_INVALID",
            "Group layer layers must be an array.",
            `${layerPointer}/layers`,
          ),
        );
        continue;
      }
      validateLayers(
        value.layers,
        diagnostics,
        seenIds,
        seenObjectIds,
        `${layerPointer}/layers`,
        mapWidth,
        mapHeight,
        depth + 1,
        budget,
        objectBudget,
      );
      continue;
    }
    if (value.type === "objectgroup") {
      if (!Array.isArray(value.objects)) {
        diagnostics.push(
          errorDiagnostic(
            "OBJECTS_INVALID",
            "Object layer objects must be an array.",
            `${layerPointer}/objects`,
          ),
        );
      } else if (objectBudget.count + value.objects.length > MAX_OBJECT_COUNT) {
        diagnostics.push(
          errorDiagnostic(
            "OBJECT_LIMIT_EXCEEDED",
            `Map contains more than ${MAX_OBJECT_COUNT} objects.`,
            `${layerPointer}/objects`,
          ),
        );
      } else {
        objectBudget.count += value.objects.length;
        for (const [objectIndex, objectValue] of value.objects.entries()) {
          if (diagnostics.length >= MAX_DIAGNOSTICS) {
            return;
          }
          const objectPointer = `${layerPointer}/objects/${objectIndex}`;
          if (!isJsonObject(objectValue)) {
            diagnostics.push(
              errorDiagnostic(
                "OBJECT_INVALID",
                "Object layer entries must be objects.",
                objectPointer,
              ),
            );
            continue;
          }
          if (
            typeof objectValue.id !== "number" ||
            !Number.isSafeInteger(objectValue.id) ||
            objectValue.id <= 0
          ) {
            diagnostics.push(
              errorDiagnostic(
                "OBJECT_ID_INVALID",
                "Object id must be a positive integer.",
                `${objectPointer}/id`,
              ),
            );
          } else if (seenObjectIds.has(objectValue.id)) {
            diagnostics.push(
              errorDiagnostic(
                "OBJECT_ID_DUPLICATE",
                `Duplicate object id ${objectValue.id}.`,
                `${objectPointer}/id`,
              ),
            );
          } else {
            seenObjectIds.add(objectValue.id);
          }
          if (objectValue.gid !== undefined) {
            const gidPointer = `${objectPointer}/gid`;
            const gid = objectValue.gid;
            if (
              typeof gid !== "number" ||
              !Number.isSafeInteger(gid) ||
              gid < 0 ||
              gid > 0xffffffff
            ) {
              diagnostics.push(
                errorDiagnostic(
                  "GID_INVALID",
                  "Every GID must be an unsigned 32-bit integer.",
                  gidPointer,
                ),
              );
              continue;
            }
            try {
              decodeGid(gid, "orthogonal");
            } catch (error) {
              diagnostics.push(
                fromCaughtDiagnostic(
                  error,
                  gidPointer,
                ),
              );
            }
          }
        }
      }
      continue;
    }
    if (value.type === "imagelayer") {
      continue;
    }
    if (value.type !== "tilelayer") {
      diagnostics.push(
        errorDiagnostic(
          "LAYER_TYPE_INVALID",
          "Layer type must be tilelayer, objectgroup, imagelayer or group.",
          `${layerPointer}/type`,
        ),
      );
      continue;
    }
    if ("chunks" in value || typeof value.data === "string") {
      diagnostics.push(
        errorDiagnostic(
          "TILE_ENCODING_UNSUPPORTED",
          "MVP editing requires a finite numeric JSON data array.",
          layerPointer,
        ),
      );
      continue;
    }
    if (!Array.isArray(value.data)) {
      diagnostics.push(
        errorDiagnostic("TILE_DATA_INVALID", "Tile layer data must be an array.", `${layerPointer}/data`),
      );
      continue;
    }
    const width = value.width;
    const height = value.height;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      value.data.length !== width * height
    ) {
      diagnostics.push(
        errorDiagnostic(
          "TILE_DATA_LENGTH_INVALID",
          "Tile layer data length must equal width × height.",
          `${layerPointer}/data`,
        ),
      );
    }
    for (const [gidIndex, gid] of value.data.entries()) {
      if (diagnostics.length >= MAX_DIAGNOSTICS) {
        return;
      }
      if (
        typeof gid !== "number" ||
        !Number.isSafeInteger(gid) ||
        gid < 0 ||
        gid > 0xffffffff
      ) {
        diagnostics.push(
          errorDiagnostic(
            "GID_INVALID",
            "Every GID must be an unsigned 32-bit integer.",
            `${layerPointer}/data/${gidIndex}`,
          ),
        );
        break;
      }
      try {
        decodeGid(gid, "orthogonal");
      } catch (error) {
        diagnostics.push(fromCaughtDiagnostic(error, `${layerPointer}/data/${gidIndex}`));
        break;
      }
    }
  }
}

export function validateReferencedGids(
  layers: JsonValue[],
  bindings: readonly TilesetBinding[],
  diagnostics: Diagnostic[],
  pointer: string,
  depth = 0,
  budget: LayerTraversalBudget = { count: 0 },
  objectBudget: { count: number } = {
    count: 0,
  },
): void {
  if (
    diagnostics.length >= MAX_DIAGNOSTICS ||
    depth > MAX_LAYER_DEPTH ||
    budget.count + layers.length > MAX_LAYER_COUNT
  ) {
    return;
  }
  budget.count += layers.length;
  for (const [index, value] of layers.entries()) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      return;
    }
    if (!isJsonObject(value)) {
      continue;
    }
    const layerPointer = `${pointer}/${index}`;
    if (value.type === "group" && Array.isArray(value.layers)) {
      validateReferencedGids(
        value.layers,
        bindings,
        diagnostics,
        `${layerPointer}/layers`,
        depth + 1,
        budget,
        objectBudget,
      );
      continue;
    }
    if (
      value.type === "objectgroup" &&
      Array.isArray(value.objects)
    ) {
      if (
        objectBudget.count +
          value.objects.length >
        MAX_OBJECT_COUNT
      ) {
        return;
      }
      objectBudget.count += value.objects.length;
      for (const [
        objectIndex,
        objectValue,
      ] of value.objects.entries()) {
        if (
          diagnostics.length >=
          MAX_DIAGNOSTICS
        ) {
          return;
        }
        if (
          !isJsonObject(objectValue) ||
          objectValue.gid === undefined
        ) {
          continue;
        }
        const gid = objectValue.gid;
        if (
          typeof gid !== "number" ||
          !Number.isSafeInteger(gid) ||
          gid < 0 ||
          gid > 0xffffffff
        ) {
          continue;
        }
        const gidPointer =
          `${layerPointer}/objects/${objectIndex}/gid`;
        let baseGid: number;
        try {
          baseGid = decodeGid(
            gid,
            "orthogonal",
          ).baseGid;
        } catch {
          // The structural pass already reports invalid GID flags.
          continue;
        }
        if (baseGid === 0) {
          continue;
        }
        try {
          gidToTileRef(
            gid,
            "orthogonal",
            bindings,
          );
        } catch (error) {
          diagnostics.push(
            fromCaughtDiagnostic(
              error,
              gidPointer,
            ),
          );
        }
      }
      continue;
    }
    if (value.type !== "tilelayer" || !Array.isArray(value.data)) {
      continue;
    }
    for (const [gidIndex, gid] of value.data.entries()) {
      if (diagnostics.length >= MAX_DIAGNOSTICS) {
        return;
      }
      if (typeof gid !== "number" || !Number.isSafeInteger(gid) || gid === 0) {
        continue;
      }
      try {
        gidToTileRef(gid, "orthogonal", bindings);
      } catch (error) {
        diagnostics.push(fromCaughtDiagnostic(error, `${layerPointer}/data/${gidIndex}`));
      }
    }
  }
}

export function errorDiagnostic(code: string, message: string, jsonPointer: string): Diagnostic {
  return { code, severity: "error", message, jsonPointer };
}

export function fromCaughtDiagnostic(error: unknown, jsonPointer: string): Diagnostic {
  const normalized = asTiledMcpError(error);
  return {
    code: normalized.code,
    severity: "error",
    message:
      normalized.message.length <= MAX_DIAGNOSTIC_MESSAGE_LENGTH
        ? normalized.message
        : `${normalized.message.slice(
            0,
            MAX_DIAGNOSTIC_MESSAGE_LENGTH - 1,
          )}…`,
    jsonPointer,
  };
}

export function validatePositiveIntegerField(
  object: JsonObject,
  key: string,
  diagnostics: Diagnostic[],
): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    diagnostics.push(
      errorDiagnostic(
        "POSITIVE_INTEGER_REQUIRED",
        `${key} must be a positive integer.`,
        `/${key}`,
      ),
    );
    return 0;
  }
  return value;
}

export function readOptionalInteger(value: JsonValue | undefined, context: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return expectInteger(value, context);
}

export function unsupportedRenderFeature(
  feature: string,
  message: string,
  details: Record<string, unknown>,
): TiledMcpError {
  return new TiledMcpError(
    "UNSUPPORTED_RENDER_FEATURE",
    message,
    { feature, ...details },
  );
}

export function assertPositiveInteger(value: number, context: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TiledMcpError("INVALID_ARGUMENT", `${context} must be a positive integer.`);
  }
}

export function assertLayerTraversalBudget(
  nextCount: number,
  depth: number,
  budget: LayerTraversalBudget,
): void {
  if (depth > MAX_LAYER_DEPTH || budget.count + nextCount > MAX_LAYER_COUNT) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Layer tree exceeds depth ${MAX_LAYER_DEPTH} or count ${MAX_LAYER_COUNT}.`,
      { maxDepth: MAX_LAYER_DEPTH, maxLayers: MAX_LAYER_COUNT },
    );
  }
  budget.count += nextCount;
}

export function maximumSetValue(values: ReadonlySet<number>): number {
  let maximum = 0;
  for (const value of values) {
    maximum = Math.max(maximum, value);
  }
  return maximum;
}

export function assertNoTemplateReferences(document: JsonValue, projectPath: string): void {
  const stack: JsonValue[] = [document];
  let visited = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === undefined || value === null || typeof value !== "object") {
      continue;
    }
    visited += 1;
    if (visited > 1_000_000) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        "Document is too complex to validate for safe rendering.",
        { path: projectPath },
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        stack.push(item);
      }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(value, "template")) {
      throw new TiledMcpError(
        "UNSAFE_RENDER_REFERENCE",
        "Object templates are not supported by the sandboxed MVP renderer.",
        { path: projectPath },
      );
    }
    for (const item of Object.values(value)) {
      stack.push(item);
    }
  }
}

export function isRecordValue(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}



function isLayerPathEffectivelyLocked(
  map: JsonObject,
  path: JsonSourcePath,
): boolean {
  let current: JsonValue = map;
  for (const segment of path) {
    if (typeof segment === "number") {
      const array = expectArray(
        current,
        "layer path array",
      );
      current = array[segment] as JsonValue;
    } else {
      const object = expectObject(
        current,
        "layer path object",
      );
      current = object[segment] as JsonValue;
    }
    if (
      isJsonObject(current) &&
      current.locked === true
    ) {
      return true;
    }
  }
  return false;
}

export function collectObjectLocations(
  map: JsonObject,
  mapPath: string,
): ObjectLocation[] {
  const locations: ObjectLocation[] = [];
  collectObjectLocationsRecursive(
    expectArray(map.layers, `${mapPath}.layers`),
    `${mapPath}.layers`,
    ["layers"],
    locations,
    { count: 0 },
    { count: 0 },
    [],
  );
  assertUniqueObjectIds(locations, mapPath);
  return locations;
}

function assertObjectPathCoordinate(
  value: unknown,
  context: string,
  errorCode: "INVALID_ARGUMENT" | "INVALID_DOCUMENT",
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > MAX_ABSOLUTE_OBJECT_NUMBER
  ) {
    throw new TiledMcpError(
      errorCode,
      `${context} must be a finite number between -${MAX_ABSOLUTE_OBJECT_NUMBER} and ${MAX_ABSOLUTE_OBJECT_NUMBER}.`,
    );
  }
}

function assertStoredObjectSize(
  value: unknown,
  context: string,
  mapPath: string,
  objectId: number,
): asserts value is number {
  assertStoredObjectNumber(
    value,
    context,
    mapPath,
    objectId,
  );
  if (value < 0) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must not be negative.`,
      { path: mapPath, objectId },
    );
  }
}

function assertStoredPathDimension(
  value: unknown,
  context: string,
  mapPath: string,
  objectId: number,
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_ABSOLUTE_OBJECT_NUMBER
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must be a finite nonnegative number no greater than ${MAX_ABSOLUTE_OBJECT_NUMBER}.`,
      { path: mapPath, objectId },
    );
  }
}


function collectObjectLocationsRecursive(
  layers: JsonValue[],
  context: string,
  path: JsonSourcePath,
  output: ObjectLocation[],
  layerBudget: LayerTraversalBudget,
  objectBudget: { count: number },
  ancestors: readonly JsonObject[],
  depth = 0,
): void {
  assertLayerTraversalBudget(layers.length, depth, layerBudget);
  for (const [layerIndex, value] of layers.entries()) {
    const layer = expectObject(value, `${context}[${layerIndex}]`);
    const layerPath: JsonSourcePath = [...path, layerIndex];
    if (layer.type === "group") {
      collectObjectLocationsRecursive(
        expectArray(layer.layers, `${context}[${layerIndex}].layers`),
        `${context}[${layerIndex}].layers`,
        [...layerPath, "layers"],
        output,
        layerBudget,
        objectBudget,
        [...ancestors, layer],
        depth + 1,
      );
      continue;
    }
    if (layer.type !== "objectgroup") {
      continue;
    }
    const objects = expectArray(
      layer.objects,
      `${context}[${layerIndex}].objects`,
    );
    if (objectBudget.count + objects.length > MAX_OBJECT_COUNT) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `Map contains more than ${MAX_OBJECT_COUNT} objects.`,
        { limit: MAX_OBJECT_COUNT },
      );
    }
    objectBudget.count += objects.length;
    const layerView: ObjectLayerView = {
      object: layer,
      path: layerPath,
      id: expectInteger(layer.id, `${context}[${layerIndex}].id`),
      name:
        typeof layer.name === "string"
          ? layer.name
          : `Layer ${String(layer.id)}`,
      objects,
      ancestors,
    };
    for (const [objectIndex, objectValue] of objects.entries()) {
      output.push({
        object: expectObject(
          objectValue,
          `${context}[${layerIndex}].objects[${objectIndex}]`,
        ),
        objectIndex,
        layer: layerView,
        ancestors,
      });
    }
  }
}


export function findObjectLayer(
  map: JsonObject,
  layerId: number,
  mapPath: string,
): ObjectLayerView {
  const layers = expectArray(map.layers, `${mapPath}.layers`);
  const located = findLayerRecursive(
    layers,
    layerId,
    `${mapPath}.layers`,
    ["layers"],
  );
  if (!located) {
    throw new TiledMcpError("LAYER_NOT_FOUND", `Layer ${layerId} does not exist.`, {
      path: mapPath,
      layerId,
    });
  }
  if (located.object.type !== "objectgroup") {
    throw new TiledMcpError(
      "LAYER_TYPE_MISMATCH",
      `Layer ${layerId} is not an object layer.`,
      { path: mapPath, layerId },
    );
  }
  return {
    object: located.object,
    path: located.path,
    id: expectInteger(located.object.id, `layer ${layerId}.id`),
    name:
      typeof located.object.name === "string"
        ? located.object.name
        : `Layer ${layerId}`,
    objects: expectArray(located.object.objects, `layer ${layerId}.objects`),
    ancestors: located.ancestors,
  };
}

export function assertRegionInsideLayer(
  layer: TileLayerView,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const regionEndX = x + width;
  const regionEndY = y + height;
  if (
    !Number.isSafeInteger(regionEndX) ||
    !Number.isSafeInteger(regionEndY)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "Region endpoints must be safe integers.",
      {
        region: { x, y, width, height },
      },
    );
  }
  const layerEndX = layer.x + layer.width;
  const layerEndY = layer.y + layer.height;
  if (
    !Number.isSafeInteger(layerEndX) ||
    !Number.isSafeInteger(layerEndY)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `Tile layer ${layer.id} bounds exceed the safe integer range.`,
      {
        layerId: layer.id,
        layerBounds: {
          x: layer.x,
          y: layer.y,
          width: layer.width,
          height: layer.height,
        },
      },
    );
  }
  if (
    x < layer.x ||
    y < layer.y ||
    regionEndX > layerEndX ||
    regionEndY > layerEndY
  ) {
    throw new TiledMcpError(
      "REGION_OUT_OF_BOUNDS",
      `Region is outside tile layer ${layer.id}.`,
      {
        layerId: layer.id,
        region: { x, y, width, height },
        layerBounds: {
          x: layer.x,
          y: layer.y,
          width: layer.width,
          height: layer.height,
        },
      },
    );
  }
}

export function tileRefToGid(
  tile: TileRef | null,
  orientation: MapOrientation,
  bindings: readonly TilesetBinding[],
): number {
  if (tile === null) {
    return 0;
  }
  if (!isRecordValue(tile)) {
    throw new TiledMcpError("INVALID_ARGUMENT", "tile must be a TileRef or null.");
  }
  const tileRecord =
    tile as unknown as Record<string, unknown>;
  assertExactObjectKeys(
    tileRecord,
    new Set([
      "localId",
      "tileset",
      ...(Object.prototype.hasOwnProperty.call(
        tileRecord,
        "transform",
      )
        ? ["transform"]
        : []),
    ]),
    "tile",
  );
  if (
    !isRecordValue(tile.tileset) ||
    tile.tileset.kind !== "external" ||
    typeof tile.tileset.assetId !== "string" ||
    tile.tileset.assetId.length === 0 ||
    tile.tileset.assetId.length > 128
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "tile.tileset must identify an external tileset asset.",
    );
  }
  assertExactObjectKeys(
    tile.tileset as unknown as Record<string, unknown>,
    new Set(["assetId", "kind"]),
    "tile.tileset",
  );
  assertSafeInteger(tile.localId, "tile.localId");
  assertTileTransformInput(
    tileRecord.transform,
    orientation,
  );
  const tilesetRef = tile.tileset;
  if (tilesetRef.kind !== "external") {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "tile.tileset must identify an external tileset asset.",
    );
  }
  const binding = bindings.find((candidate) => candidate.assetId === tilesetRef.assetId);
  if (!binding) {
    throw new TiledMcpError(
      "TILESET_NOT_IN_MAP",
      `Tileset ${tilesetRef.assetId} is not referenced by this map.`,
      { tilesetAssetId: tilesetRef.assetId },
    );
  }
  if (tile.localId < 0 || tile.localId >= binding.tileCount) {
    throw new TiledMcpError(
      "TILE_ID_OUT_OF_RANGE",
      `Tile ${tile.localId} is outside tileset ${binding.name}.`,
      { tilesetAssetId: binding.assetId, localId: tile.localId, tileCount: binding.tileCount },
    );
  }
  return encodeGid(binding.firstGid + tile.localId, orientation, tile.transform);
}

export function assertResolvedCreateLayerOperation(
  operation: ResolvedCreateLayerOperation,
): void {
  const expectedKeys = [
    "allocatedCellCount",
    "index",
    "layerId",
    "layerType",
    "name",
    "parentGroupId",
    "type",
    ...(operation.image === undefined ? [] : ["image"]),
  ].sort();
  const actualKeys = Object.keys(operation).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The resolved create-layer operation has unexpected fields.",
    );
  }
  if (
    operation.type !== "createLayer" ||
    (operation.layerType !== "tilelayer" &&
      operation.layerType !== "objectgroup" &&
      operation.layerType !== "imagelayer" &&
      operation.layerType !== "group") ||
    !Number.isSafeInteger(operation.layerId) ||
    operation.layerId <= 0 ||
    operation.layerId >= MAX_TILED_SIGNED_ID ||
    typeof operation.name !== "string" ||
    operation.name.length === 0 ||
    operation.name.length > MAX_LAYER_NAME_LENGTH ||
    (operation.parentGroupId !== null &&
      (!Number.isSafeInteger(operation.parentGroupId) ||
        operation.parentGroupId <= 0)) ||
    !Number.isSafeInteger(operation.index) ||
    operation.index < 0 ||
    !Number.isSafeInteger(operation.allocatedCellCount) ||
    operation.allocatedCellCount < 0 ||
    operation.allocatedCellCount > MAX_CREATE_TILE_LAYER_CELLS ||
    (operation.layerType === "tilelayer"
      ? operation.allocatedCellCount <= 0
      : operation.allocatedCellCount !== 0)
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The resolved create-layer operation is malformed.",
    );
  }
  if (
    (operation.layerType === "imagelayer") !==
    (operation.image !== undefined)
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "Only an image layer may carry one required image dependency.",
    );
  }
  if (operation.image === undefined) {
    return;
  }
  const imageKeys = Object.keys(operation.image).sort();
  const expectedImageKeys = [
    "assetId",
    "height",
    "path",
    "revision",
    "source",
    "width",
  ];
  if (
    imageKeys.length !== expectedImageKeys.length ||
    imageKeys.some((key, index) => key !== expectedImageKeys[index]) ||
    !/^asset_[0-9a-f]{24}$/u.test(operation.image.assetId) ||
    typeof operation.image.path !== "string" ||
    operation.image.path.length === 0 ||
    typeof operation.image.source !== "string" ||
    operation.image.source.length === 0 ||
    operation.image.source.includes("\\") ||
    posix.isAbsolute(operation.image.source) ||
    posix.normalize(operation.image.source) !== operation.image.source ||
    !REVISION_PATTERN.test(operation.image.revision) ||
    !Number.isSafeInteger(operation.image.width) ||
    operation.image.width <= 0 ||
    operation.image.width > MAX_TILESET_INPUT_EDGE ||
    !Number.isSafeInteger(operation.image.height) ||
    operation.image.height <= 0 ||
    operation.image.height > MAX_TILESET_INPUT_EDGE
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The resolved image-layer dependency is malformed.",
    );
  }
}

export function assertPositiveIntegerAtMost(
  value: number,
  context: string,
  limit: number,
): void {
  assertPositiveInteger(value, context);
  if (value > limit) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be at most ${limit}.`,
      {
        option: context,
        limit,
        actual: value,
      },
    );
  }
}

export function assertSafeInteger(value: number, context: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TiledMcpError("INVALID_ARGUMENT", `${context} must be an integer.`);
  }
}


export function readLayerGid(layer: TileLayerView, x: number, y: number): number {
  if (layer.chunked !== undefined) {
    return readChunkedViewGid(layer.chunked, x, y);
  }
  const index = (y - layer.y) * layer.width + (x - layer.x);
  const value = layer.data[index];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TiledMcpError("INVALID_TILE_DATA", `Layer ${layer.id} has a non-integer GID.`, {
      layerId: layer.id,
      x,
      y,
    });
  }
  return value;
}


export function assertExactObjectKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void {
  const unknownKey = Object.keys(value).find(
    (key) => !allowed.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }
}

function assertTileTransformInput(
  value: unknown,
  orientation: MapOrientation,
): void {
  if (value === undefined) {
    return;
  }
  if (!isRecordValue(value)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "tile.transform must be an object when present.",
    );
  }
  const transform = value as Record<string, unknown>;
  const hexagonal = orientation === "hexagonal";
  const booleanFields = hexagonal
    ? ["flipH", "flipV", "rotate60", "rotate120"]
    : ["flipD", "flipH", "flipV"];
  const allowedFields = new Set([
    "kind",
    "rawFlags",
    ...booleanFields,
  ]);
  const unexpectedField = Object.keys(transform).find(
    (key) => !allowedFields.has(key),
  );
  if (unexpectedField !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `tile.transform contains unsupported field ${unexpectedField}.`,
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(
      transform,
      "kind",
    ) &&
    transform.kind !==
      (hexagonal ? "hexagonal" : "orthogonal")
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `tile.transform.kind must be ${hexagonal ? "hexagonal" : "orthogonal"}.`,
    );
  }
  for (const field of booleanFields) {
    if (
      Object.prototype.hasOwnProperty.call(
        transform,
        field,
      ) &&
      typeof transform[field] !== "boolean"
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `tile.transform.${field} must be a boolean.`,
      );
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(
      transform,
      "rawFlags",
    ) &&
    (typeof transform.rawFlags !== "number" ||
      !Number.isSafeInteger(transform.rawFlags) ||
      transform.rawFlags < 0 ||
      transform.rawFlags > 0xffffffff)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "tile.transform.rawFlags must be an unsigned 32-bit integer.",
    );
  }
}

/**
 * Validates an image-collection tileset's per-tile entries and returns the
 * sparse set of existing local ids. Every tile of a collection carries its
 * own image, so `tiles.length` must equal `tilecount`.
 */

function assertStoredObjectNumber(
  value: unknown,
  context: string,
  mapPath: string,
  objectId: number,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > MAX_ABSOLUTE_OBJECT_NUMBER
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must be a finite number between -${MAX_ABSOLUTE_OBJECT_NUMBER} and ${MAX_ABSOLUTE_OBJECT_NUMBER}.`,
      { path: mapPath, objectId },
    );
  }
}

