import { TiledMcpError } from "../errors.js";
import {
  expectArray,
  expectInteger,
  expectObject,
  expectString,
  type JsonObject,
  type JsonValue,
} from "../formats/json.js";
import {
  projectScalarProperties,
  type ProjectedProperty,
} from "./propertyEdits.js";
import {
  parseTransparentColor,
  validateAtlasGeometry,
} from "../images/atlas.js";

export const DEFAULT_TILESET_METADATA_LIMIT = 64;
export const MAX_TILESET_METADATA_LIMIT = 128;
export const MAX_TILESET_METADATA_ENTRIES = 100_000;
export const MAX_TILESET_ANIMATION_FRAMES = 100_000;
export const MAX_TILESET_ANIMATION_FRAME_SAMPLE = 16;
export const MAX_TILESET_COLLISION_OBJECTS = 100_000;
export const MAX_TILESET_PROPERTY_ENTRIES = 100_000;
export const MAX_TILESET_WANG_SETS = 10_000;
export const MAX_TILESET_WANG_SET_SUMMARIES = 32;
export const MAX_TILESET_DETAIL_DISPLAY_CODE_POINTS = 128;
export const MAX_TILESET_DETAIL_RESULT_BYTES = 256 * 1024;

const TILESET_OBJECT_ALIGNMENTS = [
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
] as const;
const TILESET_RENDER_SIZES = ["tile", "grid"] as const;
const TILESET_FILL_MODES = ["stretch", "preserve-aspect-fit"] as const;
const TILESET_GRID_ORIENTATIONS = ["orthogonal", "isometric"] as const;

export interface SummarizeTilesetDocumentInput {
  document: JsonObject;
  path: string;
  imagePath: string;
  name: string;
  nameTruncated: boolean;
  tileCount: number;
  startTileId: number;
  limit: number;
}

interface TileMetadataSummary {
  localId: number;
  sourceIndex: number;
  className?: string;
  classNameSource?: "class" | "type";
  classNameTruncated?: true;
  probability?: number;
  properties: ProjectedProperty[];
  propertyCount: number;
  propertiesTruncated?: true;
  collision?: {
    objectCount: number;
    shapes: ProjectedCollisionShape[];
    shapesTruncated?: true;
  };
  animation?: {
    frameCount: number;
    totalDurationMs: number;
    frames: Array<{ tileId: number; durationMs: number }>;
    framesTruncated: boolean;
  };
}

interface TilesetScanBudget {
  animationFrames: number;
  collisionObjects: number;
  propertyEntries: number;
}

export interface TilesetTileClass {
  fullName: string;
  displayName: string;
  source: "type" | "class";
  truncated: boolean;
}

export type ProjectedCollisionShape =
  | {
      index: number;
      id?: number;
      shape:
        | "rectangle"
        | "point"
        | "ellipse"
        | "capsule"
        | "text";
      x: number;
      y: number;
      width: number;
      height: number;
      rotation: number;
      name?: string;
      nameTruncated?: true;
      className?: string;
      classNameTruncated?: true;
      propertyCount?: number;
      /**
       * Text collision shapes only carry their layout bounds; Tiled itself
       * draws them as plain rectangles in collision rendering.
       */
      textBoundsOnly?: true;
    }
  | {
      index: number;
      id?: number;
      shape: "polygon" | "polyline";
      x: number;
      y: number;
      rotation: number;
      points?: Array<{ x: number; y: number }>;
      pointCount: number;
      /**
       * Paths beyond the 256-point bound report their count without the
       * coordinates rather than an approximated geometry.
       */
      pointsOmitted?: true;
      name?: string;
      nameTruncated?: true;
      className?: string;
      classNameTruncated?: true;
      propertyCount?: number;
    }
  | {
      index: number;
      id?: number;
      geometryOmitted: true;
      reason: "tile-object" | "template";
      name?: string;
      nameTruncated?: true;
      className?: string;
      classNameTruncated?: true;
      propertyCount?: number;
    };

export function readTilesetTileClass(
  tile: JsonObject,
  context: string,
): TilesetTileClass | undefined {
  const field =
    tile.type !== undefined
      ? { source: "type" as const, value: tile.type }
      : tile.class !== undefined
        ? { source: "class" as const, value: tile.class }
        : undefined;
  if (field === undefined) {
    return undefined;
  }
  const name = boundedRequiredString(
    field.value,
    `${context}.${field.source}`,
  );
  return {
    fullName: expectString(field.value, `${context}.${field.source}`),
    displayName: name.value,
    source: field.source,
    truncated: name.truncated,
  };
}

