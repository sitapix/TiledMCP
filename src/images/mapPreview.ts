import { TiledMcpError } from "../errors.js";
import { decodeGid, type OrthogonalTransform } from "../maps/gid.js";
import type {
  PreviewRegion,
  PreviewTileLayer,
} from "../maps/previewScene.js";
import { revisionOf } from "../storage/revision.js";
import {
  blitAtlasTile,
  type AtlasGeometry,
  type RgbColor,
} from "./atlas.js";
import { encodeRgbaPng, type SafeImageFormat } from "./safeImage.js";

export const MAX_NATIVE_PREVIEW_EDGE = 2_048;
export const MAX_NATIVE_PREVIEW_PIXELS = 1_500_000;
export const MAX_NATIVE_PREVIEW_BYTES = 8 * 1024 * 1024;
export const MAX_NATIVE_PREVIEW_SCALE = 4;
export const DEFAULT_NATIVE_PREVIEW_SCALE = 2;
export const MAX_NATIVE_PREVIEW_AGGREGATE_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_NATIVE_PREVIEW_AGGREGATE_DECODED_PIXELS = 16_000_000;
export const MAX_NATIVE_PREVIEW_PIXEL_BLENDS = 30_000_000;
export const MAX_NATIVE_PREVIEW_HIGHLIGHTS = 64;
export const MAX_NATIVE_PREVIEW_OBJECTS = 64;
export const MAX_NATIVE_PREVIEW_OBJECT_POINTS = 8_192;
export const MIN_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS = 12;
export const MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS = 4_096;
export const MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS_AGGREGATE =
  65_536;
export const NATIVE_PREVIEW_OBJECT_CURVE_MAX_ERROR_PIXELS =
  0.25;
export const NATIVE_PREVIEW_OBJECT_CURVE_TESSELLATION =
  "uniform-angle-output-sagitta-v1";
export const NATIVE_PREVIEW_HIGHLIGHT_STYLE = "selection-amber-v1";
export const NATIVE_PREVIEW_HIGHLIGHT_COLOR =
  Object.freeze({
    r: 250,
    g: 204,
    b: 21,
    a: 96,
  } as const);
export const NATIVE_PREVIEW_HIGHLIGHT_BLEND_MODE = "source-over";
export const NATIVE_PREVIEW_HIGHLIGHT_OVERLAP_MODE = "tile-union";
export const NATIVE_PREVIEW_OBJECT_PROFILE =
  "explicit-basic-object-geometry-v2";
export const NATIVE_PREVIEW_OBJECT_STYLE =
  "geometry-cyan-v1";
export const NATIVE_PREVIEW_OBJECT_COLOR =
  Object.freeze({
    r: 34,
    g: 211,
    b: 238,
    a: 255,
  } as const);
export const NATIVE_PREVIEW_OBJECT_STROKE_WIDTH = 1;
export const NATIVE_PREVIEW_OBJECT_ORIGIN_MARKER =
  "crosshair-5px";
export const NATIVE_PREVIEW_OBJECT_VISIBILITY_POLICY =
  "explicit-ignore-object-and-layer-visibility-opacity";
export const NATIVE_PREVIEW_OBJECT_DRAW_ORDER =
  "after-highlights-and-grid-before-coordinates";
export const NATIVE_PREVIEW_OBJECT_QUANTIZATION =
  "round-nearest-output-pixel";

const COORDINATE_GUTTER_PADDING = 2;
const COORDINATE_GLYPH_WIDTH = 3;
const COORDINATE_GLYPH_HEIGHT = 5;
const COORDINATE_GLYPH_GAP = 1;
const GUTTER_BACKGROUND: Rgba = [17, 24, 39, 255];
const COORDINATE_COLOR: Rgba = [226, 232, 240, 255];
const GRID_COLOR: Rgba = [255, 255, 255, 104];
const HIGHLIGHT_FILL_COLOR: Rgba = [
  NATIVE_PREVIEW_HIGHLIGHT_COLOR.r,
  NATIVE_PREVIEW_HIGHLIGHT_COLOR.g,
  NATIVE_PREVIEW_HIGHLIGHT_COLOR.b,
  NATIVE_PREVIEW_HIGHLIGHT_COLOR.a,
];
const OBJECT_DEBUG_COLOR: Rgba = [
  NATIVE_PREVIEW_OBJECT_COLOR.r,
  NATIVE_PREVIEW_OBJECT_COLOR.g,
  NATIVE_PREVIEW_OBJECT_COLOR.b,
  NATIVE_PREVIEW_OBJECT_COLOR.a,
];
const OBJECT_ORIGIN_MARKER_RADIUS = 2;
const MAX_ABSOLUTE_NATIVE_PREVIEW_OBJECT_NUMBER =
  1_000_000_000;

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

type Rgba = readonly [number, number, number, number];

export interface NativePreviewAtlas {
  assetId: string;
  firstGid: number;
  tileCount: number;
  rgba: Buffer;
  format: SafeImageFormat;
  geometry: AtlasGeometry;
  transparentColor?: RgbColor;
}

export interface NativePreviewOverlayInput {
  grid: boolean;
  coordinates: boolean;
  highlights?: readonly NativePreviewHighlightInput[];
  objectDebug?: readonly NativePreviewObjectInput[];
}

export interface NativePreviewHighlightInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativePreviewHighlightRenderEntry {
  sourceIndex: number;
  requestedTileRect: NativePreviewHighlightInput;
  renderedTileRect: NativePreviewHighlightInput;
  clipped: boolean;
}

export interface NativePreviewHighlightRenderMetadata {
  style: typeof NATIVE_PREVIEW_HIGHLIGHT_STYLE;
  color: typeof NATIVE_PREVIEW_HIGHLIGHT_COLOR;
  blendMode: typeof NATIVE_PREVIEW_HIGHLIGHT_BLEND_MODE;
  overlapMode: typeof NATIVE_PREVIEW_HIGHLIGHT_OVERLAP_MODE;
  highlightedTileCount: number;
  entries: readonly NativePreviewHighlightRenderEntry[];
}

export type NativePreviewObjectShape =
  | "rectangle"
  | "point"
  | "ellipse"
  | "capsule"
  | "polygon"
  | "polyline"
  | "text";

export type NativePreviewObjectRepresentation =
  | "geometry-outline"
  | "text-box-only";

export interface NativePreviewObjectPoint {
  x: number;
  y: number;
}

export interface NativePreviewObjectInput {
  sourceIndex: number;
  objectId: number;
  layerId: number;
  shape: NativePreviewObjectShape;
  representation: NativePreviewObjectRepresentation;
  x: number;
  y: number;
  rotation: number;
  width?: number;
  height?: number;
  points?: readonly NativePreviewObjectPoint[];
}

export interface NativePreviewObjectRenderEntry {
  sourceIndex: number;
  objectId: number;
  layerId: number;
  shape: NativePreviewObjectShape;
  representation: NativePreviewObjectRepresentation;
  rendered: boolean;
  clipped: boolean;
}

