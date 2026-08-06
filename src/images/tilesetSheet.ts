import { TiledMcpError } from "../errors.js";
import { revisionOf } from "../storage/revision.js";
import {
  blitAtlasTile,
  parseTransparentColor,
  validateAtlasGeometry,
  type AtlasGeometry,
  type RgbColor,
} from "./atlas.js";
import {
  decodeSafeImage,
  encodeRgbaPng,
  type DecodedSafeImage,
} from "./safeImage.js";

export { MAX_SIMPLE_SVG_BYTES } from "./safeImage.js";

export const MAX_TILESET_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_TILESET_INPUT_PIXELS = 4_096 * 4_096;
export const MAX_TILESET_INPUT_EDGE = 8_192;
export const MAX_TILESET_SHEET_EDGE = 2_048;
export const MAX_TILESET_SHEET_PIXELS = 1_500_000;
/** Held to the inline-image ceiling; see `MAX_RASTER_PNG_BYTES`. */
export const MAX_TILESET_SHEET_BYTES = 7 * 1024 * 1024;
export const MAX_TILESET_SHEET_PAGE_SIZE = 256;
export const DEFAULT_TILESET_SHEET_PAGE_SIZE = 64;
export const MAX_TILESET_SHEET_COLUMNS = 32;
export const MAX_TILESET_SHEET_SCALE = 4;
export const DEFAULT_TILESET_SHEET_SCALE = 2;

export const MAX_TILE_RENDER_LOCAL_IDS = 64;
export const DEFAULT_TILE_RENDER_COLUMNS = 8;
export const MAX_TILE_RENDER_COLUMNS = MAX_TILESET_SHEET_COLUMNS;
export const DEFAULT_TILE_RENDER_SCALE = DEFAULT_TILESET_SHEET_SCALE;
export const MAX_TILE_RENDER_SCALE = MAX_TILESET_SHEET_SCALE;
export const MAX_TILE_RENDER_BYTES = MAX_TILESET_SHEET_BYTES;
export const MAX_TILE_RENDER_EDGE = MAX_TILESET_SHEET_EDGE;
export const MAX_TILE_RENDER_PIXELS = MAX_TILESET_SHEET_PIXELS;

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

interface TilesetAtlasSourceInput {
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
}

export interface TilesetSheetInput extends TilesetAtlasSourceInput {
  page: number;
  pageSize: number;
  sheetColumns?: number;
  scale: number;
}