export function assertAtlasTileDefinition(
  tile: JsonObject,
  path: string,
  localId: number,
): void {
  for (const field of [
    "image",
    "imagewidth",
    "imageheight",
    "x",
    "y",
    "width",
    "height",
  ]) {
    if (tile[field] !== undefined) {
      throw new TiledMcpError(
        "UNSUPPORTED_TILESET",
        "M1 tileset semantics support root-atlas tilesets without per-tile images or image subrect overrides.",
        { path, localId, field },
      );
    }
  }
}

export function summarizeTilesetDocument(
  input: SummarizeTilesetDocumentInput,
): Record<string, unknown> {
  const { document, path, imagePath, tileCount, startTileId, limit } = input;
  if (document.type !== "tileset") {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${path} is not a Tiled tileset.`,
      { path },
    );
  }
  if (
    !Number.isSafeInteger(startTileId) ||
    startTileId < 0 ||
    startTileId >= tileCount
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `startTileId must be between 0 and ${tileCount - 1}.`,
      { path, startTileId, tileCount },
    );
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_TILESET_METADATA_LIMIT
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `limit must be between 1 and ${MAX_TILESET_METADATA_LIMIT}.`,
      { limit, maxLimit: MAX_TILESET_METADATA_LIMIT },
    );
  }

  const tileWidth = positiveInteger(document.tilewidth, `${path}.tilewidth`);
  const tileHeight = positiveInteger(document.tileheight, `${path}.tileheight`);
  const declaredTileCount = positiveInteger(
    document.tilecount,
    `${path}.tilecount`,
  );
  if (declaredTileCount !== tileCount) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${path}.tilecount changed while its map binding was being summarized.`,
      { path, expectedTileCount: tileCount, actualTileCount: declaredTileCount },
    );
  }
  const columns = positiveInteger(document.columns, `${path}.columns`);
  const imageWidth = positiveInteger(
    document.imagewidth,
    `${path}.imagewidth`,
  );
  const imageHeight = positiveInteger(
    document.imageheight,
    `${path}.imageheight`,
  );
  const margin = nonNegativeInteger(document.margin ?? 0, `${path}.margin`);
  const spacing = nonNegativeInteger(document.spacing ?? 0, `${path}.spacing`);
  validateAtlasGeometry({
    imagePath,
    imageWidth,
    imageHeight,
    tileWidth,
    tileHeight,
    tileCount,
    columns,
    margin,
    spacing,
  });

  const transparentColor =
    document.transparentcolor === undefined
      ? undefined
      : expectString(
          document.transparentcolor,
          `${path}.transparentcolor`,
        );
  if (transparentColor !== undefined) {
    parseTransparentColor(transparentColor);
  }

  const properties = optionalArray(document.properties, `${path}.properties`);
  const budget: TilesetScanBudget = {
    animationFrames: 0,
    collisionObjects: 0,
    propertyEntries: properties.length,
  };
  assertBudget(
    budget.propertyEntries,
    MAX_TILESET_PROPERTY_ENTRIES,
    "property entries",
    path,
  );

  const tileValues = optionalArray(document.tiles, `${path}.tiles`);
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
  const seenTileIds = new Set<number>();
  const tileSummaries = tileValues.map((value, sourceIndex) =>
    summarizeTile(
      expectObject(value, `${path}.tiles[${sourceIndex}]`),
      sourceIndex,
      path,
      tileCount,
      seenTileIds,
      budget,
    ),
  );
  tileSummaries.sort(
    (left, right) =>
      left.localId - right.localId || left.sourceIndex - right.sourceIndex,
  );

  const eligibleTiles = tileSummaries.filter(
    ({ localId }) => localId >= startTileId,
  );
  const selectedTiles = eligibleTiles.slice(0, limit);
  const hasEarlier = tileSummaries.some(
    ({ localId }) => localId < startTileId,
  );
  const hasMore = eligibleTiles.length > selectedTiles.length;
  const nextTile = hasMore ? eligibleTiles[selectedTiles.length] : undefined;

  const wangValues = optionalArray(document.wangsets, `${path}.wangsets`);
  if (wangValues.length > MAX_TILESET_WANG_SETS) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${path} has more than ${MAX_TILESET_WANG_SETS} Wang sets.`,
      {
        path,
        actual: wangValues.length,
        limit: MAX_TILESET_WANG_SETS,
      },
    );
  }
  const wangSetSummaries = wangValues.map((value, index) =>
    summarizeWangSet(
      expectObject(value, `${path}.wangsets[${index}]`),
      index,
      path,
      budget,
    ),
  );
  const returnedWangSets = wangSetSummaries.slice(
    0,
    MAX_TILESET_WANG_SET_SUMMARIES,
  );
  const wangSetsTruncated =
    returnedWangSets.length < wangSetSummaries.length;

  const animatedTiles = tileSummaries.filter(
    ({ animation }) => animation !== undefined,
  ).length;
  const collisionTiles = tileSummaries.filter(
    ({ collision }) => collision !== undefined,
  ).length;
  const propertyTiles = tileSummaries.filter(
    ({ propertyCount }) => propertyCount > 0,
  ).length;
  const tileProperties = tileSummaries.reduce(
    (total, { propertyCount }) => total + propertyCount,
    0,
  );
  const frameSamplesTruncated = selectedTiles.some(
    ({ animation }) => animation?.framesTruncated === true,
  );
  const tileMetadataTruncated =
    hasEarlier || hasMore || selectedTiles.length !== tileSummaries.length;

  const className =
    document.class === undefined
      ? undefined
      : boundedRequiredString(document.class, `${path}.class`);

  const rendering = summarizeRendering(document, path);
  return {
    projection: {
      kind: "bounded-semantic-summary",
      classResolution: "name-only",
      tileClassField: "type-with-class-compatibility-fallback",
      properties:
        "tile-scalar-values-with-omission-markers-others-counts-only",
      collision:
        "bounded-shape-geometry-with-omission-markers",
      wangSets: "overview-only",
      sourceImage: "declared-metadata-only",
    },
    tileset: {
      path,
      name: input.name,
      ...(input.nameTruncated ? { nameTruncated: true } : {}),
      ...(className === undefined
        ? {}
        : {
            className: className.value,
            ...(className.truncated
              ? { classNameTruncated: true }
              : {}),
          }),
      tileSize: { width: tileWidth, height: tileHeight },
      tileCount,
      atlas: {
        columns,
        rows: tileCount / columns,
        margin,
        spacing,
      },
      image: {
        path: imagePath,
        declaredPixelSize: { width: imageWidth, height: imageHeight },
        ...(transparentColor === undefined
          ? {}
          : { transparentColor }),
      },
      rendering,
      propertyCount: properties.length,
      featureCounts: {
        metadataTiles: tileSummaries.length,
        animatedTiles,
        animationFrames: budget.animationFrames,
        collisionTiles,
        collisionObjects: budget.collisionObjects,
        propertyTiles,
        tileProperties,
        wangSets: wangSetSummaries.length,
      },
    },
    tileMetadata: {
      order: "local-id",
      startTileId,
      limit,
      total: tileSummaries.length,
      returned: selectedTiles.length,
      hasEarlier,
      hasMore,
      truncated: tileMetadataTruncated,
      ...(nextTile === undefined
        ? {}
        : { nextStartTileId: nextTile.localId }),
      items: selectedTiles,
    },
    wangSets: {
      order: "source",
      total: wangSetSummaries.length,
      returned: returnedWangSets.length,
      truncated: wangSetsTruncated,
      items: returnedWangSets,
    },
    truncated:
      tileMetadataTruncated || wangSetsTruncated || frameSamplesTruncated,
  };
}

export function assertTilesetDetailResultSize(result: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify({ result }), "utf8");
  if (bytes > MAX_TILESET_DETAIL_RESULT_BYTES) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Tileset details require ${bytes} bytes; limit is ${MAX_TILESET_DETAIL_RESULT_BYTES}.`,
      {
        bytes,
        limit: MAX_TILESET_DETAIL_RESULT_BYTES,
        suggestion:
          "Request a smaller tile metadata page or inspect the map summary and tileset sheet instead.",
      },
    );
  }
}

