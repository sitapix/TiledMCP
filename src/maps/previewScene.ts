import { TiledMcpError } from "../errors.js";
import {
  expectArray,
  expectInteger,
  expectObject,
  type JsonObject,
  type JsonValue,
} from "../formats/json.js";
import { decodeGid } from "./gid.js";
import {
  readChunkedRegionGids,
  resolveTileLayerCells,
} from "./tileData.js";

export const MAX_PREVIEW_REGION_CELLS = 20_000;
export const MAX_PREVIEW_BASE_OBJECTS = 512;
export const MAX_PREVIEW_OBJECT_SHAPE_POINTS = 256;
export const MAX_PREVIEW_LAYERS = 128;
export const MAX_PREVIEW_TILE_DRAWS = 250_000;
export const MAX_PREVIEW_ATLASES = 64;
export const MAX_PREVIEW_OMITTED_LAYERS = 128;
export const MAX_PREVIEW_LAYER_LABEL_LENGTH = 128;

export interface PreviewRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewLayerSelectionInput {
  region?: PreviewRegion;
  layerIds?: readonly number[];
}

export interface PreviewTilesetRange {
  assetId: string;
  firstGid: number;
  tileCount: number;
  name: string;
}

export interface PreviewTileLayer {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data: readonly number[];
  opacity: number;
}

