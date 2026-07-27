import { createHash } from "node:crypto";

import { TiledMcpError } from "../errors.js";
import {
  stableJson,
  type JsonObject,
  type JsonValue,
} from "../formats/json.js";
import type { JsonObjectMemberPatch } from "../formats/jsonSourcePatch.js";
import {
  MAX_TILESET_WANG_COLORS_PER_SET,
  WANG_ID_INDEX_COUNT,
} from "./tilesetDetails.js";

export const MAX_WANG_EDIT_OPERATIONS = 32;
export const MAX_WANG_ASSIGNMENTS_PER_OPERATION = 64;
export const MAX_WANG_NAME_CODE_POINTS = 1_024;
export const MAX_WANG_SETS_PER_TILESET = 100;
export const MAX_WANG_TILES_PER_SET_WRITE = 10_000;

const WANG_EDIT_PLAN_HASH_DOMAIN =
  "tiledmcp/wang-edit-plan/v1\0";
const WANG_COLOR_PATTERN =
  /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u;
const WANG_SET_TYPES = [
  "corner",
  "edge",
  "mixed",
] as const;

export interface WangColorInput {
  name: string;
  /** #rrggbb or #aarrggbb, serialized verbatim. */
  color: string;
  /** Tiled's WangColor constructor default is 1. */
  probability?: number | undefined;
  /** -1 (Tiled's "no tile" default) or an existing local tile id. */
  imageTileId?: number | undefined;
}

export type WangEditOperation =
  | {
      type: "addWangSet";
      name: string;
      wangSetType: (typeof WANG_SET_TYPES)[number];
      className?: string | undefined;
      /** -1 (default) or an existing local tile id. */
      imageTileId?: number | undefined;
      colors?: WangColorInput[] | undefined;
    }
  | {
      type: "addWangColor";
      wangSetIndex: number;
      color: WangColorInput;
    }
  | {
      type: "setWangTiles";
      wangSetIndex: number;
      /**
       * Tiled setWangId semantics per assignment: an all-zero wangId
       * removes the tile's entry, an identical wangId is a no-op, and
       * anything else upserts. The whole wangtiles member is rewritten
       * in Tiled's canonical ascending-tileId save order.
       */
      assignments: Array<{
        tileId: number;
        wangId: number[];
      }>;
    };

export interface WangEditSummary {
  operationCount: number;
  addedWangSets: Array<{
    index: number;
    name: string;
    colorCount: number;
  }>;
  addedColors: Array<{
    wangSetIndex: number;
    /** 1-based; this is the value wangId slots reference. */
    colorIndex: number;
  }>;
  assignmentChanges: Array<{
    wangSetIndex: number;
    upserts: number;
    removals: number;
    noOps: number;
  }>;
  wouldChange: boolean;
}

export interface WangEditPlan {
  kind: "wangEdit";
  version: 1;
  id: string;
  mapPath: string;
  tilesetPath: string;
  assetId: string;
  /** Raw SHA-256 revision of the edited TSJ (CAS + registry guard). */
  baseRevision: string;
  mapRevision: string;
  operations: WangEditOperation[];
  summary: WangEditSummary;
}

export interface WangEditSourcePatches {
  /**
   * Always the single root-level `wangsets` member: mixing appended sets
   * with per-set member rewrites would need overlapping source-patch
   * paths, which the patcher rejects, so a touched `wangsets` member is
   * synchronized wholesale (the world-edit `maps` member precedent).
   */
  memberPatches: JsonObjectMemberPatch[];
}

export function wangEditPlanId(
  value: Omit<WangEditPlan, "id">,
): string {
  return `changeset:${createHash("sha256")
    .update(WANG_EDIT_PLAN_HASH_DOMAIN)
    .update(stableJson(value as unknown as JsonValue))
    .digest("hex")}`;
}