function summarizeTile(
  tile: JsonObject,
  sourceIndex: number,
  path: string,
  tileCount: number,
  seenTileIds: Set<number>,
  budget: TilesetScanBudget,
): TileMetadataSummary {
  const context = `${path}.tiles[${sourceIndex}]`;
  const localId = expectInteger(tile.id, `${context}.id`);
  if (localId < 0 || localId >= tileCount) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context}.id is outside the tileset local ID range.`,
      { path, sourceIndex, localId, tileCount },
    );
  }
  if (seenTileIds.has(localId)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${path} contains duplicate tile metadata for local ID ${localId}.`,
      { path, localId },
    );
  }
  seenTileIds.add(localId);

  assertAtlasTileDefinition(tile, path, localId);

  const tileClass = readTilesetTileClass(tile, context);
  const probability =
    tile.probability === undefined
      ? undefined
      : finiteNonNegativeNumber(
          tile.probability,
          `${context}.probability`,
        );
  const properties = optionalArray(
    tile.properties,
    `${context}.properties`,
  );
  budget.propertyEntries += properties.length;
  assertBudget(
    budget.propertyEntries,
    MAX_TILESET_PROPERTY_ENTRIES,
    "property entries",
    path,
  );
  const projectedProperties =
    projectScalarProperties(
      tile,
      `${path} tile ${localId}.properties`,
      { path, tileId: localId },
    );

  const collision =
    tile.objectgroup === undefined
      ? undefined
      : summarizeCollision(tile.objectgroup, context, path, budget);
  const animation =
    tile.animation === undefined
      ? undefined
      : summarizeAnimation(
          tile.animation,
          context,
          path,
          tileCount,
          budget,
        );

  return {
    localId,
    sourceIndex,
    ...(tileClass === undefined
      ? {}
      : {
          className: tileClass.displayName,
          classNameSource: tileClass.source,
          ...(tileClass.truncated
            ? { classNameTruncated: true as const }
            : {}),
        }),
    ...(probability === undefined ? {} : { probability }),
    properties: projectedProperties.entries,
    propertyCount: projectedProperties.total,
    ...(projectedProperties.truncated
      ? { propertiesTruncated: true as const }
      : {}),
    ...(collision === undefined ? {} : { collision }),
    ...(animation === undefined ? {} : { animation }),
  };
}