export interface NativePreviewObjectRenderMetadata {
  profile: typeof NATIVE_PREVIEW_OBJECT_PROFILE;
  style: typeof NATIVE_PREVIEW_OBJECT_STYLE;
  color: typeof NATIVE_PREVIEW_OBJECT_COLOR;
  strokeWidth: typeof NATIVE_PREVIEW_OBJECT_STROKE_WIDTH;
  originMarker: typeof NATIVE_PREVIEW_OBJECT_ORIGIN_MARKER;
  idLabels: false;
  visibilityPolicy:
    typeof NATIVE_PREVIEW_OBJECT_VISIBILITY_POLICY;
  drawOrder: typeof NATIVE_PREVIEW_OBJECT_DRAW_ORDER;
  quantization: typeof NATIVE_PREVIEW_OBJECT_QUANTIZATION;
  curveTessellation: {
    algorithm:
      typeof NATIVE_PREVIEW_OBJECT_CURVE_TESSELLATION;
    maximumChordErrorPixels:
      typeof NATIVE_PREVIEW_OBJECT_CURVE_MAX_ERROR_PIXELS;
    minimumSegments:
      typeof MIN_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS;
    maximumSegmentsPerObject:
      typeof MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS;
    maximumAggregateSegments:
      typeof MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS_AGGREGATE;
    segmentMultiple: 4;
    errorSpace:
      "continuous-output-before-quantization";
    overflowPolicy: "reject-whole-preview";
    offscreenPolicy:
      "conservative-rotated-bounds-skip-before-tessellation";
    capsuleConstruction:
      "two-semicircles-plus-two-straight-segments";
    degenerateExtent:
      "tiled-1.12-single-zero-line-double-zero-anchor-centered-20-map-pixel-circle";
  };
  selectedObjectCount: number;
  renderedObjectCount: number;
  entries: readonly NativePreviewObjectRenderEntry[];
}

export interface RenderNativePreviewInput {
  tileWidth: number;
  tileHeight: number;
  region: PreviewRegion;
  layers: readonly PreviewTileLayer[];
  atlases: readonly NativePreviewAtlas[];
  scale: number;
  overlays: NativePreviewOverlayInput;
  backgroundColor?: string;
}

export interface NativePreviewRender {
  png: Buffer;
  mimeType: "image/png";
  pixelSize: {
    width: number;
    height: number;
  };
  byteLength: number;
  sha256: string;
  contentPixelRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  coordinateTransform: {
    tileOrigin: { x: number; y: number };
    pixelOrigin: { x: number; y: number };
    pixelsPerTile: { x: number; y: number };
  };
  highlightOverlay: NativePreviewHighlightRenderMetadata;
  objectDebugOverlay: NativePreviewObjectRenderMetadata;
}

interface PreviewLayout {
  width: number;
  height: number;
  contentLeft: number;
  contentTop: number;
  contentWidth: number;
  contentHeight: number;
  tilePixelWidth: number;
  tilePixelHeight: number;
}

interface ResolvedNativePreviewHighlights {
  metadata: NativePreviewHighlightRenderMetadata;
  tileMask: Uint8Array;
}

interface OutputPoint {
  x: number;
  y: number;
}

interface ClippedLine {
  start: OutputPoint;
  end: OutputPoint;
  clipped: boolean;
}

interface ObjectRenderState {
  rendered: boolean;
  clipped: boolean;
}

interface PreparedObjectGeometry {
  object: NativePreviewObjectInput;
  anchor: OutputPoint;
  points: readonly OutputPoint[];
  closed: boolean;
  initiallyClipped: boolean;
}

export async function renderNativePreview(
  input: RenderNativePreviewInput,
): Promise<NativePreviewRender> {
  validateInput(input);
  const layout = computeLayout(input);
  const resolvedHighlights = resolveNativePreviewHighlights(
    input.overlays.highlights,
    input.region,
  );
  const objectDebug = validateNativePreviewObjectInputs(
    input.overlays.objectDebug,
  );
  const basePixelBlends = assertPixelBlendBudget(
    input,
    layout,
    resolvedHighlights.metadata.highlightedTileCount,
  );
  const canvas = Buffer.alloc(layout.width * layout.height * 4);
  const background = parseMapBackgroundColor(input.backgroundColor);
  if (background !== undefined) {
    fillRect(
      canvas,
      layout.width,
      0,
      0,
      layout.width,
      layout.height,
      background,
    );
  }
  if (input.overlays.coordinates) {
    fillCoordinateGutters(canvas, layout);
  }

  for (const layer of input.layers) {
    renderLayer(canvas, layout, input, layer);
  }
  renderHighlights(
    canvas,
    layout,
    input.region,
    resolvedHighlights.tileMask,
  );
  if (input.overlays.grid) {
    drawGrid(canvas, layout, input.region);
  }
  const objectDebugOverlay = renderObjectDebugOverlay(
    canvas,
    layout,
    input,
    objectDebug,
    basePixelBlends,
  );
  if (input.overlays.coordinates) {
    drawCoordinates(canvas, layout, input.region);
  }

  const png = await encodeRgbaPng(
    canvas,
    layout.width,
    layout.height,
    "native map preview",
  );
  if (png.byteLength > MAX_NATIVE_PREVIEW_BYTES) {
    throw new TiledMcpError(
      "IMAGE_TOO_LARGE",
      `The native preview is ${png.byteLength} bytes; the inline limit is ${MAX_NATIVE_PREVIEW_BYTES}. Reduce region or scale.`,
      {
        bytes: png.byteLength,
        limit: MAX_NATIVE_PREVIEW_BYTES,
        region: input.region,
        scale: input.scale,
      },
    );
  }
  return {
    png,
    mimeType: "image/png",
    pixelSize: { width: layout.width, height: layout.height },
    byteLength: png.byteLength,
    sha256: revisionOf(png),
    contentPixelRect: {
      x: layout.contentLeft,
      y: layout.contentTop,
      width: layout.contentWidth,
      height: layout.contentHeight,
    },
    coordinateTransform: {
      tileOrigin: { x: input.region.x, y: input.region.y },
      pixelOrigin: { x: layout.contentLeft, y: layout.contentTop },
      pixelsPerTile: {
        x: layout.tilePixelWidth,
        y: layout.tilePixelHeight,
      },
    },
    highlightOverlay: resolvedHighlights.metadata,
    objectDebugOverlay,
  };
}

