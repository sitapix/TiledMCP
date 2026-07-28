import { posix } from "node:path";

import { TiledMcpError } from "../errors.js";
import {
  cloneJson,
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

export const MAX_WORLD_EDIT_OPERATIONS = 32;
const WORLD_EDIT_PLAN_HASH_DOMAIN =
  "tiledmcp/world-edit-plan/v1\0";

export type WorldEditOperation =
  | {
      type: "addMap";
      fileName: string;
      x: number;
      y: number;
      width?: number;
      height?: number;
    }
  | {
      type: "moveMap";
      index: number;
      x: number;
      y: number;
    }
  | { type: "removeMap"; index: number };

export interface WorldEditPlan {
  kind: "worldEdit";
  version: 1;
  id: string;
  worldPath: string;
  baseRevision: string;
  operations: WorldEditOperation[];
  summary: {
    operationCount: number;
    memberCountBefore: number;
    memberCountAfter: number;
    added: Array<{
      index: number;
      fileName: string;
    }>;
    moved: Array<{
      index: number;
      fileName: string;
      from: { x: number; y: number };
      to: { x: number; y: number };
    }>;
    removed: Array<{
      index: number;
      fileName: string;
    }>;
    wouldChange: boolean;
  };
}

export function worldEditPlanId(
  value: Omit<WorldEditPlan, "id">,
  hash: (domain: string, json: string) => string,
): string {
  return hash(
    WORLD_EDIT_PLAN_HASH_DOMAIN,
    JSON.stringify(value),
  );
}

/**
 * Validates and replays world member edits against the parsed document,
 * returning the mutated maps array plus the plan summary. Members are
 * addressed by their current array index under the world's revision pin;
 * removals and moves resolve against the original indices, and additions
 * append in operation order like Tiled's own world editing.
 */
export function applyWorldEditOperations(
  document: JsonObject,
  worldPath: string,
  operations: readonly WorldEditOperation[],
): {
  maps: JsonValue[];
  summary: WorldEditPlan["summary"];
} {
  if (
    !Array.isArray(operations) ||
    operations.length === 0 ||
    operations.length > MAX_WORLD_EDIT_OPERATIONS
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `operations must contain between 1 and ${MAX_WORLD_EDIT_OPERATIONS} world edits.`,
      { limit: MAX_WORLD_EDIT_OPERATIONS },
    );
  }
  const projection = projectWorldDocument(
    document,
    worldPath,
  );
  const before = (document.maps ??
    []) as JsonValue[];
  const working = before.map((entry) =>
    cloneJson(entry),
  );
  const memberCountBefore = working.length;
  const touchedIndices = new Set<number>();
  const removedIndices = new Set<number>();
  const added: WorldEditPlan["summary"]["added"] =
    [];
  const moved: WorldEditPlan["summary"]["moved"] =
    [];
  const removed: WorldEditPlan["summary"]["removed"] =
    [];
  let wouldChange = false;

  const boundedCoordinate = (
    value: unknown,
    context: string,
  ): number => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      Math.abs(value) > 1_000_000_000
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} must be a bounded integer.`,
        { context },
      );
    }
    return value;
  };
  const requireOriginalMember = (
    index: unknown,
    context: string,
  ): { index: number; entry: JsonObject } => {
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= memberCountBefore
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} must reference an existing member index between 0 and ${memberCountBefore - 1}.`,
        { context, memberCount: memberCountBefore },
      );
    }
    if (touchedIndices.has(index)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} targets member ${index}, which another operation in this change set already edits.`,
        { context, index },
      );
    }
    touchedIndices.add(index);
    return {
      index,
      entry: working[index] as JsonObject,
    };
  };

  for (const [
    operationIndex,
    operation,
  ] of operations.entries()) {
    const context = `operations[${operationIndex}]`;
    if (operation.type === "addMap") {
      if (
        typeof operation.fileName !== "string" ||
        operation.fileName.length === 0 ||
        operation.fileName.length > 4_096
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context}.fileName must be a nonempty bounded string.`,
          { context },
        );
      }
      const x = boundedCoordinate(
        operation.x,
        `${context}.x`,
      );
      const y = boundedCoordinate(
        operation.y,
        `${context}.y`,
      );
      const width =
        operation.width === undefined
          ? 0
          : boundedCoordinate(
              operation.width,
              `${context}.width`,
            );
      const height =
        operation.height === undefined
          ? 0
          : boundedCoordinate(
              operation.height,
              `${context}.height`,
            );
      if (width < 0 || height < 0) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context} declared size must be nonnegative.`,
          { context },
        );
      }
      working.push({
        fileName: operation.fileName,
        x,
        y,
        width,
        height,
      });
      added.push({
        index: working.length - 1,
        fileName: operation.fileName,
      });
      wouldChange = true;
    } else if (operation.type === "moveMap") {
      const { index, entry } =
        requireOriginalMember(
          operation.index,
          `${context}.index`,
        );
      const original =
        projection.members[index];
      if (original === undefined) {
        throw new TiledMcpError(
          "INTERNAL_ERROR",
          `${worldPath} member ${index} disappeared during planning.`,
        );
      }
      const x = boundedCoordinate(
        operation.x,
        `${context}.x`,
      );
      const y = boundedCoordinate(
        operation.y,
        `${context}.y`,
      );
      moved.push({
        index,
        fileName: original.fileName,
        from: { x: original.x, y: original.y },
        to: { x, y },
      });
      if (original.x !== x || original.y !== y) {
        entry.x = x;
        entry.y = y;
        wouldChange = true;
      }
    } else if (operation.type === "removeMap") {
      const { index } = requireOriginalMember(
        operation.index,
        `${context}.index`,
      );
      const original =
        projection.members[index];
      if (original === undefined) {
        throw new TiledMcpError(
          "INTERNAL_ERROR",
          `${worldPath} member ${index} disappeared during planning.`,
        );
      }
      removedIndices.add(index);
      removed.push({
        index,
        fileName: original.fileName,
      });
      wouldChange = true;
    } else {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.type must be addMap, moveMap or removeMap.`,
        { context },
      );
    }
  }

  const maps = working.filter(
    (_entry, index) =>
      index >= memberCountBefore ||
      !removedIndices.has(index),
  );
  if (maps.length > MAX_WORLD_MAP_MEMBERS) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${worldPath} would list more than ${MAX_WORLD_MAP_MEMBERS} world map members.`,
      { limit: MAX_WORLD_MAP_MEMBERS },
    );
  }
  return {
    maps,
    summary: {
      operationCount: operations.length,
      memberCountBefore,
      memberCountAfter: maps.length,
      added,
      moved,
      removed,
      wouldChange,
    },
  };
}

export interface WorldPatternProjection {
  regexp: string;
  multiplierX: number;
  multiplierY: number;
  offsetX: number;
  offsetY: number;
  mapWidth: number;
  mapHeight: number;
}

/**
 * Projects pattern definitions with World::load's exact validation:
 * multipliers default to 1 and must be nonzero, the map size defaults to
 * the absolute multiplier and must be positive, and the regexp must
 * carry exactly two capture groups (x then y).
 */
export function projectWorldPatterns(
  document: JsonObject,
  worldPath: string,
): WorldPatternProjection[] {
  const raw = document.patterns ?? [];
  if (!Array.isArray(raw)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${worldPath}.patterns must be an array.`,
      { path: worldPath },
    );
  }
  return raw.map((value, index) => {
    const context = `${worldPath}.patterns[${index}]`;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context} must be an object.`,
        { path: worldPath, index },
      );
    }
    const pattern = value as JsonObject;
    const source = pattern.regexp;
    if (
      typeof source !== "string" ||
      source.length === 0 ||
      source.length > 256
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.regexp must be a non-empty string of at most 256 characters.`,
        { path: worldPath, index },
      );
    }
    let compiled: RegExp;
    try {
      compiled = new RegExp(source, "u");
    } catch {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        `${context}.regexp is not a supported regular expression.`,
        { path: worldPath, index },
      );
    }
    // Count capture groups by matching an alternation that always hits.
    const groupCount =
      new RegExp(`|${source}`, "u").exec("")!
        .length - 1;
    if (groupCount !== 2) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        `${context}.regexp must carry exactly 2 capture groups (x then y); it has ${groupCount}.`,
        { path: worldPath, index, groupCount },
      );
    }
    void compiled;
    const multiplierX = patternInteger(
      pattern.multiplierX,
      1,
      `${context}.multiplierX`,
      worldPath,
    );
    const multiplierY = patternInteger(
      pattern.multiplierY,
      1,
      `${context}.multiplierY`,
      worldPath,
    );
    if (multiplierX === 0 || multiplierY === 0) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context} multipliers must be nonzero.`,
        { path: worldPath, index },
      );
    }
    const mapWidth = patternInteger(
      pattern.mapWidth,
      Math.abs(multiplierX),
      `${context}.mapWidth`,
      worldPath,
    );
    const mapHeight = patternInteger(
      pattern.mapHeight,
      Math.abs(multiplierY),
      `${context}.mapHeight`,
      worldPath,
    );
    if (mapWidth <= 0 || mapHeight <= 0) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context} map size must be positive.`,
        { path: worldPath, index },
      );
    }
    return {
      regexp: source,
      multiplierX,
      multiplierY,
      offsetX: patternInteger(
        pattern.offsetX,
        0,
        `${context}.offsetX`,
        worldPath,
      ),
      offsetY: patternInteger(
        pattern.offsetY,
        0,
        `${context}.offsetY`,
        worldPath,
      ),
      mapWidth,
      mapHeight,
    };
  });
}