function summarizeCollision(
  value: JsonValue,
  tileContext: string,
  path: string,
  budget: TilesetScanBudget,
): NonNullable<TileMetadataSummary["collision"]> {
  const objectGroup = expectObject(
    value,
    `${tileContext}.objectgroup`,
  );
  if (objectGroup.type !== "objectgroup") {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${tileContext}.objectgroup.type must be "objectgroup".`,
      { path },
    );
  }
  const objects = expectArray(
    objectGroup.objects,
    `${tileContext}.objectgroup.objects`,
  );
  budget.collisionObjects += objects.length;
  assertBudget(
    budget.collisionObjects,
    MAX_TILESET_COLLISION_OBJECTS,
    "collision objects",
    path,
  );
  const shapes: ProjectedCollisionShape[] = [];
  let shapesTruncated = false;
  for (const [
    index,
    objectValue,
  ] of objects.entries()) {
    if (
      shapes.length >=
      MAX_PROJECTED_COLLISION_SHAPES
    ) {
      shapesTruncated = true;
      break;
    }
    shapes.push(
      projectCollisionShape(
        objectValue,
        `${tileContext}.objectgroup.objects[${index}]`,
        path,
        index,
      ),
    );
  }
  return {
    objectCount: objects.length,
    shapes,
    ...(shapesTruncated
      ? { shapesTruncated: true as const }
      : {}),
  };
}

const MAX_PROJECTED_COLLISION_SHAPES = 128;
const MAX_PROJECTED_COLLISION_PATH_POINTS = 256;
const MAX_COLLISION_COORDINATE = 1_000_000_000;
// Mirrors the native preview overlay's fail-closed collision profile; gid
// and template become omission markers here instead of hard errors so the
// read-back stays usable on files the overlay cannot render.
const COLLISION_READBACK_ALLOWED_KEYS = new Set([
  "capsule",
  "class",
  "ellipse",
  "gid",
  "height",
  "id",
  "name",
  "opacity",
  "point",
  "polygon",
  "polyline",
  "properties",
  "rotation",
  "template",
  "text",
  "type",
  "visible",
  "width",
  "x",
  "y",
]);

function projectCollisionShape(
  value: JsonValue,
  context: string,
  path: string,
  index: number,
): ProjectedCollisionShape {
  const object = expectObject(value, context);
  const unknownKey = Object.keys(object).find(
    (key) =>
      !COLLISION_READBACK_ALLOWED_KEYS.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} contains unsupported member ${unknownKey}.`,
      { path, member: unknownKey },
    );
  }
  const identity: {
    id?: number;
    name?: string;
    nameTruncated?: true;
    className?: string;
    classNameTruncated?: true;
    propertyCount?: number;
  } = {};
  if (object.id !== undefined) {
    const id = expectInteger(
      object.id,
      `${context}.id`,
    );
    if (id < 0) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.id must be nonnegative.`,
        { path, index },
      );
    }
    identity.id = id;
  }
  if (
    object.name !== undefined &&
    object.name !== ""
  ) {
    const name = boundedRequiredString(
      object.name,
      `${context}.name`,
    );
    identity.name = name.value;
    if (name.truncated) {
      identity.nameTruncated = true;
    }
  }
  const tileClass = readTilesetTileClass(
    object,
    context,
  );
  if (
    tileClass !== undefined &&
    tileClass.displayName !== ""
  ) {
    identity.className = tileClass.displayName;
    if (tileClass.truncated) {
      identity.classNameTruncated = true;
    }
  }
  if (object.properties !== undefined) {
    const properties = expectArray(
      object.properties,
      `${context}.properties`,
    );
    if (properties.length > 0) {
      identity.propertyCount = properties.length;
    }
  }
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
      return {
        index,
        ...identity,
        geometryOmitted: true,
        reason:
          feature === "gid"
            ? "tile-object"
            : "template",
      };
    }
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
      { path, index },
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
      Math.abs(raw) > MAX_COLLISION_COORDINATE
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.${field} must be a bounded finite number.`,
        { path, field },
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
      raw > MAX_COLLISION_COORDINATE
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.${field} must be a bounded nonnegative number.`,
        { path, field },
      );
    }
    return raw;
  };
  const x = readCoordinate("x");
  const y = readCoordinate("y");
  const rotation = readCoordinate("rotation");
  if (
    marker === "polygon" ||
    marker === "polyline"
  ) {
    const points = expectArray(
      object[marker],
      `${context}.${marker}`,
    );
    const minimum = marker === "polygon" ? 3 : 2;
    if (points.length < minimum) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.${marker} must contain at least ${minimum} points.`,
        { path, index },
      );
    }
    if (
      points.length >
      MAX_PROJECTED_COLLISION_PATH_POINTS
    ) {
      return {
        index,
        ...identity,
        shape: marker,
        x,
        y,
        rotation,
        pointCount: points.length,
        pointsOmitted: true,
      };
    }
    return {
      index,
      ...identity,
      shape: marker,
      x,
      y,
      rotation,
      pointCount: points.length,
      points: points.map(
        (pointValue, pointIndex) => {
          const point = expectObject(
            pointValue,
            `${context}.${marker}[${pointIndex}]`,
          );
          const px = point.x;
          const py = point.y;
          if (
            typeof px !== "number" ||
            typeof py !== "number" ||
            !Number.isFinite(px) ||
            !Number.isFinite(py) ||
            Math.abs(px) >
              MAX_COLLISION_COORDINATE ||
            Math.abs(py) >
              MAX_COLLISION_COORDINATE
          ) {
            throw new TiledMcpError(
              "INVALID_DOCUMENT",
              `${context}.${marker}[${pointIndex}] must contain bounded finite x and y.`,
              { path, index, pointIndex },
            );
          }
          return { x: px, y: py };
        },
      ),
    };
  }
  const width = readExtent("width");
  const height = readExtent("height");
  if (marker === "text") {
    expectObject(
      object.text,
      `${context}.text`,
    );
    return {
      index,
      ...identity,
      shape: "text",
      x,
      y,
      width,
      height,
      rotation,
      textBoundsOnly: true,
    };
  }
  if (marker !== undefined) {
    if (object[marker] !== true) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.${marker} must be true when present.`,
        { path, feature: marker },
      );
    }
    return {
      index,
      ...identity,
      shape: marker as
        | "point"
        | "ellipse"
        | "capsule",
      x,
      y,
      width,
      height,
      rotation,
    };
  }
  return {
    index,
    ...identity,
    shape: "rectangle",
    x,
    y,
    width,
    height,
    rotation,
  };
}

function summarizeAnimation(
  value: JsonValue,
  tileContext: string,
  path: string,
  tileCount: number,
  budget: TilesetScanBudget,
): TileMetadataSummary["animation"] {
  const frames = expectArray(value, `${tileContext}.animation`);
  budget.animationFrames += frames.length;
  assertBudget(
    budget.animationFrames,
    MAX_TILESET_ANIMATION_FRAMES,
    "animation frames",
    path,
  );

  let totalDurationMs = 0;
  const frameSummaries = frames.map((frameValue, frameIndex) => {
    const frame = expectObject(
      frameValue,
      `${tileContext}.animation[${frameIndex}]`,
    );
    const tileId = expectInteger(
      frame.tileid,
      `${tileContext}.animation[${frameIndex}].tileid`,
    );
    if (tileId < 0 || tileId >= tileCount) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${tileContext}.animation[${frameIndex}].tileid is outside the tileset local ID range.`,
        { path, tileId, tileCount },
      );
    }
    const durationMs = positiveInteger(
      frame.duration,
      `${tileContext}.animation[${frameIndex}].duration`,
    );
    totalDurationMs += durationMs;
    if (!Number.isSafeInteger(totalDurationMs)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${tileContext}.animation duration exceeds safe integer bounds.`,
        { path },
      );
    }
    return { tileId, durationMs };
  });
  return {
    frameCount: frameSummaries.length,
    totalDurationMs,
    frames: frameSummaries.slice(0, MAX_TILESET_ANIMATION_FRAME_SAMPLE),
    framesTruncated:
      frameSummaries.length > MAX_TILESET_ANIMATION_FRAME_SAMPLE,
  };
}

function summarizeWangSet(
  wangSet: JsonObject,
  index: number,
  path: string,
  budget: TilesetScanBudget,
): Record<string, unknown> {
  const context = `${path}.wangsets[${index}]`;
  const name = boundedRequiredString(wangSet.name, `${context}.name`);
  const type = expectString(wangSet.type, `${context}.type`);
  if (!["corner", "edge", "mixed"].includes(type)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context}.type must be corner, edge or mixed.`,
      { path, type },
    );
  }
  const colors = optionalArray(wangSet.colors, `${context}.colors`);
  const wangTiles = optionalArray(
    wangSet.wangtiles,
    `${context}.wangtiles`,
  );
  const properties = optionalArray(
    wangSet.properties,
    `${context}.properties`,
  );
  budget.propertyEntries += properties.length;
  assertBudget(
    budget.propertyEntries,
    MAX_TILESET_PROPERTY_ENTRIES,
    "property entries",
    path,
  );
  const className =
    wangSet.class === undefined
      ? undefined
      : boundedRequiredString(wangSet.class, `${context}.class`);
  return {
    sourceIndex: index,
    name: name.value,
    ...(name.truncated ? { nameTruncated: true } : {}),
    type,
    ...(className === undefined
      ? {}
      : {
          className: className.value,
          ...(className.truncated
            ? { classNameTruncated: true }
            : {}),
        }),
    colorCount: colors.length,
    wangTileCount: wangTiles.length,
    propertyCount: properties.length,
  };
}