export function assertWangEditPlan(
  plan: WangEditPlan,
): void {
  if (
    typeof plan !== "object" ||
    plan === null ||
    plan.kind !== "wangEdit" ||
    plan.version !== 1 ||
    typeof plan.id !== "string" ||
    typeof plan.mapPath !== "string" ||
    typeof plan.tilesetPath !== "string" ||
    typeof plan.assetId !== "string" ||
    typeof plan.baseRevision !== "string" ||
    typeof plan.mapRevision !== "string" ||
    !Array.isArray(plan.operations) ||
    typeof plan.summary !== "object" ||
    plan.summary === null
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The wang edit plan is malformed.",
    );
  }
  const { id, ...unsigned } = plan;
  if (id !== wangEditPlanId(unsigned)) {
    throw new TiledMcpError(
      "CHANGE_SET_TAMPERED",
      "The wang edit plan contents do not match its digest. Preview the operations again.",
    );
  }
}

/**
 * Validates and applies wang edits sequentially to the parsed tileset
 * document, returning the summary plus minimal source patches. Later
 * operations observe earlier ones, so a color added by operation 0 is a
 * valid wangId reference in operation 1. The document must already have
 * passed the bounded atlas tileset write-profile gate.
 */
export function applyWangEditOperations(
  document: JsonObject,
  tilesetPath: string,
  tileCount: number,
  operations: readonly WangEditOperation[],
): {
  summary: WangEditSummary;
  patches: WangEditSourcePatches;
} {
  if (
    !Array.isArray(operations) ||
    operations.length === 0 ||
    operations.length > MAX_WANG_EDIT_OPERATIONS
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `operations must contain between 1 and ${MAX_WANG_EDIT_OPERATIONS} wang edits.`,
      { limit: MAX_WANG_EDIT_OPERATIONS },
    );
  }

  const hadWangSetsMember =
    document.wangsets !== undefined;
  const wangSets =
    document.wangsets === undefined
      ? []
      : (document.wangsets as JsonValue[]);
  if (!Array.isArray(wangSets)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${tilesetPath}.wangsets must be an array.`,
      { path: tilesetPath },
    );
  }

  const addedWangSets: WangEditSummary["addedWangSets"] =
    [];
  const addedColors: WangEditSummary["addedColors"] =
    [];
  const assignmentChanges: WangEditSummary["assignmentChanges"] =
    [];
  const seenAssignmentKeys = new Set<string>();
  let wouldChange = false;

  for (const [
    operationIndex,
    operation,
  ] of operations.entries()) {
    const context = `operations[${operationIndex}]`;
    if (
      typeof operation !== "object" ||
      operation === null
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} must be an object.`,
      );
    }
    if (operation.type === "addWangSet") {
      if (
        wangSets.length >= MAX_WANG_SETS_PER_TILESET
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `${tilesetPath} already carries ${wangSets.length} Wang sets; at most ${MAX_WANG_SETS_PER_TILESET} are writable.`,
          {
            path: tilesetPath,
            limit: MAX_WANG_SETS_PER_TILESET,
          },
        );
      }
      const name = requiredBoundedName(
        operation.name,
        `${context}.name`,
      );
      if (
        !WANG_SET_TYPES.includes(
          operation.wangSetType,
        )
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context}.wangSetType must be corner, edge or mixed.`,
        );
      }
      const imageTileId = optionalImageTileId(
        operation.imageTileId,
        `${context}.imageTileId`,
        tileCount,
      );
      const colorInputs = operation.colors ?? [];
      if (!Array.isArray(colorInputs)) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context}.colors must be an array when present.`,
        );
      }
      if (
        colorInputs.length >
        MAX_TILESET_WANG_COLORS_PER_SET
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context}.colors exceeds the ${MAX_TILESET_WANG_COLORS_PER_SET} colors Tiled supports per Wang set.`,
          {
            limit: MAX_TILESET_WANG_COLORS_PER_SET,
          },
        );
      }
      const colors = colorInputs.map(
        (color, colorIndex) =>
          serializeWangColor(
            color,
            `${context}.colors[${colorIndex}]`,
            tileCount,
          ),
      );
      const className =
        operation.className === undefined
          ? undefined
          : requiredBoundedName(
              operation.className,
              `${context}.className`,
            );
      // Member order mirrors MapToVariantConverter::toVariant(WangSet).
      const wangSet: JsonObject = {
        name,
        ...(className === undefined
          ? {}
          : { class: className }),
        type: operation.wangSetType,
        tile: imageTileId,
        colors,
        wangtiles: [],
      };
      const index = wangSets.length;
      wangSets.push(wangSet);
      addedWangSets.push({
        index,
        name,
        colorCount: colors.length,
      });
      wouldChange = true;
    } else if (operation.type === "addWangColor") {
      const { wangSet, wangSetIndex } =
        requireWritableWangSet(
          wangSets,
          operation.wangSetIndex,
          context,
          tilesetPath,
        );
      const colors = requireArrayMember(
        wangSet,
        "colors",
        wangSetIndex,
        tilesetPath,
      );
      if (
        colors.length >=
        MAX_TILESET_WANG_COLORS_PER_SET
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context} would exceed the ${MAX_TILESET_WANG_COLORS_PER_SET} colors Tiled supports per Wang set.`,
          {
            wangSetIndex,
            limit: MAX_TILESET_WANG_COLORS_PER_SET,
          },
        );
      }
      colors.push(
        serializeWangColor(
          operation.color,
          `${context}.color`,
          tileCount,
        ),
      );
      wangSet.colors = colors;
      addedColors.push({
        wangSetIndex,
        colorIndex: colors.length,
      });
      wouldChange = true;
    } else if (operation.type === "setWangTiles") {
      const { wangSet, wangSetIndex } =
        requireWritableWangSet(
          wangSets,
          operation.wangSetIndex,
          context,
          tilesetPath,
        );
      const colors = requireArrayMember(
        wangSet,
        "colors",
        wangSetIndex,
        tilesetPath,
      );
      const assignments = operation.assignments;
      if (
        !Array.isArray(assignments) ||
        assignments.length === 0 ||
        assignments.length >
          MAX_WANG_ASSIGNMENTS_PER_OPERATION
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context}.assignments must contain between 1 and ${MAX_WANG_ASSIGNMENTS_PER_OPERATION} entries.`,
          {
            limit:
              MAX_WANG_ASSIGNMENTS_PER_OPERATION,
          },
        );
      }
      const byTileId = readWangTileMap(
        wangSet,
        wangSetIndex,
        colors.length,
        tilesetPath,
      );
      let upserts = 0;
      let removals = 0;
      let noOps = 0;
      for (const [
        assignmentIndex,
        assignment,
      ] of assignments.entries()) {
        const assignmentContext = `${context}.assignments[${assignmentIndex}]`;
        if (
          typeof assignment !== "object" ||
          assignment === null ||
          !Number.isSafeInteger(
            assignment.tileId,
          ) ||
          assignment.tileId < 0 ||
          assignment.tileId >= tileCount
        ) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `${assignmentContext}.tileId must be an existing local tile id.`,
            { tileCount },
          );
        }
        const key = `${wangSetIndex}:${assignment.tileId}`;
        if (seenAssignmentKeys.has(key)) {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `${assignmentContext} repeats tile ${assignment.tileId} for Wang set ${wangSetIndex}.`,
            {
              wangSetIndex,
              tileId: assignment.tileId,
            },
          );
        }
        seenAssignmentKeys.add(key);
        const wangId = readWangIdInput(
          assignment.wangId,
          `${assignmentContext}.wangId`,
          colors.length,
        );
        const existing = byTileId.get(
          assignment.tileId,
        );
        if (wangId.every((slot) => slot === 0)) {
          if (existing === undefined) {
            noOps += 1;
          } else {
            byTileId.delete(assignment.tileId);
            removals += 1;
          }
        } else if (
          existing !== undefined &&
          existing.every(
            (slot, index) =>
              slot === wangId[index],
          )
        ) {
          noOps += 1;
        } else {
          byTileId.set(assignment.tileId, wangId);
          upserts += 1;
        }
      }
      if (upserts > 0 || removals > 0) {
        // Canonical save order: ascending tileId (WangSet::sortedWangTiles).
        wangSet.wangtiles = [
          ...byTileId.entries(),
        ]
          .sort(([left], [right]) => left - right)
          .map(([tileId, wangId]) => ({
            tileid: tileId,
            wangid: wangId,
          }));
        wouldChange = true;
      }
      assignmentChanges.push({
        wangSetIndex,
        upserts,
        removals,
        noOps,
      });
    } else {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.type must be addWangSet, addWangColor or setWangTiles.`,
      );
    }
  }

  if (!hadWangSetsMember && wangSets.length > 0) {
    document.wangsets = wangSets;
  }

  return {
    summary: {
      operationCount: operations.length,
      addedWangSets,
      addedColors,
      assignmentChanges,
      wouldChange,
    },
    patches: {
      memberPatches: wouldChange
        ? [{ path: [], key: "wangsets" }]
        : [],
    },
  };
}