export interface PreviewObjectLayerObject {
  id: number;
  shape:
    | "rectangle"
    | "point"
    | "ellipse"
    | "capsule"
    | "polygon"
    | "polyline"
    | "text"
    | "tile";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  points?: ReadonlyArray<{
    x: number;
    y: number;
  }>;
  /**
   * Raw encoded GID for tile objects; the service resolves it into
   * `tileRender` before rendering.
   */
  gid?: number;
  tileRender?: {
    assetId: string;
    localId: number;
    /**
     * Row-major 2x3 affine [a,b,c,d,e,f] mapping tile-image pixels to
     * anchor-relative map pixels, combining Tiled's alignment, scaled
     * tile offset, flips, and the diagonal-flip rotation.
     */
    transform: readonly [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
  };
}

export interface PreviewObjectLayer {
  id: number;
  name: string;
  opacity: number;
  /**
   * Raw `#RRGGBB` / `#AARRGGBB` layer color; objects fall back to Tiled's
   * gray when absent. Class-based colors live in project files outside the
   * map and are a documented divergence.
   */
  color?: string;
  drawOrder: "topdown" | "index";
  objects: PreviewObjectLayerObject[];
  tileObjectCount: number;
  omittedTemplateObjectCount: number;
  hiddenObjectCount: number;
  textBoxCount: number;
}

export interface OmittedPreviewLayer {
  id: number;
  name: string;
  type: string;
  reason: "unsupported-layer-type";
}

export interface PreviewScene {
  region: PreviewRegion;
  layers: PreviewTileLayer[];
  objectLayers: PreviewObjectLayer[];
  /**
   * Document traversal order across both renderable layer kinds, indexing
   * into `layers` and `objectLayers`.
   */
  drawList: Array<{
    kind: "tile" | "objects";
    index: number;
  }>;
  layerSelection: "visible" | "explicit";
  omittedLayers: OmittedPreviewLayer[];
  omittedLayerCount: number;
  omittedLayersTruncated: boolean;
  usedAssetIds: string[];
}

interface TraversalState {
  visible: boolean;
  selectedAncestorVisible: boolean;
}

interface LocatedLayer {
  object: JsonObject;
  id: number;
  name: string;
  type: string;
  path: string;
  ancestors: JsonObject[];
}

/**
 * Builds the closed, bounded tile-layer scene consumed by the native renderer.
 * Unsupported visible leaf layers are reported as omissions instead of being
 * silently treated as rendered content.
 */
export function buildPreviewScene(
  map: JsonObject,
  mapPath: string,
  mapWidth: number,
  mapHeight: number,
  ranges: readonly PreviewTilesetRange[],
  input: PreviewLayerSelectionInput,
): PreviewScene {
  assertSupportedRenderOrder(map, mapPath);
  const infinite = map.infinite === true;
  const region = resolveRegion(
    input.region,
    mapWidth,
    mapHeight,
    infinite,
  );
  const locations = collectLayerLocations(
    expectArray(map.layers, `${mapPath}.layers`),
    `${mapPath}.layers`,
  );
  const byId = new Map(locations.map((located) => [located.id, located]));
  const explicitIds =
    input.layerIds === undefined ? undefined : validateExplicitLayerIds(input.layerIds);

  if (explicitIds !== undefined) {
    for (const layerId of explicitIds) {
      const located = byId.get(layerId);
      if (located === undefined) {
        throw new TiledMcpError(
          "LAYER_NOT_FOUND",
          `Layer ${layerId} does not exist.`,
          { path: mapPath, layerId },
        );
      }
      if (
        located.type !== "tilelayer" &&
        located.type !== "objectgroup"
      ) {
        throw new TiledMcpError(
          "LAYER_TYPE_MISMATCH",
          `Layer ${layerId} is not a renderable tile or object layer.`,
          { path: mapPath, layerId, actualType: located.type },
        );
      }
    }
  }

  const explicitSet =
    explicitIds === undefined ? undefined : new Set<number>(explicitIds);
  const selectedLocations: Array<{
    kind: "tile" | "objects";
    located: LocatedLayer;
  }> = [];
  const omittedLayers: OmittedPreviewLayer[] = [];
  let omittedLayerCount = 0;
  for (const located of locations) {
    if (located.type === "group") {
      continue;
    }
    const inheritedVisible = located.ancestors.every(
      (ancestor) => ancestor.visible !== false,
    );
    const layerVisible = located.object.visible !== false;
    const selected =
      explicitSet === undefined
        ? inheritedVisible && layerVisible
        : explicitSet.has(located.id);
    if (!selected) {
      continue;
    }
    if (located.type === "tilelayer") {
      selectedLocations.push({
        kind: "tile",
        located,
      });
      continue;
    }
    if (located.type === "objectgroup") {
      selectedLocations.push({
        kind: "objects",
        located,
      });
      continue;
    }
    if (explicitSet === undefined) {
      omittedLayerCount += 1;
      if (omittedLayers.length < MAX_PREVIEW_OMITTED_LAYERS) {
        omittedLayers.push({
          id: located.id,
          name: boundedPreviewLabel(located.name),
          type: boundedPreviewLabel(located.type),
          reason: "unsupported-layer-type",
        });
      }
    }
  }

  if (selectedLocations.length > MAX_PREVIEW_LAYERS) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A preview may render at most ${MAX_PREVIEW_LAYERS} layers.`,
      {
        actual: selectedLocations.length,
        limit: MAX_PREVIEW_LAYERS,
      },
    );
  }
  const layers: PreviewTileLayer[] = [];
  const objectLayers: PreviewObjectLayer[] = [];
  const drawList: PreviewScene["drawList"] = [];
  let baseObjectCount = 0;
  for (const selectedEntry of selectedLocations) {
    const located = selectedEntry.located;
    for (const [ancestorIndex, ancestor] of located.ancestors.entries()) {
      assertGroupRenderProperties(
        ancestor,
        `${located.path}.ancestors[${ancestorIndex}]`,
        located.id,
      );
    }
    if (selectedEntry.kind === "tile") {
      layers.push(
        readPreviewTileLayer(
          located,
          region,
          infinite,
        ),
      );
      drawList.push({
        kind: "tile",
        index: layers.length - 1,
      });
      continue;
    }
    const objectLayer =
      readPreviewObjectLayer(located);
    baseObjectCount +=
      objectLayer.objects.length;
    if (
      baseObjectCount > MAX_PREVIEW_BASE_OBJECTS
    ) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `A preview may render at most ${MAX_PREVIEW_BASE_OBJECTS} objects; select fewer layers with layerIds.`,
        {
          actual: baseObjectCount,
          limit: MAX_PREVIEW_BASE_OBJECTS,
        },
      );
    }
    objectLayers.push(objectLayer);
    drawList.push({
      kind: "objects",
      index: objectLayers.length - 1,
    });
  }
  const activeLayerCount = layers.filter((layer) => layer.opacity > 0).length;
  const maximumDraws = region.width * region.height * activeLayerCount;
  if (!Number.isSafeInteger(maximumDraws) || maximumDraws > MAX_PREVIEW_TILE_DRAWS) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `The selected region and layers may require at most ${MAX_PREVIEW_TILE_DRAWS} tile draws.`,
      {
        regionCells: region.width * region.height,
        layerCount: activeLayerCount,
        maximumDraws,
        limit: MAX_PREVIEW_TILE_DRAWS,
      },
    );
  }

  const usedAssetIds = collectUsedAssetIds(layers, region, ranges);
  if (usedAssetIds.length > MAX_PREVIEW_ATLASES) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `A preview may use at most ${MAX_PREVIEW_ATLASES} atlas images.`,
      { actual: usedAssetIds.length, limit: MAX_PREVIEW_ATLASES },
    );
  }
  return {
    region,
    layers,
    objectLayers,
    drawList,
    layerSelection: explicitSet === undefined ? "visible" : "explicit",
    omittedLayers,
    omittedLayerCount,
    omittedLayersTruncated:
      omittedLayerCount > omittedLayers.length,
    usedAssetIds,
  };
}

function assertSupportedRenderOrder(map: JsonObject, mapPath: string): void {
  const renderOrder =
    map.renderorder === undefined
      ? "right-down"
      : map.renderorder;
  if (
    !["right-down", "right-up", "left-down", "left-up"].includes(
      String(renderOrder),
    )
  ) {
    throw unsupportedFeature(
      "renderorder",
      `Native preview v1 does not recognize render order ${String(renderOrder)}.`,
      { path: mapPath, renderOrder },
    );
  }
  for (const [field, fallback] of [
    ["parallaxoriginx", 0],
    ["parallaxoriginy", 0],
  ] as const) {
    const value = map[field] ?? fallback;
    if (value !== fallback) {
      throw unsupportedFeature(
        field,
        `Native preview v1 does not support a non-zero ${field}.`,
        { path: mapPath, value },
      );
    }
  }
}

function resolveRegion(
  value: PreviewRegion | undefined,
  mapWidth: number,
  mapHeight: number,
  infinite = false,
): PreviewRegion {
  if (infinite && value === undefined) {
    throw new TiledMcpError(
      "PREVIEW_REGION_REQUIRED",
      "Infinite maps have no finite bounds; provide an explicit absolute-coordinate region.",
      {},
    );
  }
  const region = value ?? { x: 0, y: 0, width: mapWidth, height: mapHeight };
  for (const field of ["x", "y", "width", "height"] as const) {
    const fieldValue = region[field];
    if (!Number.isSafeInteger(fieldValue)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `region.${field} must be a safe integer.`,
        { field, value: fieldValue },
      );
    }
  }
  if (region.width <= 0 || region.height <= 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "region.width and region.height must be positive.",
      { region },
    );
  }
  const right = region.x + region.width;
  const bottom = region.y + region.height;
  if (infinite) {
    if (
      Math.abs(region.x) > 1_000_000_000 ||
      Math.abs(region.y) > 1_000_000_000 ||
      !Number.isSafeInteger(right) ||
      !Number.isSafeInteger(bottom) ||
      Math.abs(right) > 1_000_000_001 ||
      Math.abs(bottom) > 1_000_000_001
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "The preview region must stay within ±1,000,000,000 absolute tile coordinates.",
        { region },
      );
    }
    const cells = region.width * region.height;
    if (
      !Number.isSafeInteger(cells) ||
      cells > MAX_PREVIEW_REGION_CELLS
    ) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `A preview region may contain at most ${MAX_PREVIEW_REGION_CELLS} cells.`,
        {
          actual: cells,
          limit: MAX_PREVIEW_REGION_CELLS,
        },
      );
    }
    return region;
  }
  if (
    region.x < 0 ||
    region.y < 0 ||
    !Number.isSafeInteger(right) ||
    !Number.isSafeInteger(bottom) ||
    right > mapWidth ||
    bottom > mapHeight
  ) {
    throw new TiledMcpError(
      "REGION_OUT_OF_BOUNDS",
      `Region ${region.x},${region.y} ${region.width}x${region.height} falls outside the map bounds 0,0 ${mapWidth}x${mapHeight}. Clamp the region to those bounds.`,
      {
        region,
        mapBounds: { x: 0, y: 0, width: mapWidth, height: mapHeight },
      },
    );
  }
  const cells = region.width * region.height;
  if (!Number.isSafeInteger(cells) || cells > MAX_PREVIEW_REGION_CELLS) {
    throw new TiledMcpError(
      value === undefined ? "PREVIEW_REGION_REQUIRED" : "RESULT_LIMIT_EXCEEDED",
      value === undefined
        ? `The full map exceeds the ${MAX_PREVIEW_REGION_CELLS}-cell native preview limit; provide region.`
        : `A preview region may contain at most ${MAX_PREVIEW_REGION_CELLS} cells.`,
      {
        actual: cells,
        limit: MAX_PREVIEW_REGION_CELLS,
        mapBounds: { x: 0, y: 0, width: mapWidth, height: mapHeight },
      },
    );
  }
  return region;
}

function validateExplicitLayerIds(values: readonly number[]): number[] {
  if (values.length === 0 || values.length > MAX_PREVIEW_LAYERS) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `layerIds must contain between 1 and ${MAX_PREVIEW_LAYERS} IDs.`,
      { actual: values.length, limit: MAX_PREVIEW_LAYERS },
    );
  }
  const seen = new Set<number>();
  for (const layerId of values) {
    if (!Number.isSafeInteger(layerId) || layerId <= 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "layerIds must contain positive safe integers.",
        { layerId },
      );
    }
    if (seen.has(layerId)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `layerIds contains duplicate layer ID ${layerId}.`,
        { layerId },
      );
    }
    seen.add(layerId);
  }
  return [...values];
}

function collectLayerLocations(
  values: JsonValue[],
  path: string,
): LocatedLayer[] {
  const output: LocatedLayer[] = [];
  const visit = (
    entries: JsonValue[],
    context: string,
    ancestors: JsonObject[],
    state: TraversalState,
    depth: number,
  ): void => {
    if (depth > 64) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        "Layer nesting exceeds the 64-level preview limit.",
      );
    }
    for (const [index, value] of entries.entries()) {
      const object = expectObject(value, `${context}[${index}]`);
      const id = expectInteger(object.id, `${context}[${index}].id`);
      if (typeof object.type !== "string") {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${context}[${index}].type must be a string.`,
          { layerId: id },
        );
      }
      if (
        object.visible !== undefined &&
        typeof object.visible !== "boolean"
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${context}[${index}].visible must be a boolean.`,
          { layerId: id, visible: object.visible },
        );
      }
      const type = object.type;
      const name =
        typeof object.name === "string" ? object.name : `Layer ${id}`;
      const layerPath = `${context}[${index}]`;
      output.push({
        object,
        id,
        name,
        type,
        path: layerPath,
        ancestors,
      });
      if (type === "group") {
        const nested = expectArray(object.layers, `${layerPath}.layers`);
        visit(
          nested,
          `${layerPath}.layers`,
          [...ancestors, object],
          {
            visible: state.visible && object.visible !== false,
            selectedAncestorVisible:
              state.selectedAncestorVisible && object.visible !== false,
          },
          depth + 1,
        );
      }
    }
  };
  visit(values, path, [], { visible: true, selectedAncestorVisible: true }, 0);
  return output;
}

const PREVIEW_OBJECT_COORDINATE_BOUND = 1_000_000_000;
const TILED_COLOR_PATTERN =
  /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu;

function readPreviewObjectLayer(
  located: LocatedLayer,
): PreviewObjectLayer {
  const layer = located.object;
  assertLeafRenderProperties(
    layer,
    located.path,
    located.id,
  );
  const drawOrderValue =
    layer.draworder === undefined
      ? "topdown"
      : layer.draworder;
  if (
    drawOrderValue !== "topdown" &&
    drawOrderValue !== "index"
  ) {
    throw unsupportedFeature(
      "draworder",
      `Object layer ${located.id} uses an unrecognized draw order.`,
      {
        path: located.path,
        layerId: located.id,
        drawOrder: drawOrderValue,
      },
    );
  }
  let color: string | undefined;
  if (layer.color !== undefined) {
    if (
      typeof layer.color !== "string" ||
      !TILED_COLOR_PATTERN.test(layer.color)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `Object layer ${located.id} color must be #RRGGBB or #AARRGGBB.`,
        { path: located.path, layerId: located.id },
      );
    }
    color = layer.color;
  }
  const objectValues = expectArray(
    layer.objects,
    `${located.path}.objects`,
  );
  const readNumber = (
    value: unknown,
    context: string,
    fallback: number,
  ): number => {
    if (value === undefined) {
      return fallback;
    }
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      Math.abs(value) >
        PREVIEW_OBJECT_COORDINATE_BOUND
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context} must be a bounded finite number.`,
        { path: located.path, layerId: located.id },
      );
    }
    return value;
  };
  const objects: PreviewObjectLayerObject[] = [];
  let tileObjectCount = 0;
  let omittedTemplateObjectCount = 0;
  let hiddenObjectCount = 0;
  let textBoxCount = 0;
  const readObjectOpacity = (
    value: unknown,
    context: string,
  ): number => {
    const opacity = readNumber(
      value,
      `${context}.opacity`,
      1,
    );
    if (opacity < 0 || opacity > 1) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.opacity must be between 0 and 1.`,
        {
          path: located.path,
          layerId: located.id,
        },
      );
    }
    return opacity;
  };
  for (const [
    index,
    objectValue,
  ] of objectValues.entries()) {
    const context = `${located.path}.objects[${index}]`;
    const object = expectObject(
      objectValue,
      context,
    );
    if (object.visible === false) {
      hiddenObjectCount += 1;
      continue;
    }
    if (object.template !== undefined) {
      omittedTemplateObjectCount += 1;
      continue;
    }
    if (object.gid !== undefined) {
      const gid = object.gid;
      if (
        typeof gid !== "number" ||
        !Number.isSafeInteger(gid) ||
        gid <= 0 ||
        gid > 0xffffffff
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${context}.gid must be a positive uint32.`,
          {
            path: located.path,
            layerId: located.id,
            index,
          },
        );
      }
      tileObjectCount += 1;
      objects.push({
        id: expectInteger(
          object.id,
          `${context}.id`,
        ),
        shape: "tile",
        x: readNumber(
          object.x,
          `${context}.x`,
          0,
        ),
        y: readNumber(
          object.y,
          `${context}.y`,
          0,
        ),
        width: readNumber(
          object.width,
          `${context}.width`,
          0,
        ),
        height: readNumber(
          object.height,
          `${context}.height`,
          0,
        ),
        rotation: readNumber(
          object.rotation,
          `${context}.rotation`,
          0,
        ),
        opacity: readObjectOpacity(
          object.opacity,
          context,
        ),
        gid,
      });
      continue;
    }
    const markers = [
      "point",
      "ellipse",
      "capsule",
      "polygon",
      "polyline",
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
        {
          path: located.path,
          layerId: located.id,
          index,
        },
      );
    }
    const marker = markers[0];
    const shape: PreviewObjectLayerObject["shape"] =
      marker === undefined
        ? "rectangle"
        : (marker as PreviewObjectLayerObject["shape"]);
    if (
      (shape === "point" ||
        shape === "ellipse" ||
        shape === "capsule") &&
      object[shape] !== true
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.${shape} must be true when present.`,
        {
          path: located.path,
          layerId: located.id,
          index,
        },
      );
    }
    if (shape === "text") {
      expectObject(
        object.text,
        `${context}.text`,
      );
      textBoxCount += 1;
    }
    const opacity = readObjectOpacity(
      object.opacity,
      context,
    );
    const width = readNumber(
      object.width,
      `${context}.width`,
      0,
    );
    const height = readNumber(
      object.height,
      `${context}.height`,
      0,
    );
    if (width < 0 || height < 0) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context} dimensions must be nonnegative.`,
        {
          path: located.path,
          layerId: located.id,
          index,
        },
      );
    }
    const entry: PreviewObjectLayerObject = {
      id: expectInteger(
        object.id,
        `${context}.id`,
      ),
      shape,
      x: readNumber(object.x, `${context}.x`, 0),
      y: readNumber(object.y, `${context}.y`, 0),
      width,
      height,
      rotation: readNumber(
        object.rotation,
        `${context}.rotation`,
        0,
      ),
      opacity,
    };
    if (
      shape === "polygon" ||
      shape === "polyline"
    ) {
      const pointsValue = object[shape];
      if (!Array.isArray(pointsValue)) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${context}.${shape} must be an array.`,
          {
            path: located.path,
            layerId: located.id,
            index,
          },
        );
      }
      const minimum = shape === "polygon" ? 3 : 2;
      if (
        pointsValue.length < minimum ||
        pointsValue.length >
          MAX_PREVIEW_OBJECT_SHAPE_POINTS
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${context}.${shape} must contain between ${minimum} and ${MAX_PREVIEW_OBJECT_SHAPE_POINTS} points.`,
          {
            path: located.path,
            layerId: located.id,
            index,
          },
        );
      }
      entry.points = pointsValue.map(
        (pointValue, pointIndex) => {
          const point = expectObject(
            pointValue,
            `${context}.${shape}[${pointIndex}]`,
          );
          const pointContext = `${context}.${shape}[${pointIndex}]`;
          for (const axis of [
            "x",
            "y",
          ] as const) {
            const value = point[axis];
            if (
              typeof value !== "number" ||
              !Number.isFinite(value) ||
              Math.abs(value) >
                PREVIEW_OBJECT_COORDINATE_BOUND
            ) {
              throw new TiledMcpError(
                "INVALID_DOCUMENT",
                `${pointContext}.${axis} must be a bounded finite number.`,
                {
                  path: located.path,
                  layerId: located.id,
                  index,
                },
              );
            }
          }
          return {
            x: point.x as number,
            y: point.y as number,
          };
        },
      );
    }
    objects.push(entry);
  }
  return {
    id: located.id,
    name: located.name,
    opacity: readOpacity(
      layer.opacity,
      located.path,
      located.id,
    ),
    ...(color === undefined ? {} : { color }),
    drawOrder: drawOrderValue,
    objects,
    tileObjectCount,
    omittedTemplateObjectCount,
    hiddenObjectCount,
    textBoxCount,
  };
}

function readPreviewTileLayer(
  located: LocatedLayer,
  region: PreviewRegion,
  infinite = false,
): PreviewTileLayer {
  const layer = located.object;
  assertLeafRenderProperties(layer, located.path, located.id);
  if (infinite && "chunks" in layer) {
    // Chunked layers materialize exactly the requested region: the renderer
    // intersects layer bounds with the region, so a region-shaped synthetic
    // layer samples identically while decoding only intersecting chunks.
    const cells = readChunkedRegionGids(
      layer,
      located.id,
      located.path,
      region,
    );
    for (const [index, value] of cells.entries()) {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 0xffffffff
      ) {
        throw new TiledMcpError(
          "INVALID_GID",
          `Layer ${located.id} contains an invalid GID.`,
          { layerId: located.id, index, gid: value },
        );
      }
    }
    return {
      id: located.id,
      name: located.name,
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      data: cells as number[],
      opacity: readOpacity(
        layer.opacity,
        located.path,
        located.id,
      ),
    };
  }
  const width = expectInteger(layer.width, `${located.path}.width`);
  const height = expectInteger(layer.height, `${located.path}.height`);
  if (width <= 0 || height <= 0) {
    throw new TiledMcpError(
      "INVALID_TILE_DATA",
      `Layer ${located.id} width and height must be positive.`,
      { layerId: located.id, width, height },
    );
  }
  const dataValues = resolveTileLayerCells(
    layer,
    located.id,
    located.path,
    width * height,
    "read",
    "Native preview v1 supports only finite JSON tile layers with numeric data arrays.",
  );
  if (dataValues.length !== width * height) {
    throw new TiledMcpError(
      "INVALID_TILE_DATA",
      `Layer ${located.id} data length does not match width × height.`,
      {
        layerId: located.id,
        expected: width * height,
        actual: dataValues.length,
      },
    );
  }
  for (const [index, value] of dataValues.entries()) {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 0xffffffff
    ) {
      throw new TiledMcpError(
        "INVALID_GID",
        `Layer ${located.id} contains an invalid GID.`,
        { layerId: located.id, index, gid: value },
      );
    }
  }
  const data = dataValues as number[];
  const x = readIntegerDefault(layer.x, `${located.path}.x`, 0);
  const y = readIntegerDefault(layer.y, `${located.path}.y`, 0);
  const opacity = readOpacity(layer.opacity, located.path, located.id);
  // Compute once here so extreme offsets fail before the renderer indexes.
  for (const value of [x + width, y + height, region.x + region.width, region.y + region.height]) {
    if (!Number.isSafeInteger(value)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `Layer ${located.id} coordinates exceed safe integer bounds.`,
        { layerId: located.id },
      );
    }
  }
  return {
    id: located.id,
    name: located.name,
    x,
    y,
    width,
    height,
    data,
    opacity,
  };
}

function assertGroupRenderProperties(
  layer: JsonObject,
  path: string,
  childLayerId: number,
): void {
  assertCommonRenderProperties(layer, path, childLayerId);
  for (const field of ["x", "y"] as const) {
    const value = readIntegerDefault(
      layer[field],
      `${path}.${field}`,
      0,
    );
    if (value !== 0) {
      throw unsupportedFeature(
        `group-${field}`,
        `Native preview v1 does not support a non-zero group ${field}.`,
        { childLayerId, value },
      );
    }
  }
  const opacity = readOpacity(layer.opacity, path, childLayerId);
  if (opacity !== 1) {
    throw unsupportedFeature(
      "group-opacity",
      "Native preview v1 cannot reproduce non-default group opacity without offscreen group compositing.",
      { childLayerId, opacity },
    );
  }
}

function assertLeafRenderProperties(
  layer: JsonObject,
  path: string,
  layerId: number,
): void {
  assertCommonRenderProperties(layer, path, layerId);
}

function assertCommonRenderProperties(
  layer: JsonObject,
  path: string,
  layerId: number,
): void {
  const mode = layer.mode ?? layer.blendmode ?? "normal";
  if (mode !== "normal") {
    throw unsupportedFeature(
      "blend-mode",
      `Native preview v1 does not support layer blend mode ${String(mode)}.`,
      { path, layerId, mode },
    );
  }
  if (layer.tintcolor !== undefined) {
    throw unsupportedFeature(
      "tint-color",
      "Native preview v1 does not support layer tint colors.",
      { path, layerId, tintColor: layer.tintcolor },
    );
  }
  for (const [field, fallback] of [
    ["offsetx", 0],
    ["offsety", 0],
    ["parallaxx", 1],
    ["parallaxy", 1],
  ] as const) {
    const value = layer[field] ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${path}.${field} must be a finite number.`,
        { path, layerId, field, value },
      );
    }
    if (value !== fallback) {
      throw unsupportedFeature(
        field,
        `Native preview v1 does not support non-default ${field}.`,
        { path, layerId, field, value },
      );
    }
  }
}

