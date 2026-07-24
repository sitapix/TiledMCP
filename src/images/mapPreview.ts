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

const COORDINATE_GUTTER_PADDING = 2;
const COORDINATE_GLYPH_WIDTH = 3;
const COORDINATE_GLYPH_HEIGHT = 5;
const COORDINATE_GLYPH_GAP = 1;
const GUTTER_BACKGROUND: Rgba = [17, 24, 39, 255];
const COORDINATE_COLOR: Rgba = [226, 232, 240, 255];
const GRID_COLOR: Rgba = [255, 255, 255, 104];

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

export async function renderNativePreview(
  input: RenderNativePreviewInput,
): Promise<NativePreviewRender> {
  validateInput(input);
  const layout = computeLayout(input);
  assertPixelBlendBudget(input, layout);
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
  if (input.overlays.grid) {
    drawGrid(canvas, layout, input.region);
  }
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
): void {
  const pixelsPerTile =
    layout.tilePixelWidth * layout.tilePixelHeight;
  if (!Number.isSafeInteger(pixelsPerTile) || pixelsPerTile <= 0) {
    throw previewDimensionsExceeded(input, layout.width, layout.height);
  }
  const maximumTileDraws = Math.floor(
    MAX_NATIVE_PREVIEW_PIXEL_BLENDS / pixelsPerTile,
  );
  let tileDraws = 0;
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
          if (tileDraws > maximumTileDraws) {
            throw new TiledMcpError(
              "RESULT_LIMIT_EXCEEDED",
              `The preview exceeds the ${MAX_NATIVE_PREVIEW_PIXEL_BLENDS} pixel-blend work limit. Reduce region, layers or scale.`,
              {
                tileDraws,
                pixelsPerTile,
                pixelBlends: tileDraws * pixelsPerTile,
                limit: MAX_NATIVE_PREVIEW_PIXEL_BLENDS,
              },
            );
          }
        }
      }
    }
  }
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
