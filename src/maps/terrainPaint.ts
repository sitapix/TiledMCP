import { TiledMcpError } from "../errors.js";

export const MAX_TERRAIN_CORNERS_PER_CALL = 64;
export const TERRAIN_OK_MARKER =
  "TILEDMCP_TERRAIN_OK";
export const TERRAIN_ERROR_MARKER =
  "TILEDMCP_TERRAIN_ERR";

export interface TerrainCornerInput {
  x: number;
  y: number;
  /** 1-based wang color index; 0 (unset) is not paintable. */
  colorIndex: number;
}

/**
 * Server-authored static script for `tiled --evaluate`. Parameters are
 * embedded as one JSON string literal (double-stringified, so user data
 * can never escape the literal), and the script writes only the staging
 * output path it is given. Success and failure are reported through
 * unambiguous stdout markers because --evaluate exits 0 even when the
 * script throws.
 */
export function buildTerrainPaintScript(params: {
  sourcePath: string;
  outputPath: string;
  layerId: number;
  tilesetIndex: number;
  wangSetIndex: number;
  corners: TerrainCornerInput[];
}): string {
  const literal = JSON.stringify(
    JSON.stringify(params),
  );
  return [
    `const params = JSON.parse(${literal});`,
    "function findLayer(container) {",
    "  for (let i = 0; i < container.layerCount; i++) {",
    "    const layer = container.layerAt(i);",
    "    if (layer.isGroupLayer) {",
    "      const found = findLayer(layer);",
    "      if (found) { return found; }",
    "    } else if (layer.id === params.layerId && layer.isTileLayer) {",
    "      return layer;",
    "    }",
    "  }",
    "  return null;",
    "}",
    "try {",
    '  const format = tiled.mapFormat("json");',
    "  const map = format.read(params.sourcePath);",
    "  const layer = findLayer(map);",
    '  if (!layer) { throw new Error("layer not found"); }',
    "  const tileset = map.tilesets[params.tilesetIndex];",
    '  if (!tileset) { throw new Error("tileset not found"); }',
    "  const wangSet = tileset.wangSets[params.wangSetIndex];",
    '  if (!wangSet) { throw new Error("wang set not found"); }',
    "  const edit = layer.wangEdit(wangSet);",
    "  for (const corner of params.corners) {",
    "    edit.setCorner(corner.x, corner.y, corner.colorIndex);",
    "  }",
    "  edit.apply();",
    "  const writeError = format.write(map, params.outputPath);",
    '  if (writeError) { throw new Error("write failed: " + writeError); }',
    `  tiled.log(${JSON.stringify(TERRAIN_OK_MARKER)});`,
    "} catch (error) {",
    `  tiled.log(${JSON.stringify(TERRAIN_ERROR_MARKER)} + ": " + error);`,
    "}",
    "",
  ].join("\n");
}

export function validateTerrainCorners(
  corners: readonly TerrainCornerInput[],
  mapWidth: number,
  mapHeight: number,
  colorCount: number,
): void {
  if (
    !Array.isArray(corners) ||
    corners.length === 0 ||
    corners.length > MAX_TERRAIN_CORNERS_PER_CALL
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `corners must contain between 1 and ${MAX_TERRAIN_CORNERS_PER_CALL} entries.`,
      { limit: MAX_TERRAIN_CORNERS_PER_CALL },
    );
  }
  const seen = new Set<string>();
  for (const [index, corner] of corners.entries()) {
    const context = `corners[${index}]`;
    if (
      typeof corner !== "object" ||
      corner === null ||
      !Number.isSafeInteger(corner.x) ||
      !Number.isSafeInteger(corner.y) ||
      // The corner grid is one larger than the cell grid on each axis.
      corner.x < 0 ||
      corner.x > mapWidth ||
      corner.y < 0 ||
      corner.y > mapHeight
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} must address a corner inside the map: x in [0, ${mapWidth}], y in [0, ${mapHeight}].`,
        { mapWidth, mapHeight },
      );
    }
    if (
      !Number.isSafeInteger(corner.colorIndex) ||
      corner.colorIndex < 1 ||
      corner.colorIndex > colorCount
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.colorIndex must reference an existing 1-based wang color (the set defines ${colorCount}).`,
        { colorCount },
      );
    }
    const key = `${corner.x},${corner.y}`;
    if (seen.has(key)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} repeats corner (${corner.x}, ${corner.y}).`,
      );
    }
    seen.add(key);
  }
}

/**
 * Interprets one --evaluate run's stdout. --evaluate always exits 0, so
 * the markers are the only trustworthy signal.
 */
export function assertTerrainScriptSucceeded(
  stdout: string,
): void {
  if (stdout.includes(TERRAIN_OK_MARKER)) {
    return;
  }
  const errorLine = stdout
    .split("\n")
    .find((line) =>
      line.includes(TERRAIN_ERROR_MARKER),
    );
  throw new TiledMcpError(
    "TILED_CLI_UNEXPECTED_OUTPUT",
    errorLine === undefined
      ? "The Tiled terrain script finished without reporting success."
      : `The Tiled terrain script failed: ${errorLine.slice(errorLine.indexOf(TERRAIN_ERROR_MARKER))}`,
    {},
  );
}