function validateInput(input: RenderNativePreviewInput): void {
  for (const [field, value] of [
    ["tileWidth", input.tileWidth],
    ["tileHeight", input.tileHeight],
    ["scale", input.scale],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${field} must be a positive safe integer.`,
        { field, value },
      );
    }
  }
  if (input.scale > MAX_NATIVE_PREVIEW_SCALE) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `scale must not exceed ${MAX_NATIVE_PREVIEW_SCALE}.`,
      { scale: input.scale, limit: MAX_NATIVE_PREVIEW_SCALE },
    );
  }
  for (const atlas of input.atlases) {
    if (
      atlas.geometry.tileWidth !== input.tileWidth ||
      atlas.geometry.tileHeight !== input.tileHeight
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_RENDER_FEATURE",
        "Native preview v1 requires every atlas tile size to match the map grid size.",
        {
          feature: "tileset-tile-size",
          assetId: atlas.assetId,
          mapTileSize: {
            width: input.tileWidth,
            height: input.tileHeight,
          },
          tilesetTileSize: {
            width: atlas.geometry.tileWidth,
            height: atlas.geometry.tileHeight,
          },
        },
      );
    }
  }
}

export function prepareNativePreviewHighlightOverlay(
  highlights: readonly NativePreviewHighlightInput[] | undefined,
  region: PreviewRegion,
): NativePreviewHighlightRenderMetadata {
  return resolveNativePreviewHighlights(highlights, region).metadata;
}

function resolveNativePreviewHighlights(
  highlights: readonly NativePreviewHighlightInput[] | undefined,
  region: PreviewRegion,
): ResolvedNativePreviewHighlights {
  if (highlights === undefined) {
    return {
      metadata: emptyHighlightMetadata(),
      tileMask: new Uint8Array(0),
    };
  }
  if (
    !Array.isArray(highlights) ||
    highlights.length === 0 ||
    highlights.length > MAX_NATIVE_PREVIEW_HIGHLIGHTS
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `highlights must contain between 1 and ${MAX_NATIVE_PREVIEW_HIGHLIGHTS} rectangles when provided.`,
      {
        count: Array.isArray(highlights) ? highlights.length : null,
        min: 1,
        max: MAX_NATIVE_PREVIEW_HIGHLIGHTS,
      },
    );
  }

  const regionRight = checkedRectEnd(
    region.x,
    region.width,
    "region",
    "x",
  );
  const regionBottom = checkedRectEnd(
    region.y,
    region.height,
    "region",
    "y",
  );
  const entries: NativePreviewHighlightRenderEntry[] = [];
  for (const [sourceIndex, highlight] of highlights.entries()) {
    validateHighlightRect(highlight, sourceIndex);
    const requestedRight = highlight.x + highlight.width;
    const requestedBottom = highlight.y + highlight.height;
    const renderedLeft = Math.max(highlight.x, region.x);
    const renderedTop = Math.max(highlight.y, region.y);
    const renderedRight = Math.min(requestedRight, regionRight);
    const renderedBottom = Math.min(requestedBottom, regionBottom);
    if (
      renderedLeft >= renderedRight ||
      renderedTop >= renderedBottom
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `highlights[${sourceIndex}] must intersect the rendered tile region.`,
        {
          sourceIndex,
          requestedTileRect: highlight,
          tileRegion: region,
        },
      );
    }
    const requestedTileRect = {
      x: highlight.x,
      y: highlight.y,
      width: highlight.width,
      height: highlight.height,
    };
    const renderedTileRect = {
      x: renderedLeft,
      y: renderedTop,
      width: renderedRight - renderedLeft,
      height: renderedBottom - renderedTop,
    };
    const clipped =
      requestedTileRect.x !== renderedTileRect.x ||
      requestedTileRect.y !== renderedTileRect.y ||
      requestedTileRect.width !== renderedTileRect.width ||
      requestedTileRect.height !== renderedTileRect.height;
    entries.push({
      sourceIndex,
      requestedTileRect,
      renderedTileRect,
      clipped,
    });
  }
  const tileMask = buildHighlightTileMask(entries, region);
  const highlightedTileCount = countHighlightedTiles(tileMask);
  return {
    metadata: {
      style: NATIVE_PREVIEW_HIGHLIGHT_STYLE,
      color: NATIVE_PREVIEW_HIGHLIGHT_COLOR,
      blendMode: NATIVE_PREVIEW_HIGHLIGHT_BLEND_MODE,
      overlapMode: NATIVE_PREVIEW_HIGHLIGHT_OVERLAP_MODE,
      highlightedTileCount,
      entries,
    },
    tileMask,
  };
}

function emptyHighlightMetadata(): NativePreviewHighlightRenderMetadata {
  return {
    style: NATIVE_PREVIEW_HIGHLIGHT_STYLE,
    color: NATIVE_PREVIEW_HIGHLIGHT_COLOR,
    blendMode: NATIVE_PREVIEW_HIGHLIGHT_BLEND_MODE,
    overlapMode: NATIVE_PREVIEW_HIGHLIGHT_OVERLAP_MODE,
    highlightedTileCount: 0,
    entries: [],
  };
}

function buildHighlightTileMask(
  entries: readonly NativePreviewHighlightRenderEntry[],
  region: PreviewRegion,
): Uint8Array {
  const cellCount = region.width * region.height;
  if (
    !Number.isSafeInteger(cellCount) ||
    cellCount <= 0 ||
    cellCount > MAX_NATIVE_PREVIEW_PIXELS
  ) {
    throw new TiledMcpError(
      "PREVIEW_DIMENSIONS_EXCEEDED",
      "The highlight tile region exceeds the native preview work dimensions.",
      {
        region,
        maxCells: MAX_NATIVE_PREVIEW_PIXELS,
      },
    );
  }
  const differences = new Int16Array(cellCount);
  for (const entry of entries) {
    const left = entry.renderedTileRect.x - region.x;
    const top = entry.renderedTileRect.y - region.y;
    const right = left + entry.renderedTileRect.width;
    const bottom = top + entry.renderedTileRect.height;
    addHighlightDifference(differences, region.width, region.height, left, top, 1);
    addHighlightDifference(
      differences,
      region.width,
      region.height,
      right,
      top,
      -1,
    );
    addHighlightDifference(
      differences,
      region.width,
      region.height,
      left,
      bottom,
      -1,
    );
    addHighlightDifference(
      differences,
      region.width,
      region.height,
      right,
      bottom,
      1,
    );
  }

  const tileMask = new Uint8Array(cellCount);
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      const index = y * region.width + x;
      const overlap =
        (differences[index] ?? 0) +
        (x === 0 ? 0 : (differences[index - 1] ?? 0)) +
        (y === 0
          ? 0
          : (differences[index - region.width] ?? 0)) -
        (x === 0 || y === 0
          ? 0
          : (differences[index - region.width - 1] ?? 0));
      differences[index] = overlap;
      if (overlap > 0) {
        tileMask[index] = 1;
      }
    }
  }
  return tileMask;
}

function addHighlightDifference(
  differences: Int16Array,
  width: number,
  height: number,
  x: number,
  y: number,
  delta: number,
): void {
  if (x >= width || y >= height) {
    return;
  }
  const index = y * width + x;
  differences[index] = (differences[index] ?? 0) + delta;
}

function countHighlightedTiles(tileMask: Uint8Array): number {
  let count = 0;
  for (const highlighted of tileMask) {
    count += highlighted;
  }
  return count;
}

function validateHighlightRect(
  highlight: NativePreviewHighlightInput,
  sourceIndex: number,
): void {
  if (
    typeof highlight !== "object" ||
    highlight === null ||
    Array.isArray(highlight)
  ) {
    throw invalidHighlightRect(sourceIndex, null, highlight);
  }
  const keys = Object.keys(highlight).sort();
  if (keys.join(",") !== "height,width,x,y") {
    throw invalidHighlightRect(sourceIndex, "shape", highlight);
  }
  for (const field of ["x", "y", "width", "height"] as const) {
    const value = highlight[field];
    const positive = field === "width" || field === "height";
    if (
      !Number.isSafeInteger(value) ||
      (positive ? value <= 0 : value < 0)
    ) {
      throw invalidHighlightRect(sourceIndex, field, value);
    }
  }
  checkedRectEnd(
    highlight.x,
    highlight.width,
    `highlights[${sourceIndex}]`,
    "x",
  );
  checkedRectEnd(
    highlight.y,
    highlight.height,
    `highlights[${sourceIndex}]`,
    "y",
  );
}

function checkedRectEnd(
  origin: number,
  size: number,
  rect: string,
  axis: "x" | "y",
): number {
  const end = origin + size;
  if (!Number.isSafeInteger(end)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${rect} ${axis} extent exceeds the safe integer range.`,
      { rect, axis, origin, size },
    );
  }
  return end;
}

function invalidHighlightRect(
  sourceIndex: number,
  field: string | null,
  value: unknown,
): TiledMcpError {
  return new TiledMcpError(
    "INVALID_ARGUMENT",
    `highlights[${sourceIndex}] must be a strict non-negative safe tile rectangle with positive width and height.`,
    { sourceIndex, field, value },
  );
}

function validateNativePreviewObjectInputs(
  objects: readonly NativePreviewObjectInput[] | undefined,
): readonly NativePreviewObjectInput[] {
  if (objects === undefined) {
    return [];
  }
  if (
    !Array.isArray(objects) ||
    objects.length === 0 ||
    objects.length > MAX_NATIVE_PREVIEW_OBJECTS
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `objectDebug must contain between 1 and ${MAX_NATIVE_PREVIEW_OBJECTS} objects when provided.`,
      {
        count: Array.isArray(objects) ? objects.length : null,
        min: 1,
        max: MAX_NATIVE_PREVIEW_OBJECTS,
      },
    );
  }

  const seenObjectIds = new Set<number>();
  let pointCount = 0;
  for (const [index, object] of objects.entries()) {
    validateNativePreviewObjectInput(object, index);
    if (seenObjectIds.has(object.objectId)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `objectDebug contains duplicate object ID ${object.objectId}.`,
        { objectId: object.objectId, sourceIndex: index },
      );
    }
    seenObjectIds.add(object.objectId);
    pointCount += object.points?.length ?? 0;
    if (pointCount > MAX_NATIVE_PREVIEW_OBJECT_POINTS) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `Object debug geometry may contain at most ${MAX_NATIVE_PREVIEW_OBJECT_POINTS} path points.`,
        {
          actual: pointCount,
          limit: MAX_NATIVE_PREVIEW_OBJECT_POINTS,
        },
      );
    }
  }
  return objects;
}