export interface TilesetTilesInput extends TilesetAtlasSourceInput {
  localIds: readonly number[];
  columns?: number;
  scale?: number;
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

export interface TilesetTilesSelection {
  localIds: number[];
  count: number;
  order: "input";
  labels: "local-id";
  layout: {
    kind: "row-major";
    requestedColumns: number;
    columns: number;
    rows: number;
    adjusted: boolean;
  };
}

export interface TilesetTilesRender {
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
  selection: TilesetTilesSelection;
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

interface TilesLayout {
  cellWidth: number;
  cellHeight: number;
  requestedColumns: number;
  columns: number;
  rows: number;
  adjusted: boolean;
}

interface DecodedTilesetAtlas {
  decoded: DecodedSafeImage;
  atlas: AtlasGeometry;
  transparentColor?: RgbColor;
}

interface LabeledAtlasGridRender {
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
}

interface ValidatedTilesInput {
  localIds: number[];
  requestedColumns: number;
  columnsExplicit: boolean;
  scale: number;
}

export async function renderTilesetSheet(
  input: TilesetSheetInput,
): Promise<TilesetSheetRender> {
  validateInputIntegers(input);
  const source = await decodeTilesetAtlas(input);
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
  const localIds = Array.from(
    { length: pageTileCount },
    (_, offset) => firstLocalId + offset,
  );
  const rendered = await renderLabeledAtlasGrid({
    ...source,
    localIds,
    columns: pageColumns,
    cellWidth: layout.cellWidth,
    cellHeight: layout.cellHeight,
    scale: input.scale,
    encodeDescription: "The tileset sheet",
  });

  if (rendered.byteLength > MAX_TILESET_SHEET_BYTES) {
    throw new TiledMcpError(
      "IMAGE_TOO_LARGE",
      `The rendered sheet is ${rendered.byteLength} bytes; the inline limit is ${MAX_TILESET_SHEET_BYTES}. Reduce pageSize or scale.`,
      {
        bytes: rendered.byteLength,
        limit: MAX_TILESET_SHEET_BYTES,
        pageSize: layout.effectivePageSize,
        scale: input.scale,
      },
    );
  }

  return {
    ...rendered,
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

export async function renderTilesetTiles(
  input: TilesetTilesInput,
): Promise<TilesetTilesRender> {
  const validated = validateTilesInput(input);
  const source = await decodeTilesetAtlas(input);
  const layout = computeTilesLayout(
    input,
    validated.localIds.length,
    validated.requestedColumns,
    validated.columnsExplicit,
    validated.scale,
  );
  const rendered = await renderLabeledAtlasGrid({
    ...source,
    localIds: validated.localIds,
    columns: layout.columns,
    cellWidth: layout.cellWidth,
    cellHeight: layout.cellHeight,
    scale: validated.scale,
    encodeDescription: "The selected tileset tiles",
  });

  if (rendered.byteLength > MAX_TILE_RENDER_BYTES) {
    throw new TiledMcpError(
      "IMAGE_TOO_LARGE",
      `The rendered tile selection is ${rendered.byteLength} bytes; the inline limit is ${MAX_TILE_RENDER_BYTES}. Reduce localIds or scale.`,
      {
        bytes: rendered.byteLength,
        limit: MAX_TILE_RENDER_BYTES,
        localIdCount: validated.localIds.length,
        scale: validated.scale,
      },
    );
  }

  return {
    ...rendered,
    selection: {
      localIds: validated.localIds,
      count: validated.localIds.length,
      order: "input",
      labels: "local-id",
      layout: {
        kind: "row-major",
        requestedColumns: layout.requestedColumns,
        columns: layout.columns,
        rows: layout.rows,
        adjusted: layout.adjusted,
      },
    },
    scale: validated.scale,
  };
}

async function decodeTilesetAtlas(
  input: TilesetAtlasSourceInput,
): Promise<DecodedTilesetAtlas> {
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
  const transparentColor =
    input.transparentColor === undefined
      ? undefined
      : parseTransparentColor(input.transparentColor);
  return {
    decoded,
    atlas,
    ...(transparentColor === undefined ? {} : { transparentColor }),
  };
}

/** One decoded per-tile image of an image-collection tileset. */
export interface CollectionTileSource {
  localId: number;
  imagePath: string;
  rgba: Buffer;
  width: number;
  height: number;
}

export interface CollectionTilesInput {
  /** Selection order is preserved; ids validated by the caller. */
  tiles: readonly CollectionTileSource[];
  /** Highest existing local id, sizing the label column. */
  maxLabelId: number;
  columns?: number;
  scale?: number;
}

export interface CollectionTilesRender {
  png: Buffer;
  mimeType: "image/png";
  pixelSize: { width: number; height: number };
  byteLength: number;
  sha256: string;
  selection: TilesetTilesSelection;
  scale: number;
}

/**
 * Renders explicit image-collection tiles into the same labeled grid as
 * the atlas tile renderer. Each tile blits through a degenerate
 * single-tile atlas geometry of its own full image, so pixel semantics
 * (alpha, scaling) stay identical to the atlas path; cells size to the
 * largest selected tile.
 */
export async function renderCollectionTiles(
  input: CollectionTilesInput,
): Promise<CollectionTilesRender> {
  const scale = input.scale ?? DEFAULT_TILE_RENDER_SCALE;
  requirePositiveSafeInteger(scale, "scale");
  if (scale > MAX_TILE_RENDER_SCALE) {
    throw invalidArgument(
      `scale must not exceed ${MAX_TILE_RENDER_SCALE}.`,
    );
  }
  const requestedColumns =
    input.columns ?? DEFAULT_TILE_RENDER_COLUMNS;
  requirePositiveSafeInteger(requestedColumns, "columns");
  if (requestedColumns > MAX_TILE_RENDER_COLUMNS) {
    throw invalidArgument(
      `columns must not exceed ${MAX_TILE_RENDER_COLUMNS}.`,
    );
  }
  if (
    input.tiles.length < 1 ||
    input.tiles.length > MAX_TILE_RENDER_LOCAL_IDS
  ) {
    throw invalidArgument(
      `localIds must contain between 1 and ${MAX_TILE_RENDER_LOCAL_IDS} IDs.`,
    );
  }
  requireNonNegativeSafeInteger(input.maxLabelId, "maxLabelId");

  let maxTileWidth = 1;
  let maxTileHeight = 1;
  for (const tile of input.tiles) {
    requirePositiveSafeInteger(tile.width, "tile width");
    requirePositiveSafeInteger(tile.height, "tile height");
    maxTileWidth = Math.max(maxTileWidth, tile.width);
    maxTileHeight = Math.max(maxTileHeight, tile.height);
  }
  const tilePixelWidth = maxTileWidth * scale;
  const tilePixelHeight = maxTileHeight * scale;
  if (
    !Number.isSafeInteger(tilePixelWidth) ||
    !Number.isSafeInteger(tilePixelHeight)
  ) {
    throw invalidArgument("Scaled tile dimensions exceed safe integer bounds.");
  }
  const longestLabelWidth = digitStringWidth(String(input.maxLabelId));
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
    (MAX_TILE_RENDER_EDGE - 2 * OUTER_PADDING) / cellWidth,
  );
  const maxColumnsByPixels = Math.floor(
    (MAX_TILE_RENDER_PIXELS /
      (2 * OUTER_PADDING + cellHeight) -
      2 * OUTER_PADDING) /
      cellWidth,
  );
  const maximumColumns = Math.min(
    MAX_TILE_RENDER_COLUMNS,
    maxColumnsByEdge,
    maxColumnsByPixels,
  );
  if (maximumColumns < 1) {
    throw new TiledMcpError(
      "IMAGE_DIMENSIONS_EXCEEDED",
      `The largest collection tile (${maxTileWidth}x${maxTileHeight}) at scale ${scale}, plus its local-ID label, exceeds the ${MAX_TILE_RENDER_EDGE}px render edge budget. Lower scale and retry.`,
      {
        maxTileWidth,
        maxTileHeight,
        scale,
        maxEdge: MAX_TILE_RENDER_EDGE,
      },
    );
  }
  const effectiveRequestedColumns = Math.min(
    requestedColumns,
    input.tiles.length,
  );
  if (
    input.columns !== undefined &&
    effectiveRequestedColumns > maximumColumns
  ) {
    throw new TiledMcpError(
      "IMAGE_DIMENSIONS_EXCEEDED",
      `columns ${input.columns} would require ${effectiveRequestedColumns} columns, but at most ${maximumColumns} fit this layout.`,
      {
        requestedColumns: input.columns,
        effectiveRequestedColumns,
        maximumColumns,
        maxEdge: MAX_TILE_RENDER_EDGE,
        maxPixels: MAX_TILE_RENDER_PIXELS,
      },
    );
  }
  const columns = Math.min(
    effectiveRequestedColumns,
    maximumColumns,
  );
  const rows = Math.ceil(input.tiles.length / columns);

  const outputWidth = 2 * OUTER_PADDING + columns * cellWidth;
  const outputHeight = 2 * OUTER_PADDING + rows * cellHeight;
  assertOutputBudget(outputWidth, outputHeight);

  const canvas = Buffer.alloc(outputWidth * outputHeight * 4);
  fillRect(canvas, outputWidth, 0, 0, outputWidth, outputHeight, [17, 24, 39, 255]);

  for (const [offset, tile] of input.tiles.entries()) {
    const column = offset % columns;
    const row = Math.floor(offset / columns);
    const cellLeft = OUTER_PADDING + column * cellWidth;
    const cellTop = OUTER_PADDING + row * cellHeight;
    drawCell(
      canvas,
      outputWidth,
      cellLeft,
      cellTop,
      cellWidth,
      cellHeight,
    );

    const scaledWidth = tile.width * scale;
    const scaledHeight = tile.height * scale;
    const tileLeft =
      cellLeft + Math.floor((cellWidth - scaledWidth) / 2);
    const tileTop = cellTop + TILE_PADDING;
    drawCheckerboard(
      canvas,
      outputWidth,
      tileLeft,
      tileTop,
      scaledWidth,
      scaledHeight,
    );

    const singleTileAtlas: AtlasGeometry = {
      imagePath: tile.imagePath,
      imageWidth: tile.width,
      imageHeight: tile.height,
      tileWidth: tile.width,
      tileHeight: tile.height,
      tileCount: 1,
      columns: 1,
      margin: 0,
      spacing: 0,
    };
    validateAtlasGeometry(singleTileAtlas);
    blitAtlasTile({
      sourceRgba: tile.rgba,
      sourceWidth: tile.width,
      atlas: singleTileAtlas,
      localId: 0,
      destinationRgba: canvas,
      destinationWidth: outputWidth,
      destinationLeft: tileLeft,
      destinationTop: tileTop,
      scale,
    });

    const label = String(tile.localId);
    const labelWidth = digitStringWidth(label);
    const labelLeft =
      cellLeft + Math.floor((cellWidth - labelWidth) / 2);
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
    "The selected collection tiles",
  );
  if (encoded.byteLength > MAX_TILE_RENDER_BYTES) {
    throw new TiledMcpError(
      "IMAGE_TOO_LARGE",
      `The rendered tile selection is ${encoded.byteLength} bytes; the inline limit is ${MAX_TILE_RENDER_BYTES}. Reduce localIds or scale.`,
      {
        byteLength: encoded.byteLength,
        limit: MAX_TILE_RENDER_BYTES,
      },
    );
  }

  return {
    png: encoded,
    mimeType: "image/png",
    pixelSize: { width: outputWidth, height: outputHeight },
    byteLength: encoded.byteLength,
    sha256: revisionOf(encoded),
    selection: {
      localIds: input.tiles.map(({ localId }) => localId),
      count: input.tiles.length,
      order: "input",
      labels: "local-id",
      layout: {
        kind: "row-major",
        requestedColumns: effectiveRequestedColumns,
        columns,
        rows,
        adjusted:
          input.columns !== undefined &&
          columns !== input.columns,
      },
    },
    scale,
  };
}

async function renderLabeledAtlasGrid(
  input: DecodedTilesetAtlas & {
    localIds: readonly number[];
    columns: number;
    cellWidth: number;
    cellHeight: number;
    scale: number;
    encodeDescription: string;
  },
): Promise<LabeledAtlasGridRender> {
  const outputWidth =
    2 * OUTER_PADDING + input.columns * input.cellWidth;
  const rows = Math.ceil(input.localIds.length / input.columns);
  const outputHeight =
    2 * OUTER_PADDING + rows * input.cellHeight;
  assertOutputBudget(outputWidth, outputHeight);

  const canvas = Buffer.alloc(outputWidth * outputHeight * 4);
  fillRect(canvas, outputWidth, 0, 0, outputWidth, outputHeight, [17, 24, 39, 255]);

  for (const [offset, localId] of input.localIds.entries()) {
    const column = offset % input.columns;
    const row = Math.floor(offset / input.columns);
    const cellLeft = OUTER_PADDING + column * input.cellWidth;
    const cellTop = OUTER_PADDING + row * input.cellHeight;
    drawCell(
      canvas,
      outputWidth,
      cellLeft,
      cellTop,
      input.cellWidth,
      input.cellHeight,
    );

    const tilePixelWidth = input.atlas.tileWidth * input.scale;
    const tilePixelHeight = input.atlas.tileHeight * input.scale;
    const tileLeft =
      cellLeft + Math.floor((input.cellWidth - tilePixelWidth) / 2);
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
      sourceRgba: input.decoded.rgba,
      sourceWidth: input.decoded.pixelSize.width,
      atlas: input.atlas,
      localId,
      destinationRgba: canvas,
      destinationWidth: outputWidth,
      destinationLeft: tileLeft,
      destinationTop: tileTop,
      scale: input.scale,
      ...(input.transparentColor === undefined
        ? {}
        : { transparentColor: input.transparentColor }),
    });

    const label = String(localId);
    const labelWidth = digitStringWidth(label);
    const labelLeft =
      cellLeft + Math.floor((input.cellWidth - labelWidth) / 2);
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
    input.encodeDescription,
  );

