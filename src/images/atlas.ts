import { TiledMcpError } from "../errors.js";

export type RgbColor = readonly [number, number, number];

export interface AtlasGeometry {
  imagePath: string;
  imageWidth: number;
  imageHeight: number;
  tileWidth: number;
  tileHeight: number;
  tileCount: number;
  columns: number;
  margin: number;
  spacing: number;
}

export interface AtlasTileTransform {
  flipH?: boolean;
  flipV?: boolean;
  flipD?: boolean;
}

export interface BlitAtlasTileInput {
  sourceRgba: Buffer;
  sourceWidth: number;
  atlas: AtlasGeometry;
  localId: number;
  destinationRgba: Buffer;
  destinationWidth: number;
  destinationLeft: number;
  destinationTop: number;
  scale: number;
  transparentColor?: RgbColor;
  transform?: AtlasTileTransform;
  opacity?: number;
}

export interface BlitAtlasTileResult {
  pixelWidth: number;
  pixelHeight: number;
}

export interface AtlasTileCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Validates Tiled's atlas declaration using its one-sided margin formula.
 * In particular, image extents do not require a second trailing margin.
 */
export function validateAtlasGeometry(atlas: AtlasGeometry): void {
  validateAtlasFields(atlas);
  const actualColumns = countAtlasSlots(
    atlas.imageWidth,
    atlas.margin,
    atlas.tileWidth,
    atlas.spacing,
  );
  const actualRows = countAtlasSlots(
    atlas.imageHeight,
    atlas.margin,
    atlas.tileHeight,
    atlas.spacing,
  );
  if (atlas.columns !== actualColumns) {
    throw new TiledMcpError(
      "INVALID_TILESET_ATLAS",
      `TSJ columns is ${atlas.columns}, but ${atlas.imagePath} contains ${actualColumns} complete tile columns.`,
      {
        path: atlas.imagePath,
        declaredColumns: atlas.columns,
        actualColumns,
      },
    );
  }
  const capacity = actualColumns * actualRows;
  if (!Number.isSafeInteger(capacity) || atlas.tileCount !== capacity) {
    throw new TiledMcpError(
      "INVALID_TILESET_ATLAS",
      `TSJ tilecount is ${atlas.tileCount}, but the atlas geometry contains ${capacity} complete tiles.`,
      {
        path: atlas.imagePath,
        declaredTileCount: atlas.tileCount,
        atlasCapacity: capacity,
      },
    );
  }
  getAtlasTileCrop(atlas, atlas.tileCount - 1);
}

export function getAtlasTileCrop(
  atlas: AtlasGeometry,
  localId: number,
): AtlasTileCrop {
  validateAtlasFields(atlas);
  if (
    !Number.isSafeInteger(localId) ||
    localId < 0 ||
    localId >= atlas.tileCount
  ) {
    throw new TiledMcpError(
      "TILE_ID_OUT_OF_RANGE",
      `Tile ${localId} is outside ${atlas.imagePath}.`,
      {
        path: atlas.imagePath,
        localId,
        tileCount: atlas.tileCount,
      },
    );
  }
  const column = localId % atlas.columns;
  const row = Math.floor(localId / atlas.columns);
  const left =
    atlas.margin + column * (atlas.tileWidth + atlas.spacing);
  const top =
    atlas.margin + row * (atlas.tileHeight + atlas.spacing);
  const right = left + atlas.tileWidth;
  const bottom = top + atlas.tileHeight;
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(top) ||
    !Number.isSafeInteger(right) ||
    !Number.isSafeInteger(bottom) ||
    right > atlas.imageWidth ||
    bottom > atlas.imageHeight
  ) {
    throw new TiledMcpError(
      "INVALID_TILESET_ATLAS",
      "The declared tile crop falls outside the source image.",
      {
        path: atlas.imagePath,
        localId,
        left,
        top,
        right,
        bottom,
        imageWidth: atlas.imageWidth,
        imageHeight: atlas.imageHeight,
      },
    );
  }
  return {
    left,
    top,
    width: atlas.tileWidth,
    height: atlas.tileHeight,
  };
}

export function parseTransparentColor(value: string): RgbColor {
  if (!/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      "tileset transparentcolor must use #RRGGBB.",
      { transparentColor: value },
    );
  }
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

/**
 * Nearest-neighbor atlas blit with Tiled's orthogonal transform order:
 * diagonal axis swap first, then horizontal and vertical flips.
 */
