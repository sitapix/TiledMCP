import { posix } from "node:path";

import { TiledMcpError } from "../errors.js";
import {
  expectArray,
  expectObject,
  type JsonObject,
  type JsonValue,
} from "../formats/json.js";
import {
  projectScalarProperties,
  type ProjectedProperties,
} from "./propertyEdits.js";

export const MAX_WORLD_MAP_MEMBERS = 1_000;

export interface WorldMapMemberProjection {
  fileName: string;
  x: number;
  y: number;
  /**
   * Null when the world declares no positive size for the member; Tiled
   * then derives the display size from the map file itself.
   */
  declaredSize: {
    width: number;
    height: number;
  } | null;
}

export interface WorldProjection {
  onlyShowAdjacentMaps: boolean;
  members: WorldMapMemberProjection[];
  /**
   * Pattern-based members stay unexpanded: matching them requires a
   * bounded filesystem scan this read-only projection does not perform.
   */
  patternCount: number;
  properties: ProjectedProperties;
}

function readBoundedInteger(
  value: JsonValue | undefined,
  context: string,
  worldPath: string,
): number {
  if (value === undefined) {
    return 0;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Math.abs(value) > 1_000_000_000
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must be a bounded integer.`,
      { path: worldPath, context },
    );
  }
  return value;
}

/**
 * Projects one JSON world document with Tiled 1.12.2 reader semantics:
 * member fileName references resolve against the world's own directory,
 * missing coordinates read as 0, and a non-positive declared size means
 * the map file decides. Patterns are counted, never matched.
 */
export function projectWorldDocument(
  document: JsonObject,
  worldPath: string,
): WorldProjection {
  const mapsValue = document.maps ?? [];
  const maps = expectArray(
    mapsValue,
    `${worldPath}.maps`,
  );
  if (maps.length > MAX_WORLD_MAP_MEMBERS) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${worldPath} lists more than ${MAX_WORLD_MAP_MEMBERS} world map members.`,
      {
        path: worldPath,
        limit: MAX_WORLD_MAP_MEMBERS,
        actual: maps.length,
      },
    );
  }
  const members: WorldMapMemberProjection[] = [];
  for (const [index, value] of maps.entries()) {
    const entry = expectObject(
      value,
      `${worldPath}.maps[${index}]`,
    );
    const fileName = entry.fileName;
    if (
      typeof fileName !== "string" ||
      fileName.length === 0
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${worldPath}.maps[${index}].fileName must be a nonempty string.`,
        { path: worldPath, index },
      );
    }
    const width = readBoundedInteger(
      entry.width,
      `${worldPath}.maps[${index}].width`,
      worldPath,
    );
    const height = readBoundedInteger(
      entry.height,
      `${worldPath}.maps[${index}].height`,
      worldPath,
    );
    members.push({
      fileName,
      x: readBoundedInteger(
        entry.x,
        `${worldPath}.maps[${index}].x`,
        worldPath,
      ),
      y: readBoundedInteger(
        entry.y,
        `${worldPath}.maps[${index}].y`,
        worldPath,
      ),
      declaredSize:
        width > 0 && height > 0
          ? { width, height }
          : null,
    });
  }
  const patternsValue = document.patterns ?? [];
  const patterns = expectArray(
    patternsValue,
    `${worldPath}.patterns`,
  );
  const properties = projectScalarProperties(
    document,
    `${worldPath}.properties`,
    { path: worldPath },
  );
  return {
    onlyShowAdjacentMaps:
      document.onlyShowAdjacentMaps === true,
    members,
    patternCount: patterns.length,
    properties,
  };
}

export function assertWorldPath(
  worldPath: string,
): void {
  if (
    posix.extname(worldPath).toLowerCase() !==
    ".world"
  ) {
    throw new TiledMcpError(
      "UNSUPPORTED_FORMAT",
      "World reading requires a .world file.",
      { path: worldPath },
    );
  }
}
