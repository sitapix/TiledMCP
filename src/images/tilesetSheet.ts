import { TiledMcpError } from "../errors.js";
import { revisionOf } from "../storage/revision.js";
import {
  blitAtlasTile,
  parseTransparentColor,
  validateAtlasGeometry,
  type AtlasGeometry,
} from "./atlas.js";
import {
  decodeSafeImage,
  encodeRgbaPng,
} from "./safeImage.js";

export { MAX_SIMPLE_SVG_BYTES } from "./safeImage.js";

export const MAX_TILESET_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_TILESET_INPUT_PIXELS = 4_096 * 4_096;
export const MAX_TILESET_INPUT_EDGE = 8_192;
export const MAX_TILESET_SHEET_EDGE = 2_048;
export const MAX_TILESET_SHEET_PIXELS = 1_500_000;
export const MAX_TILESET_SHEET_BYTES = 8 * 1024 * 1024;
export const MAX_TILESET_SHEET_PAGE_SIZE = 256;
export const DEFAULT_TILESET_SHEET_PAGE_SIZE = 64;
export const MAX_TILESET_SHEET_COLUMNS = 32;
export const MAX_TILESET_SHEET_SCALE = 4;
export const DEFAULT_TILESET_SHEET_SCALE = 2;

const OUTER_PADDING = 8;
const TILE_PADDING = 4;
const LABEL_GAP = 4;
const LABEL_BOTTOM_PADDING = 4;
const DIGIT_SCALE = 2;
const DIGIT_WIDTH = 3;
const DIGIT_HEIGHT = 5;
const DIGIT_GAP = 1;