  return {
    png: encoded,
    mimeType: "image/png",
    pixelSize: { width: outputWidth, height: outputHeight },
    byteLength: encoded.byteLength,
    sha256: revisionOf(encoded),
    image: {
      format: input.decoded.format,
      pixelSize: {
        width: input.decoded.pixelSize.width,
        height: input.decoded.pixelSize.height,
      },
    },
  };
}

function validateInputIntegers(input: TilesetSheetInput): void {
  validateAtlasSourceInput(input);
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
}

function validateAtlasSourceInput(input: TilesetAtlasSourceInput): void {
  requirePositiveSafeInteger(input.imageWidth, "imageWidth");
  requirePositiveSafeInteger(input.imageHeight, "imageHeight");
  requirePositiveSafeInteger(input.tileWidth, "tileWidth");
  requirePositiveSafeInteger(input.tileHeight, "tileHeight");
  requirePositiveSafeInteger(input.tileCount, "tileCount");
  requirePositiveSafeInteger(input.atlasColumns, "atlasColumns");
  requireNonNegativeSafeInteger(input.margin, "margin");
  requireNonNegativeSafeInteger(input.spacing, "spacing");
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

function validateTilesInput(
  input: TilesetTilesInput,
): ValidatedTilesInput {
  validateAtlasSourceInput(input);
  const scale = input.scale ?? DEFAULT_TILE_RENDER_SCALE;
  requirePositiveSafeInteger(scale, "scale");
  if (scale > MAX_TILE_RENDER_SCALE) {
    throw invalidArgument(
      `scale must not exceed ${MAX_TILE_RENDER_SCALE}.`,
    );
  }

  const requestedColumns =
    input.columns ?? DEFAULT_TILE_RENDER_COLUMNS;
  requirePositiveSafeInteger(requestedColumns, "columns");
  if (requestedColumns > MAX_TILE_RENDER_COLUMNS) {
    throw invalidArgument(
      `columns must not exceed ${MAX_TILE_RENDER_COLUMNS}.`,
    );
  }

  if (
    !Array.isArray(input.localIds) ||
    input.localIds.length < 1 ||
    input.localIds.length > MAX_TILE_RENDER_LOCAL_IDS
  ) {
    throw invalidArgument(
      `localIds must contain between 1 and ${MAX_TILE_RENDER_LOCAL_IDS} IDs.`,
    );
  }
  const localIds: number[] = [];
  const firstIndexByLocalId = new Map<number, number>();
  for (const [index, localId] of input.localIds.entries()) {
    if (!Number.isSafeInteger(localId) || localId < 0) {
      throw invalidArgument(
        "localIds must contain non-negative safe integers.",
      );
    }
    if (localId >= input.tileCount) {
      throw new TiledMcpError(
        "TILE_ID_OUT_OF_RANGE",
        `Tile ${localId} is outside ${input.imagePath}.`,
        {
          path: input.imagePath,
          localId,
          tileCount: input.tileCount,
          index,
        },
      );
    }
    const firstIndex = firstIndexByLocalId.get(localId);
    if (firstIndex !== undefined) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `localIds contains duplicate local ID ${localId}.`,
        {
          localId,
          firstIndex,
          duplicateIndex: index,
        },
      );
    }
    firstIndexByLocalId.set(localId, index);
    localIds.push(localId);
  }
  return {
    localIds,
    requestedColumns,
    columnsExplicit: input.columns !== undefined,
    scale,
  };
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

function computeTilesLayout(
  input: TilesetTilesInput,
  localIdCount: number,
  requestedColumns: number,
  columnsExplicit: boolean,
  scale: number,
): TilesLayout {
  const tilePixelWidth = input.tileWidth * scale;
  const tilePixelHeight = input.tileHeight * scale;
  if (
    !Number.isSafeInteger(tilePixelWidth) ||
    !Number.isSafeInteger(tilePixelHeight)
  ) {
    throw invalidArgument("Scaled tile dimensions exceed safe integer bounds.");
  }
  const longestLabelWidth = digitStringWidth(
    String(input.tileCount - 1),
  );
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
    (MAX_TILE_RENDER_EDGE - 2 * OUTER_PADDING) / cellWidth,
  );
  const maxColumnsByPixels = Math.floor(
    (MAX_TILE_RENDER_PIXELS /
      (2 * OUTER_PADDING + cellHeight) -
      2 * OUTER_PADDING) /
      cellWidth,
  );
  const maximumColumns = Math.min(
    MAX_TILE_RENDER_COLUMNS,
    maxColumnsByEdge,
    maxColumnsByPixels,
  );
  if (maximumColumns < 1) {
    throw new TiledMcpError(
      "IMAGE_DIMENSIONS_EXCEEDED",
      `A single ${input.tileWidth}x${input.tileHeight} tile at scale ${scale}, plus its local-ID label, exceeds the ${MAX_TILE_RENDER_EDGE}px render edge budget. Lower scale and retry.`,
      {
        tileWidth: input.tileWidth,
        tileHeight: input.tileHeight,
        scale,
        maxEdge: MAX_TILE_RENDER_EDGE,
      },
    );
  }

