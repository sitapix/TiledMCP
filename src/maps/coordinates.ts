import { TiledMcpError } from "../errors.js";

/**
 * Faithful ports of the Tiled 1.12.2 `MapRenderer` coordinate transforms.
 *
 * Tiled exposes six conversions per renderer (`tileToScreenCoords`,
 * `screenToTileCoords`, `tileToPixelCoords`, `pixelToTileCoords`,
 * `screenToPixelCoords`, `pixelToScreenCoords`) and every renderer overrides
 * all six -- the base class declares them pure virtual. The three coordinate
 * spaces only coincide for orthogonal maps, which is exactly why hand-derived
 * isometric and hexagonal placement is such a reliable source of edits that
 * look plausible and land on the wrong cell.
 *
 * Ported from `src/libtiled/{orthogonal,isometric,hexagonal}renderer.cpp` at
 * tag `v1.12.2`. Integer division in the C++ sources is reproduced with
 * `Math.trunc`/`Math.floor` exactly where the originals rely on it: the
 * isometric screen origin, the hexagonal side offsets, and the hexagonal
 * reference-point floor all round, and dropping any of them shifts results by
 * a pixel or a whole cell.
 */

/**
 * Batch ceiling. Each conversion is a handful of arithmetic operations, so
 * this bounds the response size rather than the work.
 */
export const MAX_COORDINATE_CONVERSIONS = 256;

/**
 * Largest magnitude accepted for an input ordinate. Well inside the range
 * where doubles still represent every integer exactly, so a conversion can
 * never silently lose precision.
 */
export const MAX_COORDINATE_MAGNITUDE = 1_000_000_000;

/** Tiled's three coordinate spaces. */
export type CoordinateSpace =
  | "tile"
  | "screen"
  | "pixel";

export const COORDINATE_SPACES = [
  "tile",
  "screen",
  "pixel",
] as const satisfies readonly CoordinateSpace[];

export type ProjectionOrientation =
  | "orthogonal"
  | "isometric"
  | "staggered"
  | "hexagonal";