function readIntegerDefault(
  value: JsonValue | undefined,
  context: string,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  return expectInteger(value, context);
}

function readOpacity(
  value: JsonValue | undefined,
  path: string,
  layerId: number,
): number {
  const opacity = value ?? 1;
  if (
    typeof opacity !== "number" ||
    !Number.isFinite(opacity) ||
    opacity < 0 ||
    opacity > 1
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${path}.opacity must be between 0 and 1.`,
      { path, layerId, opacity },
    );
  }
  return opacity;
}

function collectUsedAssetIds(
  layers: readonly PreviewTileLayer[],
  region: PreviewRegion,
  ranges: readonly PreviewTilesetRange[],
): string[] {
  const used = new Set<string>();
  for (const layer of layers) {
    if (layer.opacity === 0) {
      continue;
    }
    const left = Math.max(region.x, layer.x);
    const top = Math.max(region.y, layer.y);
    const right = Math.min(region.x + region.width, layer.x + layer.width);
    const bottom = Math.min(region.y + region.height, layer.y + layer.height);
    for (let mapY = top; mapY < bottom; mapY += 1) {
      for (let mapX = left; mapX < right; mapX += 1) {
        const index = (mapY - layer.y) * layer.width + (mapX - layer.x);
        const gid = layer.data[index];
        if (gid === undefined) {
          throw new TiledMcpError(
            "INVALID_TILE_DATA",
            `Layer ${layer.id} could not be indexed at (${mapX}, ${mapY}).`,
            { layerId: layer.id, mapX, mapY },
          );
        }
        const { baseGid } = decodeGid(gid, "orthogonal");
        if (baseGid === 0) {
          continue;
        }
        const range = findRange(baseGid, ranges);
        if (range === undefined) {
          throw new TiledMcpError(
            "GID_OUT_OF_RANGE",
            `GID ${baseGid} has no tileset.`,
            { gid: baseGid, layerId: layer.id },
          );
        }
        used.add(range.assetId);
      }
    }
  }
  return ranges
    .filter((range) => used.has(range.assetId))
    .map((range) => range.assetId);
}

function boundedPreviewLabel(value: string): string {
  return value.length <= MAX_PREVIEW_LAYER_LABEL_LENGTH
    ? value
    : value.slice(0, MAX_PREVIEW_LAYER_LABEL_LENGTH);
}

function findRange(
  baseGid: number,
  ranges: readonly PreviewTilesetRange[],
): PreviewTilesetRange | undefined {
  let selected: PreviewTilesetRange | undefined;
  for (const range of ranges) {
    if (range.firstGid <= baseGid) {
      selected = range;
    } else {
      break;
    }
  }
  if (
    selected === undefined ||
    baseGid >= selected.firstGid + selected.tileCount
  ) {
    return undefined;
  }
  return selected;
}

function unsupportedFeature(
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