function summarizeRendering(
  document: JsonObject,
  path: string,
): Record<string, unknown> {
  const objectAlignment = optionalEnumString(
    document.objectalignment,
    `${path}.objectalignment`,
    TILESET_OBJECT_ALIGNMENTS,
  );
  const tileRenderSize =
    optionalEnumString(
      document.tilerendersize,
      `${path}.tilerendersize`,
      TILESET_RENDER_SIZES,
    ) ??
    "tile";
  const fillMode =
    optionalEnumString(
      document.fillmode,
      `${path}.fillmode`,
      TILESET_FILL_MODES,
    ) ?? "stretch";
  const tileOffset =
    document.tileoffset === undefined
      ? undefined
      : summarizeTileOffset(document.tileoffset, path);
  const transformations =
    document.transformations === undefined
      ? undefined
      : summarizeTransformations(document.transformations, path);
  const grid =
    document.grid === undefined
      ? undefined
      : summarizeGrid(document.grid, path);
  return {
    ...(objectAlignment === undefined ? {} : { objectAlignment }),
    tileRenderSize,
    fillMode,
    ...(tileOffset === undefined ? {} : { tileOffset }),
    ...(transformations === undefined ? {} : { transformations }),
    ...(grid === undefined ? {} : { grid }),
  };
}