/**
 * Expands patterns against a same-directory file list with
 * World::allMaps semantics: every pattern tests every file name with a
 * partial match, matched entries append in pattern-then-file order, and
 * nothing is deduplicated against explicit members.
 */
export function expandWorldPatterns(
  patterns: readonly WorldPatternProjection[],
  fileNames: readonly string[],
): Array<{
  fileName: string;
  patternIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const expanded: Array<{
    fileName: string;
    patternIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [];
  for (const [
    patternIndex,
    pattern,
  ] of patterns.entries()) {
    const compiled = new RegExp(
      pattern.regexp,
      "u",
    );
    for (const fileName of fileNames) {
      const match = compiled.exec(fileName);
      if (match === null) {
        continue;
      }
      const x = Number.parseInt(
        match[1] ?? "",
        10,
      );
      const y = Number.parseInt(
        match[2] ?? "",
        10,
      );
      expanded.push({
        fileName,
        patternIndex,
        x:
          (Number.isNaN(x) ? 0 : x) *
            pattern.multiplierX +
          pattern.offsetX,
        y:
          (Number.isNaN(y) ? 0 : y) *
            pattern.multiplierY +
          pattern.offsetY,
        width: pattern.mapWidth,
        height: pattern.mapHeight,
      });
      if (
        expanded.length > MAX_WORLD_MAP_MEMBERS
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `Pattern expansion exceeds ${MAX_WORLD_MAP_MEMBERS} members.`,
          { limit: MAX_WORLD_MAP_MEMBERS },
        );
      }
    }
  }
  return expanded;
}

function patternInteger(
  value: JsonValue | undefined,
  fallback: number,
  context: string,
  worldPath: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Math.abs(value) > 1_000_000_000
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must be a bounded integer.`,
      { path: worldPath },
    );
  }
  return value;
}