function requiredBoundedName(
  value: unknown,
  context: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > MAX_WANG_NAME_CODE_POINTS
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be a non-empty string of at most ${MAX_WANG_NAME_CODE_POINTS} code points.`,
    );
  }
  return value;
}

function optionalImageTileId(
  value: unknown,
  context: string,
  tileCount: number,
): number {
  if (value === undefined) {
    return -1;
  }
  if (
    !Number.isSafeInteger(value) ||
    (value !== -1 &&
      ((value as number) < 0 ||
        (value as number) >= tileCount))
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be -1 or an existing local tile id.`,
      { tileCount },
    );
  }
  return value as number;
}

function serializeWangColor(
  input: WangColorInput,
  context: string,
  tileCount: number,
): JsonObject {
  if (
    typeof input !== "object" ||
    input === null
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be an object.`,
    );
  }
  const allowed = new Set([
    "name",
    "color",
    "probability",
    "imageTileId",
  ]);
  const unknownKey = Object.keys(input).find(
    (key) => !allowed.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknownKey}.`,
    );
  }
  const name = requiredBoundedName(
    input.name,
    `${context}.name`,
  );
  if (
    typeof input.color !== "string" ||
    !WANG_COLOR_PATTERN.test(input.color)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.color must be #rrggbb or #aarrggbb.`,
    );
  }
  const probability =
    input.probability === undefined
      ? 1
      : input.probability;
  if (
    typeof probability !== "number" ||
    !Number.isFinite(probability) ||
    probability < 0
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.probability must be a finite non-negative number.`,
    );
  }
  const imageTileId = optionalImageTileId(
    input.imageTileId,
    `${context}.imageTileId`,
    tileCount,
  );
  // Member order mirrors MapToVariantConverter::toVariant(WangColor).
  return {
    color: input.color,
    name,
    probability,
    tile: imageTileId,
  };
}

function requireWritableWangSet(
  wangSets: JsonValue[],
  wangSetIndex: unknown,
  context: string,
  tilesetPath: string,
): { wangSet: JsonObject; wangSetIndex: number } {
  if (
    !Number.isSafeInteger(wangSetIndex) ||
    (wangSetIndex as number) < 0 ||
    (wangSetIndex as number) >= wangSets.length
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.wangSetIndex must identify an existing Wang set.`,
      {
        wangSetIndex,
        wangSetCount: wangSets.length,
      },
    );
  }
  const wangSet = wangSets[wangSetIndex as number];
  if (
    typeof wangSet !== "object" ||
    wangSet === null ||
    Array.isArray(wangSet)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${tilesetPath}.wangsets[${wangSetIndex}] must be an object.`,
      { path: tilesetPath, wangSetIndex },
    );
  }
  if (
    wangSet.edgecolors !== undefined ||
    wangSet.cornercolors !== undefined
  ) {
    throw new TiledMcpError(
      "UNSUPPORTED_FORMAT",
      `${tilesetPath}.wangsets[${wangSetIndex}] uses pre-1.5 edgecolors/cornercolors; their color remapping semantics are not supported.`,
      { path: tilesetPath, wangSetIndex },
    );
  }
  return {
    wangSet,
    wangSetIndex: wangSetIndex as number,
  };
}

function requireArrayMember(
  wangSet: JsonObject,
  key: "colors",
  wangSetIndex: number,
  tilesetPath: string,
): JsonValue[] {
  const value = wangSet[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${tilesetPath}.wangsets[${wangSetIndex}].${key} must be an array.`,
      { path: tilesetPath, wangSetIndex },
    );
  }
  return value;
}