function summarizeTileOffset(
  value: JsonValue,
  path: string,
): { x: number; y: number } {
  const tileOffset = expectObject(value, `${path}.tileoffset`);
  return {
    x: expectInteger(tileOffset.x, `${path}.tileoffset.x`),
    y: expectInteger(tileOffset.y, `${path}.tileoffset.y`),
  };
}

function summarizeTransformations(
  value: JsonValue,
  path: string,
): {
  flipH: boolean;
  flipV: boolean;
  rotate: boolean;
  preferUntransformed: boolean;
} {
  const transformations = expectObject(
    value,
    `${path}.transformations`,
  );
  return {
    flipH: requiredBoolean(
      transformations.hflip,
      `${path}.transformations.hflip`,
    ),
    flipV: requiredBoolean(
      transformations.vflip,
      `${path}.transformations.vflip`,
    ),
    rotate: requiredBoolean(
      transformations.rotate,
      `${path}.transformations.rotate`,
    ),
    preferUntransformed: requiredBoolean(
      transformations.preferuntransformed,
      `${path}.transformations.preferuntransformed`,
    ),
  };
}

function summarizeGrid(
  value: JsonValue,
  path: string,
): { orientation: string; width: number; height: number } {
  const grid = expectObject(value, `${path}.grid`);
  return {
    orientation: enumString(
      grid.orientation,
      `${path}.grid.orientation`,
      TILESET_GRID_ORIENTATIONS,
    ),
    width: positiveInteger(grid.width, `${path}.grid.width`),
    height: positiveInteger(grid.height, `${path}.grid.height`),
  };
}