  const effectiveRequestedColumns = Math.min(
    requestedColumns,
    localIdCount,
  );
  if (
    columnsExplicit &&
    effectiveRequestedColumns > maximumColumns
  ) {
    throw new TiledMcpError(
      "IMAGE_DIMENSIONS_EXCEEDED",
      `columns ${requestedColumns} would require ${effectiveRequestedColumns} columns, but at most ${maximumColumns} fit this layout.`,
      {
        requestedColumns,
        effectiveRequestedColumns,
        maximumColumns,
        maxEdge: MAX_TILE_RENDER_EDGE,
        maxPixels: MAX_TILE_RENDER_PIXELS,
      },
    );
  }
  const maximumRequestedColumns = Math.min(
    effectiveRequestedColumns,
    maximumColumns,
  );
  let columns = maximumRequestedColumns;
  if (!columnsExplicit) {
    while (columns > 1) {
      const candidateRows = Math.ceil(localIdCount / columns);
      const candidateWidth =
        2 * OUTER_PADDING + columns * cellWidth;
      const candidateHeight =
        2 * OUTER_PADDING + candidateRows * cellHeight;
      if (fitsOutputBudget(candidateWidth, candidateHeight)) {
        break;
      }
      columns -= 1;
    }
  }
  const rows = Math.ceil(localIdCount / columns);
  const width = 2 * OUTER_PADDING + columns * cellWidth;
  const height = 2 * OUTER_PADDING + rows * cellHeight;
  assertOutputBudget(width, height);
  return {
    cellWidth,
    cellHeight,
    requestedColumns,
    columns,
    rows,
    adjusted:
      !columnsExplicit &&
      columns < effectiveRequestedColumns,
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
  if (!fitsOutputBudget(width, height)) {
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

function fitsOutputBudget(width: number, height: number): boolean {
  const pixels = width * height;
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    Number.isSafeInteger(pixels) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_TILESET_SHEET_EDGE &&
    height <= MAX_TILESET_SHEET_EDGE &&
    pixels <= MAX_TILESET_SHEET_PIXELS
  );
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