function readWangTileMap(
  wangSet: JsonObject,
  wangSetIndex: number,
  colorCount: number,
  tilesetPath: string,
): Map<number, number[]> {
  const entries =
    wangSet.wangtiles === undefined
      ? []
      : wangSet.wangtiles;
  if (!Array.isArray(entries)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${tilesetPath}.wangsets[${wangSetIndex}].wangtiles must be an array.`,
      { path: tilesetPath, wangSetIndex },
    );
  }
  if (
    entries.length > MAX_WANG_TILES_PER_SET_WRITE
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${tilesetPath}.wangsets[${wangSetIndex}] carries more than ${MAX_WANG_TILES_PER_SET_WRITE} wangtiles.`,
      {
        path: tilesetPath,
        wangSetIndex,
        limit: MAX_WANG_TILES_PER_SET_WRITE,
      },
    );
  }
  const byTileId = new Map<number, number[]>();
  for (const [index, value] of entries.entries()) {
    const entryContext = `${tilesetPath}.wangsets[${wangSetIndex}].wangtiles[${index}]`;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${entryContext} must be an object.`,
        { path: tilesetPath },
      );
    }
    const entry = value as JsonObject;
    if (
      !Number.isSafeInteger(entry.tileid) ||
      (entry.tileid as number) < 0
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${entryContext}.tileid must be a nonnegative integer.`,
        { path: tilesetPath },
      );
    }
    const tileId = entry.tileid as number;
    if (byTileId.has(tileId)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${tilesetPath}.wangsets[${wangSetIndex}] assigns multiple Wang IDs to tile ${tileId}.`,
        { path: tilesetPath, tileId },
      );
    }
    byTileId.set(
      tileId,
      readStoredWangId(
        entry.wangid,
        entryContext,
        colorCount,
        tilesetPath,
      ),
    );
  }
  return byTileId;
}

function readStoredWangId(
  value: JsonValue | undefined,
  context: string,
  colorCount: number,
  tilesetPath: string,
): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== WANG_ID_INDEX_COUNT
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context}.wangid must list exactly ${WANG_ID_INDEX_COUNT} color indexes.`,
      { path: tilesetPath },
    );
  }
  return value.map((slot, slotIndex) => {
    if (
      !Number.isSafeInteger(slot) ||
      (slot as number) < 0 ||
      (slot as number) > colorCount
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.wangid[${slotIndex}] references color ${String(slot)}; the set defines ${colorCount}.`,
        { path: tilesetPath, colorCount },
      );
    }
    return slot as number;
  });
}

function readWangIdInput(
  value: unknown,
  context: string,
  colorCount: number,
): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== WANG_ID_INDEX_COUNT
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must list exactly ${WANG_ID_INDEX_COUNT} color indexes (clockwise from the top edge).`,
    );
  }
  return value.map((slot, slotIndex) => {
    if (
      !Number.isSafeInteger(slot) ||
      (slot as number) < 0 ||
      (slot as number) > colorCount
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}[${slotIndex}] references color ${String(slot)}; the set defines ${colorCount}.`,
        { colorCount },
      );
    }
    return slot as number;
  });
}