function validateNativePreviewObjectInput(
  object: NativePreviewObjectInput,
  index: number,
): void {
  if (
    typeof object !== "object" ||
    object === null ||
    Array.isArray(object)
  ) {
    throw invalidObjectDebug(index, "shape", object);
  }
  const shapes = [
    "rectangle",
    "point",
    "ellipse",
    "capsule",
    "polygon",
    "polyline",
    "text",
  ] as const;
  if (
    typeof object.shape !== "string" ||
    !shapes.includes(
      object.shape as (typeof shapes)[number],
    )
  ) {
    throw invalidObjectDebug(index, "shape", object.shape);
  }

  const commonKeys = [
    "layerId",
    "objectId",
    "representation",
    "rotation",
    "shape",
    "sourceIndex",
    "x",
    "y",
  ];
  const shapeKeys =
    object.shape === "rectangle" ||
    object.shape === "ellipse" ||
    object.shape === "capsule" ||
    object.shape === "text"
      ? ["height", "width"]
      : object.shape === "polygon" ||
          object.shape === "polyline"
        ? ["points"]
        : [];
  const expectedKeys = [...commonKeys, ...shapeKeys].sort();
  if (
    Object.keys(object).sort().join(",") !==
    expectedKeys.join(",")
  ) {
    throw invalidObjectDebug(index, "shape", object);
  }

  if (
    !Number.isSafeInteger(object.sourceIndex) ||
    object.sourceIndex !== index
  ) {
    throw invalidObjectDebug(
      index,
      "sourceIndex",
      object.sourceIndex,
    );
  }
  for (const field of ["objectId", "layerId"] as const) {
    const value = object[field];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw invalidObjectDebug(index, field, value);
    }
  }
  for (const field of ["x", "y", "rotation"] as const) {
    validateObjectDebugNumber(object[field], index, field, false);
  }

  const expectedRepresentation =
    object.shape === "text"
      ? "text-box-only"
      : "geometry-outline";
  if (object.representation !== expectedRepresentation) {
    throw invalidObjectDebug(
      index,
      "representation",
      object.representation,
    );
  }

  if (
    object.shape === "rectangle" ||
    object.shape === "ellipse" ||
    object.shape === "capsule" ||
    object.shape === "text"
  ) {
    validateObjectDebugNumber(
      object.width,
      index,
      "width",
      true,
    );
    validateObjectDebugNumber(
      object.height,
      index,
      "height",
      true,
    );
    return;
  }
  if (
    object.shape !== "polygon" &&
    object.shape !== "polyline"
  ) {
    return;
  }
  if (!Array.isArray(object.points)) {
    throw invalidObjectDebug(index, "points", object.points);
  }
  const minimum =
    object.shape === "polygon" ? 3 : 2;
  if (
    object.points.length < minimum ||
    object.points.length >
      MAX_NATIVE_PREVIEW_OBJECT_POINTS
  ) {
    throw invalidObjectDebug(index, "points", object.points.length);
  }
  for (const [pointIndex, point] of object.points.entries()) {
    if (
      typeof point !== "object" ||
      point === null ||
      Array.isArray(point) ||
      Object.keys(point).sort().join(",") !== "x,y"
    ) {
      throw invalidObjectDebug(
        index,
        `points[${pointIndex}]`,
        point,
      );
    }
    validateObjectDebugNumber(
      point.x,
      index,
      `points[${pointIndex}].x`,
      false,
    );
    validateObjectDebugNumber(
      point.y,
      index,
      `points[${pointIndex}].y`,
      false,
    );
  }
}

function validateObjectDebugNumber(
  value: unknown,
  sourceIndex: number,
  field: string,
  nonnegative: boolean,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) >
      MAX_ABSOLUTE_NATIVE_PREVIEW_OBJECT_NUMBER ||
    (nonnegative && value < 0)
  ) {
    throw invalidObjectDebug(sourceIndex, field, value);
  }
}

function invalidObjectDebug(
  sourceIndex: number,
  field: string,
  value: unknown,
): TiledMcpError {
  return new TiledMcpError(
    "INVALID_ARGUMENT",
    `objectDebug[${sourceIndex}] is not a strict supported object geometry.`,
    { sourceIndex, field, value },
  );
}

function computeLayout(input: RenderNativePreviewInput): PreviewLayout {
  const tilePixelWidth = input.tileWidth * input.scale;
  const tilePixelHeight = input.tileHeight * input.scale;
  const contentWidth = input.region.width * tilePixelWidth;
  const contentHeight = input.region.height * tilePixelHeight;
  if (
    !Number.isSafeInteger(tilePixelWidth) ||
    !Number.isSafeInteger(tilePixelHeight) ||
    !Number.isSafeInteger(contentWidth) ||
    !Number.isSafeInteger(contentHeight)
  ) {
    throw previewDimensionsExceeded(input, null, null);
  }

  let contentLeft = 0;
  let contentTop = 0;
  if (input.overlays.coordinates) {
    const largestY = input.region.y + input.region.height - 1;
    const widestYLabel = glyphStringWidth(String(largestY));
    contentLeft = widestYLabel + COORDINATE_GUTTER_PADDING * 2;
    contentTop =
      COORDINATE_GLYPH_HEIGHT + COORDINATE_GUTTER_PADDING * 2;

    const largestX = input.region.x + input.region.width - 1;
    const widestXLabel = glyphStringWidth(String(largestX));
    if (
      widestXLabel + COORDINATE_GUTTER_PADDING * 2 > tilePixelWidth ||
      COORDINATE_GLYPH_HEIGHT + COORDINATE_GUTTER_PADDING * 2 >
        tilePixelHeight
    ) {
      throw new TiledMcpError(
        "OVERLAY_TOO_DENSE",
        "Absolute coordinate labels do not fit inside the scaled tile cadence. Increase scale or use a smaller-coordinate region.",
        {
          region: input.region,
          scale: input.scale,
          tilePixelSize: {
            width: tilePixelWidth,
            height: tilePixelHeight,
          },
          requiredLabelSize: {
            width: widestXLabel + COORDINATE_GUTTER_PADDING * 2,
            height:
              COORDINATE_GLYPH_HEIGHT + COORDINATE_GUTTER_PADDING * 2,
          },
        },
      );
    }
  }
  const width = contentLeft + contentWidth;
  const height = contentTop + contentHeight;
  assertOutputBudget(input, width, height);
  return {
    width,
    height,
    contentLeft,
    contentTop,
    contentWidth,
    contentHeight,
    tilePixelWidth,
    tilePixelHeight,
  };
}

function assertOutputBudget(
  input: RenderNativePreviewInput,
  width: number,
  height: number,
): void {
  const pixels = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_NATIVE_PREVIEW_EDGE ||
    height > MAX_NATIVE_PREVIEW_EDGE ||
    !Number.isSafeInteger(pixels) ||
    pixels > MAX_NATIVE_PREVIEW_PIXELS
  ) {
    throw previewDimensionsExceeded(input, width, height);
  }
}