export function blitAtlasTile(
  input: BlitAtlasTileInput,
): BlitAtlasTileResult {
  const crop = getAtlasTileCrop(input.atlas, input.localId);
  const sourceHeight = rgbaHeight(
    input.sourceRgba,
    input.sourceWidth,
    "sourceRgba",
  );
  if (
    input.sourceWidth !== input.atlas.imageWidth ||
    sourceHeight !== input.atlas.imageHeight
  ) {
    throw new TiledMcpError(
      "INVALID_TILESET_IMAGE",
      `${input.atlas.imagePath} RGBA dimensions do not match its atlas declaration.`,
      {
        path: input.atlas.imagePath,
        actual: { width: input.sourceWidth, height: sourceHeight },
        declared: {
          width: input.atlas.imageWidth,
          height: input.atlas.imageHeight,
        },
      },
    );
  }
  const destinationHeight = rgbaHeight(
    input.destinationRgba,
    input.destinationWidth,
    "destinationRgba",
  );
  requireSafeInteger(input.destinationLeft, "destinationLeft");
  requireSafeInteger(input.destinationTop, "destinationTop");
  requirePositiveSafeInteger(input.scale, "scale");
  validateTransform(input.transform);
  const opacity = input.opacity ?? 1;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "opacity must be between 0 and 1.",
      { opacity },
    );
  }

  const flipD = input.transform?.flipD === true;
  const transformedWidth = flipD ? crop.height : crop.width;
  const transformedHeight = flipD ? crop.width : crop.height;
  const pixelWidth = transformedWidth * input.scale;
  const pixelHeight = transformedHeight * input.scale;
  if (
    !Number.isSafeInteger(pixelWidth) ||
    !Number.isSafeInteger(pixelHeight)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "Scaled tile dimensions exceed safe integer bounds.",
    );
  }

  for (let outputY = 0; outputY < transformedHeight; outputY += 1) {
    for (let outputX = 0; outputX < transformedWidth; outputX += 1) {
      const unflippedX =
        input.transform?.flipH === true
          ? transformedWidth - 1 - outputX
          : outputX;
      const unflippedY =
        input.transform?.flipV === true
          ? transformedHeight - 1 - outputY
          : outputY;
      const sourceTileX = flipD ? unflippedY : unflippedX;
      const sourceTileY = flipD ? unflippedX : unflippedY;
      const sourceIndex =
        ((crop.top + sourceTileY) * input.sourceWidth +
          crop.left +
          sourceTileX) *
        4;
      const red = input.sourceRgba[sourceIndex] ?? 0;
      const green = input.sourceRgba[sourceIndex + 1] ?? 0;
      const blue = input.sourceRgba[sourceIndex + 2] ?? 0;
      const sourceAlpha =
        input.transparentColor !== undefined &&
        red === input.transparentColor[0] &&
        green === input.transparentColor[1] &&
        blue === input.transparentColor[2]
          ? 0
          : (input.sourceRgba[sourceIndex + 3] ?? 255);
      // Tiled/QPainter quantizes opacity by truncating to an 8-bit alpha.
      // This makes 0.5 map to 127 and 0.25 map to 63, which matters for
      // deterministic comparisons against TmxRasterizer output.
      const alpha = Math.floor(sourceAlpha * opacity);
      for (let scaleY = 0; scaleY < input.scale; scaleY += 1) {
        for (let scaleX = 0; scaleX < input.scale; scaleX += 1) {
          const destinationX =
            input.destinationLeft + outputX * input.scale + scaleX;
          const destinationY =
            input.destinationTop + outputY * input.scale + scaleY;
          if (
            destinationX < 0 ||
            destinationY < 0 ||
            destinationX >= input.destinationWidth ||
            destinationY >= destinationHeight
          ) {
            continue;
          }
          blendPixel(
            input.destinationRgba,
            input.destinationWidth,
            destinationX,
            destinationY,
            [red, green, blue, alpha],
          );
        }
      }
    }
  }
  return { pixelWidth, pixelHeight };
}

function countAtlasSlots(
  imageExtent: number,
  margin: number,
  tileExtent: number,
  spacing: number,
): number {
  const firstEnd = margin + tileExtent;
  const stride = tileExtent + spacing;
  if (
    !Number.isSafeInteger(firstEnd) ||
    !Number.isSafeInteger(stride) ||
    firstEnd > imageExtent
  ) {
    return 0;
  }
  return 1 + Math.floor((imageExtent - firstEnd) / stride);
}