const DIGIT_GLYPHS: Readonly<Record<string, readonly string[]>> = {
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

export interface TilesetSheetInput {
  imageBytes: Buffer;
  imagePath: string;
  imageWidth: number;
  imageHeight: number;
  tileWidth: number;
  tileHeight: number;
  tileCount: number;
  atlasColumns: number;
  margin: number;
  spacing: number;
  transparentColor?: string;
  page: number;
  pageSize: number;
  sheetColumns?: number;
  scale: number;
}

export interface TilesetSheetPage {
  index: number;
  count: number;
  requestedSize: number;
  size: number;
  adjusted: boolean;
  tileCount: number;
  localIdRange: {
    first: number;
    last: number;
  };
  columns: number;
  rows: number;
}

export interface TilesetSheetRender {
  png: Buffer;
  mimeType: "image/png";
  pixelSize: {
    width: number;
    height: number;
  };
  byteLength: number;
  sha256: string;
  image: {
    format: "jpeg" | "png" | "svg" | "webp";
    pixelSize: {
      width: number;
      height: number;
    };
  };
  page: TilesetSheetPage;
  scale: number;
}

interface SheetLayout {
  cellWidth: number;
  cellHeight: number;
  columns: number;
  rows: number;
  width: number;
  height: number;
  effectivePageSize: number;
}

export async function renderTilesetSheet(
  input: TilesetSheetInput,
): Promise<TilesetSheetRender> {
  validateInputIntegers(input);
  const decoded = await decodeSafeImage({
    bytes: input.imageBytes,
    path: input.imagePath,
    declaredWidth: input.imageWidth,
    declaredHeight: input.imageHeight,
    limits: {
      maxInputBytes: MAX_TILESET_IMAGE_BYTES,
      maxInputPixels: MAX_TILESET_INPUT_PIXELS,
      maxInputEdge: MAX_TILESET_INPUT_EDGE,
    },
  });
  const imageWidth = decoded.pixelSize.width;
  const imageHeight = decoded.pixelSize.height;
  const atlas: AtlasGeometry = {
    imagePath: input.imagePath,
    imageWidth,
    imageHeight,
    tileWidth: input.tileWidth,
    tileHeight: input.tileHeight,
    tileCount: input.tileCount,
    columns: input.atlasColumns,
    margin: input.margin,
    spacing: input.spacing,
  };
  validateAtlasGeometry(atlas);

  const layout = computeSheetLayout(input);
  const pageCount = Math.ceil(input.tileCount / layout.effectivePageSize);
  if (input.page >= pageCount) {
    throw new TiledMcpError(
      "PAGE_OUT_OF_RANGE",
      `Page ${input.page} is outside the tileset sheet range 0..${pageCount - 1}.`,
      { page: input.page, pageCount },
    );
  }
  const firstLocalId = input.page * layout.effectivePageSize;
  const lastLocalId = Math.min(
    input.tileCount - 1,
    firstLocalId + layout.effectivePageSize - 1,
  );
  const pageTileCount = lastLocalId - firstLocalId + 1;
  const pageColumns = Math.min(layout.columns, pageTileCount);
  const pageRows = Math.ceil(pageTileCount / pageColumns);
  const outputWidth = 2 * OUTER_PADDING + pageColumns * layout.cellWidth;
  const outputHeight = 2 * OUTER_PADDING + pageRows * layout.cellHeight;
  assertOutputBudget(outputWidth, outputHeight);

  const canvas = Buffer.alloc(outputWidth * outputHeight * 4);
  fillRect(canvas, outputWidth, 0, 0, outputWidth, outputHeight, [17, 24, 39, 255]);

  const transparentColor =
    input.transparentColor === undefined
      ? undefined
      : parseTransparentColor(input.transparentColor);
  for (let offset = 0; offset < pageTileCount; offset += 1) {
    const localId = firstLocalId + offset;
    const column = offset % pageColumns;
    const row = Math.floor(offset / pageColumns);
    const cellLeft = OUTER_PADDING + column * layout.cellWidth;
    const cellTop = OUTER_PADDING + row * layout.cellHeight;
    drawCell(
      canvas,
      outputWidth,
      cellLeft,
      cellTop,
      layout.cellWidth,
      layout.cellHeight,
    );

    const tilePixelWidth = input.tileWidth * input.scale;
    const tilePixelHeight = input.tileHeight * input.scale;
    const tileLeft =
      cellLeft + Math.floor((layout.cellWidth - tilePixelWidth) / 2);
    const tileTop = cellTop + TILE_PADDING;
    drawCheckerboard(
      canvas,
      outputWidth,
      tileLeft,
      tileTop,
      tilePixelWidth,
      tilePixelHeight,
    );

    blitAtlasTile({
      sourceRgba: decoded.rgba,
      sourceWidth: imageWidth,
      atlas,
      localId,
      destinationRgba: canvas,
      destinationWidth: outputWidth,
      destinationLeft: tileLeft,
      destinationTop: tileTop,
      scale: input.scale,
      ...(transparentColor === undefined ? {} : { transparentColor }),
    });

    const label = String(localId);
    const labelWidth = digitStringWidth(label);
    const labelLeft = cellLeft + Math.floor((layout.cellWidth - labelWidth) / 2);
    const labelTop = tileTop + tilePixelHeight + LABEL_GAP;
    drawDigitString(
      canvas,
      outputWidth,
      labelLeft,
      labelTop,
      label,
      [226, 232, 240, 255],
    );
  }

  const encoded = await encodeRgbaPng(
    canvas,
    outputWidth,
    outputHeight,
    "The tileset sheet",
  );
  if (encoded.byteLength > MAX_TILESET_SHEET_BYTES) {
    throw new TiledMcpError(
      "IMAGE_TOO_LARGE",
      `The rendered sheet is ${encoded.byteLength} bytes; the inline limit is ${MAX_TILESET_SHEET_BYTES}. Reduce pageSize or scale.`,
      {
        bytes: encoded.byteLength,
        limit: MAX_TILESET_SHEET_BYTES,
        pageSize: layout.effectivePageSize,
        scale: input.scale,
      },
    );
  }

  return {
    png: encoded,
    mimeType: "image/png",
    pixelSize: { width: outputWidth, height: outputHeight },
    byteLength: encoded.byteLength,
    sha256: revisionOf(encoded),
    image: {
      format: decoded.format,
      pixelSize: { width: imageWidth, height: imageHeight },
    },
    page: {
      index: input.page,
      count: pageCount,
      requestedSize: input.pageSize,
      size: layout.effectivePageSize,
      adjusted: layout.effectivePageSize !== input.pageSize,
      tileCount: pageTileCount,
      localIdRange: { first: firstLocalId, last: lastLocalId },
      columns: pageColumns,
      rows: pageRows,
    },
    scale: input.scale,
  };
}

function validateInputIntegers(input: TilesetSheetInput): void {
  requirePositiveSafeInteger(input.imageWidth, "imageWidth");
  requirePositiveSafeInteger(input.imageHeight, "imageHeight");
  requirePositiveSafeInteger(input.tileWidth, "tileWidth");
  requirePositiveSafeInteger(input.tileHeight, "tileHeight");
  requirePositiveSafeInteger(input.tileCount, "tileCount");
  requirePositiveSafeInteger(input.atlasColumns, "atlasColumns");
  requireNonNegativeSafeInteger(input.margin, "margin");
  requireNonNegativeSafeInteger(input.spacing, "spacing");
  requireNonNegativeSafeInteger(input.page, "page");
  requirePositiveSafeInteger(input.pageSize, "pageSize");
  requirePositiveSafeInteger(input.scale, "scale");
  if (input.pageSize > MAX_TILESET_SHEET_PAGE_SIZE) {
    throw invalidArgument(
      `pageSize must not exceed ${MAX_TILESET_SHEET_PAGE_SIZE}.`,
    );
  }
  if (input.scale > MAX_TILESET_SHEET_SCALE) {
    throw invalidArgument(
      `scale must not exceed ${MAX_TILESET_SHEET_SCALE}.`,
    );
  }
  if (input.sheetColumns !== undefined) {
    requirePositiveSafeInteger(input.sheetColumns, "sheetColumns");
    if (input.sheetColumns > MAX_TILESET_SHEET_COLUMNS) {
      throw invalidArgument(
        `sheetColumns must not exceed ${MAX_TILESET_SHEET_COLUMNS}.`,
      );
    }
  }
  if (
    input.transparentColor !== undefined &&
    !/^#[0-9a-f]{6}$/iu.test(input.transparentColor)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      "tileset transparentcolor must use #RRGGBB.",
      { transparentColor: input.transparentColor },
    );
  }
}