function assertPixelBlendBudget(
  input: RenderNativePreviewInput,
  layout: PreviewLayout,
  highlightedTileCount: number,
): number {
  const pixelsPerTile =
    layout.tilePixelWidth * layout.tilePixelHeight;
  if (!Number.isSafeInteger(pixelsPerTile) || pixelsPerTile <= 0) {
    throw previewDimensionsExceeded(input, layout.width, layout.height);
  }
  const maximumTileDraws = Math.floor(
    MAX_NATIVE_PREVIEW_PIXEL_BLENDS / pixelsPerTile,
  );
  let tileDraws = 0;
  const highlightPixelBlends = highlightedTileCount * pixelsPerTile;
  if (
    !Number.isSafeInteger(highlightPixelBlends) ||
    highlightPixelBlends > MAX_NATIVE_PREVIEW_PIXEL_BLENDS
  ) {
    throw previewPixelBlendBudgetExceeded({
      tileDraws,
      pixelsPerTile,
      highlightPixelBlends,
    });
  }
  for (const layer of input.layers) {
    if (layer.opacity === 0) {
      continue;
    }
    const left = Math.max(input.region.x, layer.x);
    const top = Math.max(input.region.y, layer.y);
    const right = Math.min(
      input.region.x + input.region.width,
      layer.x + layer.width,
    );
    const bottom = Math.min(
      input.region.y + input.region.height,
      layer.y + layer.height,
    );
    for (let mapY = top; mapY < bottom; mapY += 1) {
      for (let mapX = left; mapX < right; mapX += 1) {
        const index =
          (mapY - layer.y) * layer.width + (mapX - layer.x);
        const gid = layer.data[index];
        if (gid === undefined) {
          throw new TiledMcpError(
            "INVALID_TILE_DATA",
            `Layer ${layer.id} could not be indexed at (${mapX}, ${mapY}).`,
            { layerId: layer.id, mapX, mapY },
          );
        }
        if (gid !== 0) {
          tileDraws += 1;
          if (
            tileDraws > maximumTileDraws ||
            tileDraws * pixelsPerTile + highlightPixelBlends >
              MAX_NATIVE_PREVIEW_PIXEL_BLENDS
          ) {
            throw previewPixelBlendBudgetExceeded({
              tileDraws,
              pixelsPerTile,
              highlightPixelBlends,
            });
          }
        }
      }
    }
  }
  return tileDraws * pixelsPerTile + highlightPixelBlends;
}

function previewPixelBlendBudgetExceeded(input: {
  tileDraws: number;
  pixelsPerTile: number;
  highlightPixelBlends: number;
}): TiledMcpError {
  const tilePixelBlends = input.tileDraws * input.pixelsPerTile;
  return new TiledMcpError(
    "RESULT_LIMIT_EXCEEDED",
    `The preview exceeds the ${MAX_NATIVE_PREVIEW_PIXEL_BLENDS} pixel-blend work limit. Reduce region, layers, highlights or scale.`,
    {
      tileDraws: input.tileDraws,
      pixelsPerTile: input.pixelsPerTile,
      tilePixelBlends,
      highlightPixelBlends: input.highlightPixelBlends,
      pixelBlends: tilePixelBlends + input.highlightPixelBlends,
      limit: MAX_NATIVE_PREVIEW_PIXEL_BLENDS,
    },
  );
}

function previewDimensionsExceeded(
  input: RenderNativePreviewInput,
  width: number | null,
  height: number | null,
): TiledMcpError {
  return new TiledMcpError(
    "PREVIEW_DIMENSIONS_EXCEEDED",
    "The requested native preview exceeds its output dimensions. Reduce region or scale.",
    {
      region: input.region,
      scale: input.scale,
      requestedPixelSize:
        width === null || height === null ? null : { width, height },
      maxEdge: MAX_NATIVE_PREVIEW_EDGE,
      maxPixels: MAX_NATIVE_PREVIEW_PIXELS,
    },
  );
}

function renderLayer(
  canvas: Buffer,
  layout: PreviewLayout,
  input: RenderNativePreviewInput,
  layer: PreviewTileLayer,
): void {
  if (layer.opacity === 0) {
    return;
  }
  const left = Math.max(input.region.x, layer.x);
  const top = Math.max(input.region.y, layer.y);
  const right = Math.min(
    input.region.x + input.region.width,
    layer.x + layer.width,
  );
  const bottom = Math.min(
    input.region.y + input.region.height,
    layer.y + layer.height,
  );
  for (let mapY = top; mapY < bottom; mapY += 1) {
    for (let mapX = left; mapX < right; mapX += 1) {
      const index = (mapY - layer.y) * layer.width + (mapX - layer.x);
      const gid = layer.data[index];
      if (gid === undefined || gid === 0) {
        continue;
      }
      const decoded = decodeGid(gid, "orthogonal");
      if (decoded.baseGid === 0) {
        continue;
      }
      const atlas = findAtlas(decoded.baseGid, input.atlases);
      if (atlas === undefined) {
        throw new TiledMcpError(
          "GID_OUT_OF_RANGE",
          `GID ${decoded.baseGid} has no loaded atlas source.`,
          { gid: decoded.baseGid, layerId: layer.id },
        );
      }
      const transform = decoded.transform as OrthogonalTransform;
      if (
        transform.flipD &&
        input.tileWidth !== input.tileHeight
      ) {
        throw new TiledMcpError(
          "UNSUPPORTED_RENDER_FEATURE",
          "Native preview v1 does not support diagonal flips for non-square tiles.",
          {
            feature: "non-square-diagonal-flip",
            layerId: layer.id,
            gid,
            tileSize: {
              width: input.tileWidth,
              height: input.tileHeight,
            },
          },
        );
      }
      const localId = decoded.baseGid - atlas.firstGid;
      blitAtlasTile({
        sourceRgba: atlas.rgba,
        sourceWidth: atlas.geometry.imageWidth,
        atlas: atlas.geometry,
        localId,
        destinationRgba: canvas,
        destinationWidth: layout.width,
        destinationLeft:
          layout.contentLeft +
          (mapX - input.region.x) * layout.tilePixelWidth,
        destinationTop:
          layout.contentTop +
          (mapY - input.region.y) * layout.tilePixelHeight,
        scale: input.scale,
        transform: {
          flipH: transform.flipH,
          flipV: transform.flipV,
          flipD: transform.flipD,
        },
        opacity: layer.opacity,
        ...(atlas.transparentColor === undefined
          ? {}
          : { transparentColor: atlas.transparentColor }),
      });
    }
  }
}

function renderHighlights(
  canvas: Buffer,
  layout: PreviewLayout,
  region: PreviewRegion,
  tileMask: Uint8Array,
): void {
  if (tileMask.length === 0) {
    return;
  }
  for (let row = 0; row < region.height; row += 1) {
    let column = 0;
    while (column < region.width) {
      const index = row * region.width + column;
      if (tileMask[index] !== 1) {
        column += 1;
        continue;
      }
      const runStart = column;
      while (
        column < region.width &&
        tileMask[row * region.width + column] === 1
      ) {
        column += 1;
      }
      blendLine(
        canvas,
        layout.width,
        layout.contentLeft + runStart * layout.tilePixelWidth,
        layout.contentTop + row * layout.tilePixelHeight,
        (column - runStart) * layout.tilePixelWidth,
        layout.tilePixelHeight,
        HIGHLIGHT_FILL_COLOR,
      );
    }
  }
}