function validateAtlasFields(atlas: AtlasGeometry): void {
  if (typeof atlas.imagePath !== "string" || atlas.imagePath.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "imagePath must be a non-empty string.",
    );
  }
  for (const [field, value] of [
    ["imageWidth", atlas.imageWidth],
    ["imageHeight", atlas.imageHeight],
    ["tileWidth", atlas.tileWidth],
    ["tileHeight", atlas.tileHeight],
    ["tileCount", atlas.tileCount],
    ["columns", atlas.columns],
  ] as const) {
    requirePositiveSafeInteger(value, field);
  }
  for (const [field, value] of [
    ["margin", atlas.margin],
    ["spacing", atlas.spacing],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${field} must be a non-negative safe integer.`,
      );
    }
  }
}

function rgbaHeight(
  rgba: Buffer,
  width: number,
  field: string,
): number {
  requirePositiveSafeInteger(width, `${field} width`);
  const rowBytes = width * 4;
  if (
    !Number.isSafeInteger(rowBytes) ||
    rgba.byteLength === 0 ||
    rgba.byteLength % rowBytes !== 0
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${field} must contain complete four-channel RGBA rows.`,
      { width, bytes: rgba.byteLength },
    );
  }
  return rgba.byteLength / rowBytes;
}

function validateTransform(transform: AtlasTileTransform | undefined): void {
  if (transform === undefined) {
    return;
  }
  for (const [field, value] of Object.entries(transform)) {
    if (
      !["flipH", "flipV", "flipD"].includes(field) ||
      typeof value !== "boolean"
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "transform may contain only boolean flipH, flipV and flipD fields.",
      );
    }
  }
}

function blendPixel(
  canvas: Buffer,
  canvasWidth: number,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  const sourceAlpha = color[3];
  if (sourceAlpha === 0) {
    return;
  }
  const index = (y * canvasWidth + x) * 4;
  if (sourceAlpha === 255) {
    setPixel(canvas, index, color);
    return;
  }
  const destinationAlpha = canvas[index + 3] ?? 0;
  if (destinationAlpha === 0) {
    setPixel(canvas, index, color);
    return;
  }
  if (destinationAlpha === 255) {
    const inverseAlpha = 255 - sourceAlpha;
    canvas[index] = Math.round(
      (color[0] * sourceAlpha + (canvas[index] ?? 0) * inverseAlpha) /
        255,
    );
    canvas[index + 1] = Math.round(
      (color[1] * sourceAlpha +
        (canvas[index + 1] ?? 0) * inverseAlpha) /
        255,
    );
    canvas[index + 2] = Math.round(
      (color[2] * sourceAlpha +
        (canvas[index + 2] ?? 0) * inverseAlpha) /
        255,
    );
    canvas[index + 3] = 255;
    return;
  }

  const sourceAlphaUnit = sourceAlpha / 255;
  const destinationAlphaUnit = destinationAlpha / 255;
  const outputAlphaUnit =
    sourceAlphaUnit +
    destinationAlphaUnit * (1 - sourceAlphaUnit);
  const destinationWeight =
    destinationAlphaUnit * (1 - sourceAlphaUnit);
  canvas[index] = Math.round(
    (color[0] * sourceAlphaUnit +
      (canvas[index] ?? 0) * destinationWeight) /
      outputAlphaUnit,
  );
  canvas[index + 1] = Math.round(
    (color[1] * sourceAlphaUnit +
      (canvas[index + 1] ?? 0) * destinationWeight) /
      outputAlphaUnit,
  );
  canvas[index + 2] = Math.round(
    (color[2] * sourceAlphaUnit +
      (canvas[index + 2] ?? 0) * destinationWeight) /
      outputAlphaUnit,
  );
  canvas[index + 3] = Math.round(outputAlphaUnit * 255);
}

function setPixel(
  canvas: Buffer,
  index: number,
  color: readonly [number, number, number, number],
): void {
  canvas[index] = color[0];
  canvas[index + 1] = color[1];
  canvas[index + 2] = color[2];
  canvas[index + 3] = color[3];
}

function requirePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${field} must be a positive safe integer.`,
    );
  }
}

function requireSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${field} must be a safe integer.`,
    );
  }
}