function computeSheetLayout(input: TilesetSheetInput): SheetLayout {
  const tilePixelWidth = input.tileWidth * input.scale;
  const tilePixelHeight = input.tileHeight * input.scale;
  if (
    !Number.isSafeInteger(tilePixelWidth) ||
    !Number.isSafeInteger(tilePixelHeight)
  ) {
    throw invalidArgument("Scaled tile dimensions exceed safe integer bounds.");
  }
  const longestLabelWidth = digitStringWidth(String(input.tileCount - 1));
  const cellWidth = Math.max(
    tilePixelWidth + 2 * TILE_PADDING,
    longestLabelWidth + 2 * TILE_PADDING,
  );
  const cellHeight =
    TILE_PADDING +
    tilePixelHeight +
    LABEL_GAP +
    DIGIT_HEIGHT * DIGIT_SCALE +
    LABEL_BOTTOM_PADDING;
  const maxColumnsByEdge = Math.floor(
    (MAX_TILESET_SHEET_EDGE - 2 * OUTER_PADDING) / cellWidth,
  );
  const maxColumnsByPixels = Math.floor(
    (MAX_TILESET_SHEET_PIXELS /
      (2 * OUTER_PADDING + cellHeight) -
      2 * OUTER_PADDING) /
      cellWidth,
  );
  const maximumColumns = Math.min(
    MAX_TILESET_SHEET_COLUMNS,
    maxColumnsByEdge,
    maxColumnsByPixels,
  );
  if (maximumColumns < 1) {
    throw new TiledMcpError(
      "IMAGE_DIMENSIONS_EXCEEDED",
      "A single scaled tile and its local ID label do not fit the sheet budget.",
      {
        tileWidth: input.tileWidth,
        tileHeight: input.tileHeight,
        scale: input.scale,
        maxEdge: MAX_TILESET_SHEET_EDGE,
      },
    );
  }
  const requestedColumns = Math.min(
    input.sheetColumns ?? 8,
    input.pageSize,
    input.tileCount,
  );
  if (
    input.sheetColumns !== undefined &&
    requestedColumns > maximumColumns
  ) {
    throw new TiledMcpError(
      "IMAGE_DIMENSIONS_EXCEEDED",
      `sheetColumns ${input.sheetColumns} would require ${requestedColumns} columns, but at most ${maximumColumns} fit this layout.`,
      {
        requestedColumns: input.sheetColumns,
        effectiveRequestedColumns: requestedColumns,
        maximumColumns,
        maxEdge: MAX_TILESET_SHEET_EDGE,
        maxPixels: MAX_TILESET_SHEET_PIXELS,
      },
    );
  }
  const columns = Math.min(requestedColumns, maximumColumns);
  const width = 2 * OUTER_PADDING + columns * cellWidth;
  const maxRowsByEdge = Math.floor(
    (MAX_TILESET_SHEET_EDGE - 2 * OUTER_PADDING) / cellHeight,
  );
  const maxRowsByPixels = Math.floor(
    (MAX_TILESET_SHEET_PIXELS / width - 2 * OUTER_PADDING) / cellHeight,
  );
  const maximumRows = Math.min(maxRowsByEdge, maxRowsByPixels);
  if (maximumRows < 1) {
    throw new TiledMcpError(
      "IMAGE_DIMENSIONS_EXCEEDED",
      "A single sheet row exceeds the output pixel budget.",
      {
        width,
        cellHeight,
        maxPixels: MAX_TILESET_SHEET_PIXELS,
      },
    );
  }
  const effectivePageSize = Math.min(
    input.pageSize,
    columns * maximumRows,
  );
  const rows = Math.ceil(effectivePageSize / columns);
  const height = 2 * OUTER_PADDING + rows * cellHeight;
  assertOutputBudget(width, height);
  return {
    cellWidth,
    cellHeight,
    columns,
    rows,
    width,
    height,
    effectivePageSize,
  };
}