export interface Projection {
  orientation: ProjectionOrientation;
  /** Map `tilewidth` in pixels. */
  tileWidth: number;
  /** Map `tileheight` in pixels. */
  tileHeight: number;
  /**
   * Map height in tiles. Only isometric uses it -- the diamond's screen
   * origin is offset by half the map's widest row.
   */
  mapHeight: number;
  /** Only meaningful for staggered and hexagonal maps. */
  staggerAxis: "x" | "y";
  /** Only meaningful for staggered and hexagonal maps. */
  staggerIndex: "odd" | "even";
  /** Hexagonal side length; staggered maps are the degenerate 0 case. */
  hexSideLength: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * `HexagonalRenderer::RenderParams`. `tileWidth`/`tileHeight` here are
 * *derived* (`columnWidth + sideOffsetX`) and differ from the map's declared
 * tile size by one pixel whenever the halving is lossy -- `screenToTileCoords`
 * reads the derived values, so the distinction is load-bearing.
 */
interface HexRenderParams {
  tileWidth: number;
  tileHeight: number;
  sideLengthX: number;
  sideOffsetX: number;
  sideLengthY: number;
  sideOffsetY: number;
  rowHeight: number;
  columnWidth: number;
  staggerX: boolean;
  staggerEven: boolean;
}

/**
 * The map geometry the hexagonal renderer family reads. Staggered maps are the
 * degenerate `hexSideLength: 0` case, exactly as in Tiled's own class
 * hierarchy (`StaggeredRenderer` extends `HexagonalRenderer`).
 */
export interface HexagonalGeometry {
  tileWidth: number;
  tileHeight: number;
  hexSideLength: number;
  staggerAxis: "x" | "y";
  staggerIndex: "odd" | "even";
}

function hexagonalGeometryOf(
  projection: Projection,
): HexagonalGeometry {
  return {
    tileWidth: projection.tileWidth,
    tileHeight: projection.tileHeight,
    // RenderParams only reads hexSideLength for Map::Hexagonal; staggered maps
    // keep both side lengths at zero.
    hexSideLength:
      projection.orientation === "hexagonal"
        ? projection.hexSideLength
        : 0,
    staggerAxis: projection.staggerAxis,
    staggerIndex: projection.staggerIndex,
  };
}

function hexRenderParams(
  geometry: HexagonalGeometry,
): HexRenderParams {
  const staggerX = geometry.staggerAxis === "x";
  const sideLengthX = staggerX
    ? geometry.hexSideLength
    : 0;
  const sideLengthY = staggerX
    ? 0
    : geometry.hexSideLength;
  const sideOffsetX = Math.trunc(
    (geometry.tileWidth - sideLengthX) / 2,
  );
  const sideOffsetY = Math.trunc(
    (geometry.tileHeight - sideLengthY) / 2,
  );
  const columnWidth = sideOffsetX + sideLengthX;
  const rowHeight = sideOffsetY + sideLengthY;
  return {
    tileWidth: columnWidth + sideOffsetX,
    tileHeight: rowHeight + sideOffsetY,
    sideLengthX,
    sideOffsetX,
    sideLengthY,
    sideOffsetY,
    rowHeight,
    columnWidth,
    staggerX,
    staggerEven:
      geometry.staggerIndex === "even",
  };
}

/** `IsometricRenderer`'s `originX`: an int, so the division truncates. */
function isometricOriginX(
  projection: Projection,
): number {
  return Math.trunc(
    (projection.mapHeight *
      projection.tileWidth) /
      2,
  );
}

function orthogonalTileToScreen(
  projection: Projection,
  point: Point,
): Point {
  return {
    x: point.x * projection.tileWidth,
    y: point.y * projection.tileHeight,
  };
}

function orthogonalScreenToTile(
  projection: Projection,
  point: Point,
): Point {
  return {
    x: point.x / projection.tileWidth,
    y: point.y / projection.tileHeight,
  };
}

function isometricTileToScreen(
  projection: Projection,
  point: Point,
): Point {
  return {
    x:
      ((point.x - point.y) *
        projection.tileWidth) /
        2 +
      isometricOriginX(projection),
    y:
      ((point.x + point.y) *
        projection.tileHeight) /
      2,
  };
}

function isometricScreenToTile(
  projection: Projection,
  point: Point,
): Point {
  const x =
    point.x - isometricOriginX(projection);
  const tileY = point.y / projection.tileHeight;
  const tileX = x / projection.tileWidth;
  return { x: tileY + tileX, y: tileY - tileX };
}

function isometricScreenToPixel(
  projection: Projection,
  point: Point,
): Point {
  const x =
    point.x - isometricOriginX(projection);
  const tileY = point.y / projection.tileHeight;
  const tileX = x / projection.tileWidth;
  return {
    x: (tileY + tileX) * projection.tileHeight,
    y: (tileY - tileX) * projection.tileHeight,
  };
}

function isometricPixelToScreen(
  projection: Projection,
  point: Point,
): Point {
  // Both axes divide by tileHeight here: isometric pixel coordinates are
  // expressed in tile-height units, which is why object x/y in an isometric
  // map does not scale with tileWidth.
  const tileY = point.y / projection.tileHeight;
  const tileX = point.x / projection.tileHeight;
  return {
    x:
      ((tileX - tileY) * projection.tileWidth) /
        2 +
      isometricOriginX(projection),
    y:
      ((tileX + tileY) * projection.tileHeight) /
      2,
  };
}

function isometricTileToPixel(
  projection: Projection,
  point: Point,
): Point {
  return {
    x: point.x * projection.tileHeight,
    y: point.y * projection.tileHeight,
  };
}

function isometricPixelToTile(
  projection: Projection,
  point: Point,
): Point {
  return {
    x: point.x / projection.tileHeight,
    y: point.y / projection.tileHeight,
  };
}

/**
 * `HexagonalRenderer::tileToScreenCoords`. The C++ floors both inputs to whole
 * cells and then works in ints, so the result is always an integer pixel. Note
 * that it reads the *derived* `RenderParams` tile size rather than the map's
 * declared one -- the two differ by a pixel whenever `tileSize - sideLength`
 * is odd.
 */
export function hexagonalTileToScreen(
  geometry: HexagonalGeometry,
  x: number,
  y: number,
): Point {
  const p = hexRenderParams(geometry);
  const tileX = Math.floor(x);
  const tileY = Math.floor(y);
  const doStaggerX =
    p.staggerX &&
    ((tileX & 1) ^ (p.staggerEven ? 1 : 0)) !== 0;
  const doStaggerY =
    !p.staggerX &&
    ((tileY & 1) ^ (p.staggerEven ? 1 : 0)) !== 0;
  if (p.staggerX) {
    return {
      x: tileX * p.columnWidth,
      y:
        tileY * (p.tileHeight + p.sideLengthY) +
        (doStaggerX ? p.rowHeight : 0),
    };
  }
  return {
    x:
      tileX * (p.tileWidth + p.sideLengthX) +
      (doStaggerY ? p.columnWidth : 0),
    y: tileY * p.rowHeight,
  };
}

/**
 * `HexagonalRenderer::screenToTileCoords`. Unlike the orthogonal and
 * isometric inverses this returns a whole cell rather than a fractional tile
 * coordinate: it snaps to the nearest of four candidate hexagon centers, so
 * there is no meaningful sub-cell remainder to report.
 */
function hexScreenToTile(
  projection: Projection,
  point: Point,
): Point {
  const p = hexRenderParams(
    hexagonalGeometryOf(projection),
  );
  let x = point.x;
  let y = point.y;
  if (p.staggerX) {
    x -= p.staggerEven
      ? p.tileWidth
      : p.sideOffsetX;
  } else {
    y -= p.staggerEven
      ? p.tileHeight
      : p.sideOffsetY;
  }

  let referenceX = Math.floor(
    x / (p.columnWidth * 2),
  );
  let referenceY = Math.floor(
    y / (p.rowHeight * 2),
  );
  const relX =
    x - referenceX * (p.columnWidth * 2);
  const relY =
    y - referenceY * (p.rowHeight * 2);

  if (p.staggerX) {
    referenceX *= 2;
    if (p.staggerEven) {
      referenceX += 1;
    }
  } else {
    referenceY *= 2;
    if (p.staggerEven) {
      referenceY += 1;
    }
  }

  let centers: readonly Point[];
  let offsets: readonly Point[];
  if (p.staggerX) {
    const left = Math.trunc(p.sideLengthX / 2);
    const centerX = left + p.columnWidth;
    const centerY = Math.trunc(p.tileHeight / 2);
    centers = [
      { x: left, y: centerY },
      {
        x: centerX,
        y: centerY - p.rowHeight,
      },
      {
        x: centerX,
        y: centerY + p.rowHeight,
      },
      {
        x: centerX + p.columnWidth,
        y: centerY,
      },
    ];
    offsets = [
      { x: 0, y: 0 },
      { x: 1, y: -1 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];
  } else {
    const top = Math.trunc(p.sideLengthY / 2);
    const centerX = Math.trunc(p.tileWidth / 2);
    const centerY = top + p.rowHeight;
    centers = [
      { x: centerX, y: top },
      {
        x: centerX - p.columnWidth,
        y: centerY,
      },
      {
        x: centerX + p.columnWidth,
        y: centerY,
      },
      {
        x: centerX,
        y: centerY + p.rowHeight,
      },
    ];
    offsets = [
      { x: 0, y: 0 },
      { x: -1, y: 1 },
      { x: 0, y: 1 },
      { x: 0, y: 2 },
    ];
  }

  let nearest = 0;
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (const [index, center] of centers.entries()) {
    const dx = center.x - relX;
    const dy = center.y - relY;
    const distance = dx * dx + dy * dy;
    // Strict `<` keeps Qt's tie-breaking: the lowest index wins.
    if (distance < minimumDistance) {
      minimumDistance = distance;
      nearest = index;
    }
  }

  const offset = offsets[nearest] as Point;
  return {
    x: referenceX + offset.x,
    y: referenceY + offset.y,
  };
}

/**
 * Whether the inverse into tile space yields a whole cell rather than a
 * fractional tile coordinate. True only for the hexagonal renderer family.
 */
export function tileSpaceIsDiscrete(
  orientation: ProjectionOrientation,
): boolean {
  return (
    orientation === "staggered" ||
    orientation === "hexagonal"
  );
}

function convertViaScreen(
  projection: Projection,
  from: CoordinateSpace,
  to: CoordinateSpace,
  point: Point,
): Point {
  // Orthogonal, staggered and hexagonal all inherit OrthogonalRenderer's
  // identity pixel<->screen mapping (HexagonalRenderer extends
  // OrthogonalRenderer and overrides neither), so only the isometric
  // renderer needs distinct pixel conversions.
  const isometric =
    projection.orientation === "isometric";

  if (from === to) {
    return { x: point.x, y: point.y };
  }

  if (from === "tile") {
    if (to === "screen") {
      return projection.orientation ===
        "orthogonal"
        ? orthogonalTileToScreen(
            projection,
            point,
          )
        : isometric
          ? isometricTileToScreen(
              projection,
              point,
            )
          : hexagonalTileToScreen(
              hexagonalGeometryOf(projection),
              point.x,
              point.y,
            );
    }
    // to === "pixel"
    return isometric
      ? isometricTileToPixel(projection, point)
      : convertViaScreen(
          projection,
          "tile",
          "screen",
          point,
        );
  }

  if (from === "screen") {
    if (to === "tile") {
      return projection.orientation ===
        "orthogonal"
        ? orthogonalScreenToTile(
            projection,
            point,
          )
        : isometric
          ? isometricScreenToTile(
              projection,
              point,
            )
          : hexScreenToTile(projection, point);
    }
    // to === "pixel"
    return isometric
      ? isometricScreenToPixel(projection, point)
      : { x: point.x, y: point.y };
  }

  // from === "pixel"
  if (to === "screen") {
    return isometric
      ? isometricPixelToScreen(projection, point)
      : { x: point.x, y: point.y };
  }
  // to === "tile"
  return isometric
    ? isometricPixelToTile(projection, point)
    : convertViaScreen(
        projection,
        "screen",
        "tile",
        point,
      );
}

export interface CoordinateConversion {
  from: CoordinateSpace;
  to: CoordinateSpace;
  point: Point;
}

export interface ConvertedCoordinate {
  from: CoordinateSpace;
  to: CoordinateSpace;
  input: Point;
  output: Point;
  /**
   * The whole cell containing `output`, present only when converting into
   * tile space. For hexagonal and staggered maps it equals `output`, which is
   * already discrete.
   */
  cell?: Point;
}

/** Rejects a projection whose declared geometry cannot produce a transform. */
export function assertUsableProjection(
  projection: Projection,
  mapPath: string,
): void {
  if (
    !Number.isInteger(projection.tileWidth) ||
    projection.tileWidth <= 0 ||
    !Number.isInteger(projection.tileHeight) ||
    projection.tileHeight <= 0
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${mapPath} must declare a positive integer tilewidth and tileheight to convert coordinates.`,
      {
        tileWidth: projection.tileWidth,
        tileHeight: projection.tileHeight,
      },
    );
  }
  if (!tileSpaceIsDiscrete(projection.orientation)) {
    return;
  }
  const p = hexRenderParams(
    hexagonalGeometryOf(projection),
  );
  if (p.columnWidth <= 0 || p.rowHeight <= 0) {
    // A zero column width or row height makes the reference-point division in
    // screenToTileCoords undefined; Tiled never produces such a map, so fail
    // closed rather than emit an infinity.
    throw new TiledMcpError(
      "UNSUPPORTED_MAP_PROFILE",
      `${mapPath} declares a hexagonal geometry with a non-positive column width or row height, which has no defined screen transform.`,
      {
        columnWidth: p.columnWidth,
        rowHeight: p.rowHeight,
        hexSideLength: projection.hexSideLength,
      },
    );
  }
  if (
    projection.orientation === "hexagonal" &&
    (!Number.isInteger(
      projection.hexSideLength,
    ) ||
      projection.hexSideLength < 0)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${mapPath} must declare a non-negative integer hexsidelength.`,
      {
        hexSideLength: projection.hexSideLength,
      },
    );
  }
}

/**
 * Applies one batch of conversions against a single projection. Pure: the
 * caller owns document loading, bounds policy and revision pinning.
 */
export function convertCoordinates(
  projection: Projection,
  conversions: readonly CoordinateConversion[],
): ConvertedCoordinate[] {
  return conversions.map((conversion) => {
    const output = convertViaScreen(
      projection,
      conversion.from,
      conversion.to,
      conversion.point,
    );
    const converted: ConvertedCoordinate = {
      from: conversion.from,
      to: conversion.to,
      input: {
        x: conversion.point.x,
        y: conversion.point.y,
      },
      output,
    };
    if (conversion.to === "tile") {
      converted.cell = {
        x: Math.floor(output.x),
        y: Math.floor(output.y),
      };
    }
    return converted;
  });
}