function renderObjectDebugOverlay(
  canvas: Buffer,
  layout: PreviewLayout,
  input: RenderNativePreviewInput,
  objects: readonly NativePreviewObjectInput[],
  basePixelBlends: number,
): NativePreviewObjectRenderMetadata {
  if (objects.length === 0) {
    return emptyObjectDebugMetadata();
  }

  let aggregateCurveSegments = 0;
  const preparedObjects: PreparedObjectGeometry[] =
    objects.map((object) => {
      const anchor = mapObjectPointToOutput(
        object,
        { x: 0, y: 0 },
        input,
        layout,
      );
      const geometryIsOffscreen =
        isCurveObject(object) &&
        objectCurveBoundsAreFullyOffscreen(
          object,
          input,
          layout,
        );
      const geometry = geometryIsOffscreen
        ? {
            points:
              [] as readonly NativePreviewObjectPoint[],
            closed: false,
            curveSegments: 0,
          }
        : objectGeometry(
            object,
            input.scale,
          );
      aggregateCurveSegments +=
        geometry.curveSegments;
      if (
        aggregateCurveSegments >
        MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS_AGGREGATE
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `Object debug curves may contain at most ${MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS_AGGREGATE} generated segments.`,
          {
            actual: aggregateCurveSegments,
            limit:
              MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS_AGGREGATE,
            sourceIndex: object.sourceIndex,
            objectId: object.objectId,
          },
        );
      }
      return {
        object,
        anchor,
        points: geometry.points.map((point) =>
          mapObjectPointToOutput(
            object,
            point,
            input,
            layout,
          ),
        ),
        closed: geometry.closed,
        initiallyClipped:
          geometryIsOffscreen,
      };
    });

  let objectPixelWrites = 0;
  const entries: NativePreviewObjectRenderEntry[] = [];
  const writePixel = (
    x: number,
    y: number,
    state: ObjectRenderState,
  ): void => {
    const left = layout.contentLeft;
    const top = layout.contentTop;
    const right =
      layout.contentLeft + layout.contentWidth - 1;
    const bottom =
      layout.contentTop + layout.contentHeight - 1;
    if (
      x < left ||
      x > right ||
      y < top ||
      y > bottom
    ) {
      state.clipped = true;
      return;
    }
    if (
      basePixelBlends + objectPixelWrites + 1 >
      MAX_NATIVE_PREVIEW_PIXEL_BLENDS
    ) {
      throw objectDebugPixelBudgetExceeded(
        basePixelBlends,
        objectPixelWrites + 1,
      );
    }
    objectPixelWrites += 1;
    state.rendered = true;
    setPixel(
      canvas,
      layout.width,
      x,
      y,
      OBJECT_DEBUG_COLOR,
    );
  };

  for (const prepared of preparedObjects) {
    const { object } = prepared;
    const state: ObjectRenderState = {
      rendered: false,
      clipped: prepared.initiallyClipped,
    };
    const segmentCount = prepared.closed
      ? prepared.points.length
      : Math.max(0, prepared.points.length - 1);
    for (
      let segmentIndex = 0;
      segmentIndex < segmentCount;
      segmentIndex += 1
    ) {
      const start = prepared.points[segmentIndex];
      const end =
        prepared.points[
          (segmentIndex + 1) %
            prepared.points.length
        ];
      if (start === undefined || end === undefined) {
        throw new TiledMcpError(
          "INTERNAL_ERROR",
          "Object debug geometry lost a line endpoint.",
          {
            objectId: object.objectId,
            segmentIndex,
          },
        );
      }
      drawClippedObjectLine(
        start,
        end,
        layout,
        state,
        writePixel,
      );
    }
    drawObjectOriginMarker(
      prepared.anchor,
      state,
      writePixel,
    );
    entries.push({
      sourceIndex: object.sourceIndex,
      objectId: object.objectId,
      layerId: object.layerId,
      shape: object.shape,
      representation: object.representation,
      rendered: state.rendered,
      clipped: state.clipped,
    });
  }

  return {
    ...objectDebugMetadataBase(),
    selectedObjectCount: objects.length,
    renderedObjectCount: entries.filter(
      (entry) => entry.rendered,
    ).length,
    entries,
  };
}

function emptyObjectDebugMetadata(): NativePreviewObjectRenderMetadata {
  return {
    ...objectDebugMetadataBase(),
    selectedObjectCount: 0,
    renderedObjectCount: 0,
    entries: [],
  };
}

function objectDebugMetadataBase(): Omit<
  NativePreviewObjectRenderMetadata,
  "selectedObjectCount" | "renderedObjectCount" | "entries"
> {
  return {
    profile: NATIVE_PREVIEW_OBJECT_PROFILE,
    style: NATIVE_PREVIEW_OBJECT_STYLE,
    color: NATIVE_PREVIEW_OBJECT_COLOR,
    strokeWidth: NATIVE_PREVIEW_OBJECT_STROKE_WIDTH,
    originMarker: NATIVE_PREVIEW_OBJECT_ORIGIN_MARKER,
    idLabels: false,
    visibilityPolicy:
      NATIVE_PREVIEW_OBJECT_VISIBILITY_POLICY,
    drawOrder: NATIVE_PREVIEW_OBJECT_DRAW_ORDER,
    quantization: NATIVE_PREVIEW_OBJECT_QUANTIZATION,
    curveTessellation: {
      algorithm:
        NATIVE_PREVIEW_OBJECT_CURVE_TESSELLATION,
      maximumChordErrorPixels:
        NATIVE_PREVIEW_OBJECT_CURVE_MAX_ERROR_PIXELS,
      minimumSegments:
        MIN_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
      maximumSegmentsPerObject:
        MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
      maximumAggregateSegments:
        MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS_AGGREGATE,
      segmentMultiple: 4,
      errorSpace:
        "continuous-output-before-quantization",
      overflowPolicy: "reject-whole-preview",
      offscreenPolicy:
        "conservative-rotated-bounds-skip-before-tessellation",
      capsuleConstruction:
        "two-semicircles-plus-two-straight-segments",
      degenerateExtent:
        "tiled-1.12-single-zero-line-double-zero-anchor-centered-20-map-pixel-circle",
    },
  };
}

function isCurveObject(
  object: NativePreviewObjectInput,
): object is NativePreviewObjectInput & {
  shape: "ellipse" | "capsule";
  width: number;
  height: number;
} {
  return (
    object.shape === "ellipse" ||
    object.shape === "capsule"
  );
}

function objectCurveBoundsAreFullyOffscreen(
  object: NativePreviewObjectInput & {
    shape: "ellipse" | "capsule";
    width: number;
    height: number;
  },
  input: RenderNativePreviewInput,
  layout: PreviewLayout,
): boolean {
  const doubleZero =
    object.width === 0 && object.height === 0;
  const left = doubleZero ? -10 : 0;
  const top = doubleZero ? -10 : 0;
  const right = doubleZero ? 10 : object.width;
  const bottom = doubleZero ? 10 : object.height;
  const corners = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ].map((point) =>
    mapObjectPointToOutput(
      object,
      point,
      input,
      layout,
    ),
  );
  const minimumX = Math.min(
    ...corners.map((point) => point.x),
  );
  const maximumX = Math.max(
    ...corners.map((point) => point.x),
  );
  const minimumY = Math.min(
    ...corners.map((point) => point.y),
  );
  const maximumY = Math.max(
    ...corners.map((point) => point.y),
  );
  const contentLeft = layout.contentLeft;
  const contentTop = layout.contentTop;
  const contentRight =
    contentLeft + layout.contentWidth - 1;
  const contentBottom =
    contentTop + layout.contentHeight - 1;
  const quantizationMargin = 1;
  return (
    maximumX <
      contentLeft - quantizationMargin ||
    minimumX >
      contentRight + quantizationMargin ||
    maximumY <
      contentTop - quantizationMargin ||
    minimumY >
      contentBottom + quantizationMargin
  );
}