function drawCell(
  canvas: Buffer,
  canvasWidth: number,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  fillRect(canvas, canvasWidth, left, top, width, height, [31, 41, 55, 255]);
  strokeRect(canvas, canvasWidth, left, top, width, height, [75, 85, 99, 255]);
}

function drawCheckerboard(
  canvas: Buffer,
  canvasWidth: number,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  const square = 8;
  for (let y = 0; y < height; y += square) {
    for (let x = 0; x < width; x += square) {
      const light = (Math.floor(x / square) + Math.floor(y / square)) % 2 === 0;
      fillRect(
        canvas,
        canvasWidth,
        left + x,
        top + y,
        Math.min(square, width - x),
        Math.min(square, height - y),
        light ? [75, 85, 99, 255] : [55, 65, 81, 255],
      );
    }
  }
}

function drawDigitString(
  canvas: Buffer,
  canvasWidth: number,
  left: number,
  top: number,
  value: string,
  color: readonly [number, number, number, number],
): void {
  let cursor = left;
  for (const digit of value) {
    const glyph = DIGIT_GLYPHS[digit];
    if (glyph === undefined) {
      continue;
    }
    for (let glyphY = 0; glyphY < DIGIT_HEIGHT; glyphY += 1) {
      const row = glyph[glyphY];
      for (let glyphX = 0; glyphX < DIGIT_WIDTH; glyphX += 1) {
        if (row?.[glyphX] !== "1") {
          continue;
        }
        fillRect(
          canvas,
          canvasWidth,
          cursor + glyphX * DIGIT_SCALE,
          top + glyphY * DIGIT_SCALE,
          DIGIT_SCALE,
          DIGIT_SCALE,
          color,
        );
      }
    }
    cursor += (DIGIT_WIDTH + DIGIT_GAP) * DIGIT_SCALE;
  }
}

function digitStringWidth(value: string): number {
  return (
    value.length * DIGIT_WIDTH * DIGIT_SCALE +
    Math.max(0, value.length - 1) * DIGIT_GAP * DIGIT_SCALE
  );
}

function fillRect(
  canvas: Buffer,
  canvasWidth: number,
  left: number,
  top: number,
  width: number,
  height: number,
  color: readonly [number, number, number, number],
): void {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      setPixel(canvas, canvasWidth, x, y, color);
    }
  }
}

function strokeRect(
  canvas: Buffer,
  canvasWidth: number,
  left: number,
  top: number,
  width: number,
  height: number,
  color: readonly [number, number, number, number],
): void {
  fillRect(canvas, canvasWidth, left, top, width, 1, color);
  fillRect(canvas, canvasWidth, left, top + height - 1, width, 1, color);
  fillRect(canvas, canvasWidth, left, top, 1, height, color);
  fillRect(canvas, canvasWidth, left + width - 1, top, 1, height, color);
}

function setPixel(
  canvas: Buffer,
  canvasWidth: number,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  const index = (y * canvasWidth + x) * 4;
  canvas[index] = color[0];
  canvas[index + 1] = color[1];
  canvas[index + 2] = color[2];
  canvas[index + 3] = color[3];
}

function assertOutputBudget(width: number, height: number): void {
  if (
    width <= 0 ||
    height <= 0 ||
    width > MAX_TILESET_SHEET_EDGE ||
    height > MAX_TILESET_SHEET_EDGE ||
    width * height > MAX_TILESET_SHEET_PIXELS
  ) {
    throw new TiledMcpError(
      "IMAGE_DIMENSIONS_EXCEEDED",
      `Sheet dimensions ${width}x${height} exceed the render budget.`,
      {
        width,
        height,
        maxEdge: MAX_TILESET_SHEET_EDGE,
        maxPixels: MAX_TILESET_SHEET_PIXELS,
      },
    );
  }
}

function requirePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidArgument(`${field} must be a positive safe integer.`);
  }
}

function requireNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidArgument(`${field} must be a non-negative safe integer.`);
  }
}

function invalidArgument(message: string): TiledMcpError {
  return new TiledMcpError("INVALID_ARGUMENT", message);
}