function optionalArray(
  value: JsonValue | undefined,
  context: string,
): JsonValue[] {
  return value === undefined ? [] : expectArray(value, context);
}

function optionalEnumString(
  value: JsonValue | undefined,
  context: string,
  allowed: readonly string[],
): string | undefined {
  return value === undefined
    ? undefined
    : enumString(value, context, allowed);
}

function enumString(
  value: JsonValue | undefined,
  context: string,
  allowed: readonly string[],
): string {
  const string = expectString(value, context);
  if (!allowed.includes(string)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must be one of: ${allowed.join(", ")}.`,
      { value: string, allowed: [...allowed] },
    );
  }
  return string;
}

function positiveInteger(
  value: JsonValue | undefined,
  context: string,
): number {
  const integer = expectInteger(value, context);
  if (integer <= 0) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must be a positive integer.`,
    );
  }
  return integer;
}

function nonNegativeInteger(
  value: JsonValue | undefined,
  context: string,
): number {
  const integer = expectInteger(value, context);
  if (integer < 0) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must be a non-negative integer.`,
    );
  }
  return integer;
}

function finiteNonNegativeNumber(
  value: JsonValue,
  context: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must be a finite non-negative number.`,
    );
  }
  return value;
}

function requiredBoolean(
  value: JsonValue | undefined,
  context: string,
): boolean {
  if (typeof value !== "boolean") {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must be a boolean.`,
    );
  }
  return value;
}

function boundedRequiredString(
  value: JsonValue | undefined,
  context: string,
): { value: string; truncated: boolean } {
  const string = expectString(value, context);
  let displayEnd = 0;
  let codePointCount = 0;
  for (const codePoint of string) {
    codePointCount += 1;
    if (codePointCount > MAX_TILESET_DETAIL_DISPLAY_CODE_POINTS) {
      return {
        value: string.slice(0, displayEnd),
        truncated: true,
      };
    }
    displayEnd += codePoint.length;
  }
  return { value: string, truncated: false };
}

function assertBudget(
  actual: number,
  limit: number,
  kind: string,
  path: string,
): void {
  if (!Number.isSafeInteger(actual) || actual > limit) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${path} exceeds the ${limit} ${kind} scan limit.`,
      { path, kind, actual, limit },
    );
  }
}