function objectGeometry(
  object: NativePreviewObjectInput,
  scale: number,
): {
  points: readonly NativePreviewObjectPoint[];
  closed: boolean;
  curveSegments: number;
} {
  if (
    object.shape === "polygon" ||
    object.shape === "polyline"
  ) {
    return {
      points: object.points ?? [],
      closed: object.shape === "polygon",
      curveSegments: 0,
    };
  }
  if (
    object.shape === "rectangle" ||
    object.shape === "text"
  ) {
    const width = object.width ?? 0;
    const height = object.height ?? 0;
    return {
      points: rectangleGeometryPoints(
        width,
        height,
      ),
      closed: true,
      curveSegments: 0,
    };
  }
  if (
    object.shape === "ellipse" ||
    object.shape === "capsule"
  ) {
    const width = object.width ?? 0;
    const height = object.height ?? 0;
    if (width === 0 && height === 0) {
      const curveSegments = objectCurveSegmentCount(
        10 * scale,
        object,
      );
      return {
        points: ellipseGeometryPoints(
          20,
          20,
          curveSegments,
          -10,
          -10,
        ),
        closed: true,
        curveSegments,
      };
    }
    if (width === 0 || height === 0) {
      return {
        points: [
          { x: 0, y: 0 },
          { x: width, y: height },
        ],
        closed: false,
        curveSegments: 0,
      };
    }
    const curveRadius =
      object.shape === "ellipse"
        ? (Math.max(width, height) * scale) / 2
        : (Math.min(width, height) * scale) / 2;
    const curveSegments = objectCurveSegmentCount(
      curveRadius,
      object,
    );
    return {
      points:
        object.shape === "ellipse"
          ? ellipseGeometryPoints(
              width,
              height,
              curveSegments,
            )
          : capsuleGeometryPoints(
              width,
              height,
              curveSegments,
            ),
      closed: true,
      curveSegments,
    };
  }
  return {
    points: [],
    closed: false,
    curveSegments: 0,
  };
}

function rectangleGeometryPoints(
  width: number,
  height: number,
): readonly NativePreviewObjectPoint[] {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

function objectCurveSegmentCount(
  radiusInOutputPixels: number,
  object: NativePreviewObjectInput,
): number {
  if (
    !Number.isFinite(radiusInOutputPixels) ||
    radiusInOutputPixels < 0
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `Object ${object.objectId} curve radius is not a finite nonnegative output distance.`,
      {
        objectId: object.objectId,
        radiusInOutputPixels,
      },
    );
  }
  if (radiusInOutputPixels === 0) {
    return MIN_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS;
  }
  const cosine =
    1 -
    NATIVE_PREVIEW_OBJECT_CURVE_MAX_ERROR_PIXELS /
      radiusInOutputPixels;
  const required =
    cosine <= -1
      ? 1
      : Math.ceil(
          Math.PI /
            Math.acos(Math.min(1, cosine)),
        );
  const roundedToQuadrants =
    Math.ceil(
      Math.max(
        MIN_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
        required,
      ) / 4,
    ) * 4;
  if (
    !Number.isSafeInteger(roundedToQuadrants) ||
    roundedToQuadrants >
      MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Object ${object.objectId} needs too many curve segments for the native preview error bound.`,
      {
        objectId: object.objectId,
        shape: object.shape,
        radiusInOutputPixels,
        requiredSegments: roundedToQuadrants,
        limit:
          MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
        maximumChordErrorPixels:
          NATIVE_PREVIEW_OBJECT_CURVE_MAX_ERROR_PIXELS,
      },
    );
  }
  return roundedToQuadrants;
}

function ellipseGeometryPoints(
  width: number,
  height: number,
  segmentCount: number,
  originX = 0,
  originY = 0,
): readonly NativePreviewObjectPoint[] {
  const centerX = originX + width / 2;
  const centerY = originY + height / 2;
  const radiusX = width / 2;
  const radiusY = height / 2;
  return Array.from(
    { length: segmentCount },
    (_, index) => {
      const angle =
        (index * Math.PI * 2) / segmentCount;
      return {
        x: centerX + radiusX * Math.cos(angle),
        y: centerY + radiusY * Math.sin(angle),
      };
    },
  );
}

function capsuleGeometryPoints(
  width: number,
  height: number,
  curveSegmentCount: number,
): readonly NativePreviewObjectPoint[] {
  const radius = Math.min(width, height) / 2;
  if (width === height) {
    return ellipseGeometryPoints(
      width,
      height,
      curveSegmentCount,
    );
  }
  const halfSegments = curveSegmentCount / 2;
  const points: NativePreviewObjectPoint[] = [];
  const arcs =
    width > height
      ? ([
          {
            centerX: width - radius,
            centerY: radius,
            startAngle: -Math.PI / 2,
          },
          {
            centerX: radius,
            centerY: radius,
            startAngle: Math.PI / 2,
          },
        ] as const)
      : ([
          {
            centerX: radius,
            centerY: radius,
            startAngle: Math.PI,
          },
          {
            centerX: radius,
            centerY: height - radius,
            startAngle: 0,
          },
        ] as const);
  for (const arc of arcs) {
    for (
      let segment = 0;
      segment <= halfSegments;
      segment += 1
    ) {
      const angle =
        arc.startAngle +
        (segment * Math.PI) /
          halfSegments;
      points.push({
        x:
          arc.centerX +
          radius * Math.cos(angle),
        y:
          arc.centerY +
          radius * Math.sin(angle),
      });
    }
  }
  return points;
}

function mapObjectPointToOutput(
  object: NativePreviewObjectInput,
  point: NativePreviewObjectPoint,
  input: RenderNativePreviewInput,
  layout: PreviewLayout,
): OutputPoint {
  const normalizedRotation =
    ((object.rotation % 360) + 360) % 360;
  const radians =
    (normalizedRotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const mapX =
    object.x +
    point.x * cosine -
    point.y * sine;
  const mapY =
    object.y +
    point.x * sine +
    point.y * cosine;
  const regionPixelX =
    input.region.x * input.tileWidth;
  const regionPixelY =
    input.region.y * input.tileHeight;
  const x =
    layout.contentLeft +
    (mapX - regionPixelX) * input.scale;
  const y =
    layout.contentTop +
    (mapY - regionPixelY) * input.scale;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `Object ${object.objectId} geometry exceeds finite preview coordinates.`,
      { objectId: object.objectId },
    );
  }
  return { x, y };
}

function drawClippedObjectLine(
  start: OutputPoint,
  end: OutputPoint,
  layout: PreviewLayout,
  state: ObjectRenderState,
  writePixel: (
    x: number,
    y: number,
    state: ObjectRenderState,
  ) => void,
): void {
  const clipped = clipLineToContent(
    start,
    end,
    layout,
  );
  if (clipped === undefined) {
    state.clipped = true;
    return;
  }
  state.clipped ||= clipped.clipped;
  let x = Math.round(clipped.start.x);
  let y = Math.round(clipped.start.y);
  const endX = Math.round(clipped.end.x);
  const endY = Math.round(clipped.end.y);
  const deltaX = Math.abs(endX - x);
  const stepX = x < endX ? 1 : -1;
  const deltaY = -Math.abs(endY - y);
  const stepY = y < endY ? 1 : -1;
  let error = deltaX + deltaY;
  while (true) {
    writePixel(x, y, state);
    if (x === endX && y === endY) {
      break;
    }
    const doubledError = error * 2;
    if (doubledError >= deltaY) {
      error += deltaY;
      x += stepX;
    }
    if (doubledError <= deltaX) {
      error += deltaX;
      y += stepY;
    }
  }
}

function clipLineToContent(
  start: OutputPoint,
  end: OutputPoint,
  layout: PreviewLayout,
): ClippedLine | undefined {
  const left = layout.contentLeft;
  const top = layout.contentTop;
  const right =
    layout.contentLeft + layout.contentWidth - 1;
  const bottom =
    layout.contentTop + layout.contentHeight - 1;
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  let minimum = 0;
  let maximum = 1;
  for (const [p, q] of [
    [-deltaX, start.x - left],
    [deltaX, right - start.x],
    [-deltaY, start.y - top],
    [deltaY, bottom - start.y],
  ] as const) {
    if (p === 0) {
      if (q < 0) {
        return undefined;
      }
      continue;
    }
    const ratio = q / p;
    if (p < 0) {
      if (ratio > maximum) {
        return undefined;
      }
      minimum = Math.max(minimum, ratio);
    } else {
      if (ratio < minimum) {
        return undefined;
      }
      maximum = Math.min(maximum, ratio);
    }
  }
  return {
    start: {
      x: start.x + minimum * deltaX,
      y: start.y + minimum * deltaY,
    },
    end: {
      x: start.x + maximum * deltaX,
      y: start.y + maximum * deltaY,
    },
    clipped: minimum > 0 || maximum < 1,
  };
}

function drawObjectOriginMarker(
  anchor: OutputPoint,
  state: ObjectRenderState,
  writePixel: (
    x: number,
    y: number,
    state: ObjectRenderState,
  ) => void,
): void {
  const centerX = Math.round(anchor.x);
  const centerY = Math.round(anchor.y);
  for (
    let delta = -OBJECT_ORIGIN_MARKER_RADIUS;
    delta <= OBJECT_ORIGIN_MARKER_RADIUS;
    delta += 1
  ) {
    writePixel(
      centerX + delta,
      centerY,
      state,
    );
    if (delta !== 0) {
      writePixel(
        centerX,
        centerY + delta,
        state,
      );
    }
  }
}

function objectDebugPixelBudgetExceeded(
  basePixelBlends: number,
  objectPixelWrites: number,
): TiledMcpError {
  return new TiledMcpError(
    "RESULT_LIMIT_EXCEEDED",
    `The preview exceeds the ${MAX_NATIVE_PREVIEW_PIXEL_BLENDS} pixel-blend work limit. Reduce region, layers, highlights, objectIds or scale.`,
    {
      basePixelBlends,
      objectPixelWrites,
      pixelBlends:
        basePixelBlends + objectPixelWrites,
      limit: MAX_NATIVE_PREVIEW_PIXEL_BLENDS,
    },
  );
}

function findAtlas(
  baseGid: number,
  atlases: readonly NativePreviewAtlas[],
): NativePreviewAtlas | undefined {
  let selected: NativePreviewAtlas | undefined;
  for (const atlas of atlases) {
    if (atlas.firstGid <= baseGid) {
      selected = atlas;
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

function parseMapBackgroundColor(value: string | undefined): Rgba | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (/^#[0-9a-f]{6}$/iu.test(value)) {
    return [
      Number.parseInt(value.slice(1, 3), 16),
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16),
      255,
    ];
  }
  if (/^#[0-9a-f]{8}$/iu.test(value)) {
    return [
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16),
      Number.parseInt(value.slice(7, 9), 16),
      Number.parseInt(value.slice(1, 3), 16),
    ];
  }
  throw new TiledMcpError(
    "INVALID_DOCUMENT",
    "Map backgroundcolor must use Tiled #RRGGBB or #AARRGGBB notation.",
    { backgroundColor: value },
  );
}

function fillCoordinateGutters(
  canvas: Buffer,
  layout: PreviewLayout,
): void {
  if (layout.contentTop > 0) {
    fillRect(
      canvas,
      layout.width,
      0,
      0,
      layout.width,
      layout.contentTop,
      GUTTER_BACKGROUND,
    );
  }
  if (layout.contentLeft > 0) {
    fillRect(
      canvas,
      layout.width,
      0,
      layout.contentTop,
      layout.contentLeft,
      layout.contentHeight,
      GUTTER_BACKGROUND,
    );
  }
}

function drawGrid(
  canvas: Buffer,
  layout: PreviewLayout,
  region: PreviewRegion,
): void {
  for (let column = 0; column <= region.width; column += 1) {
    const x = Math.min(
      layout.contentLeft + column * layout.tilePixelWidth,
      layout.contentLeft + layout.contentWidth - 1,
    );
    blendLine(
      canvas,
      layout.width,
      x,
      layout.contentTop,
      1,
      layout.contentHeight,
      GRID_COLOR,
    );
  }
  for (let row = 0; row <= region.height; row += 1) {
    const y = Math.min(
      layout.contentTop + row * layout.tilePixelHeight,
      layout.contentTop + layout.contentHeight - 1,
    );
    blendLine(
      canvas,
      layout.width,
      layout.contentLeft,
      y,
      layout.contentWidth,
      1,
      GRID_COLOR,
    );
  }
}

function drawCoordinates(
  canvas: Buffer,
  layout: PreviewLayout,
  region: PreviewRegion,
): void {
  for (let column = 0; column < region.width; column += 1) {
    const label = String(region.x + column);
    const width = glyphStringWidth(label);
    const left =
      layout.contentLeft +
      column * layout.tilePixelWidth +
      Math.floor((layout.tilePixelWidth - width) / 2);
    const top = Math.floor(
      (layout.contentTop - COORDINATE_GLYPH_HEIGHT) / 2,
    );
    drawGlyphString(
      canvas,
      layout.width,
      left,
      top,
      label,
      COORDINATE_COLOR,
    );
  }
  for (let row = 0; row < region.height; row += 1) {
    const label = String(region.y + row);
    const width = glyphStringWidth(label);
    const left = layout.contentLeft - COORDINATE_GUTTER_PADDING - width;
    const top =
      layout.contentTop +
      row * layout.tilePixelHeight +
      Math.floor((layout.tilePixelHeight - COORDINATE_GLYPH_HEIGHT) / 2);
    drawGlyphString(
      canvas,
      layout.width,
      left,
      top,
      label,
      COORDINATE_COLOR,
    );
  }
}

function glyphStringWidth(value: string): number {
  return (
    value.length * COORDINATE_GLYPH_WIDTH +
    Math.max(0, value.length - 1) * COORDINATE_GLYPH_GAP
  );
}

function drawGlyphString(
  canvas: Buffer,
  canvasWidth: number,
  left: number,
  top: number,
  value: string,
  color: Rgba,
): void {
  let cursor = left;
  for (const character of value) {
    const glyph = GLYPHS[character];
    if (glyph === undefined) {
      continue;
    }
    for (let y = 0; y < COORDINATE_GLYPH_HEIGHT; y += 1) {
      const row = glyph[y];
      for (let x = 0; x < COORDINATE_GLYPH_WIDTH; x += 1) {
        if (row?.[x] === "1") {
          setPixel(canvas, canvasWidth, cursor + x, top + y, color);
        }
      }
    }
    cursor += COORDINATE_GLYPH_WIDTH + COORDINATE_GLYPH_GAP;
  }
}

function fillRect(
  canvas: Buffer,
  canvasWidth: number,
  left: number,
  top: number,
  width: number,
  height: number,
  color: Rgba,
): void {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      setPixel(canvas, canvasWidth, x, y, color);
    }
  }
}

function blendLine(
  canvas: Buffer,
  canvasWidth: number,
  left: number,
  top: number,
  width: number,
  height: number,
  color: Rgba,
): void {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      blendPixel(canvas, canvasWidth, x, y, color);
    }
  }
}

function setPixel(
  canvas: Buffer,
  canvasWidth: number,
  x: number,
  y: number,
  color: Rgba,
): void {
  const index = (y * canvasWidth + x) * 4;
  canvas[index] = color[0];
  canvas[index + 1] = color[1];
  canvas[index + 2] = color[2];
  canvas[index + 3] = color[3];
}

function blendPixel(
  canvas: Buffer,
  canvasWidth: number,
  x: number,
  y: number,
  source: Rgba,
): void {
  const index = (y * canvasWidth + x) * 4;
  const destinationAlpha = canvas[index + 3] ?? 0;
  const sourceAlpha = source[3];
  if (sourceAlpha === 0) {
    return;
  }
  const outputAlpha =
    sourceAlpha + Math.round((destinationAlpha * (255 - sourceAlpha)) / 255);
  if (outputAlpha === 0) {
    return;
  }
  for (let channel = 0; channel < 3; channel += 1) {
    const sourcePremultiplied = (source[channel] ?? 0) * sourceAlpha;
    const destinationPremultiplied =
      (canvas[index + channel] ?? 0) *
      destinationAlpha *
      (255 - sourceAlpha) /
      255;
    canvas[index + channel] = Math.round(
      (sourcePremultiplied + destinationPremultiplied) / outputAlpha,
    );
  }
  canvas[index + 3] = outputAlpha;
}
