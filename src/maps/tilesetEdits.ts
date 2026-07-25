import { createHash } from "node:crypto";

import { TiledMcpError } from "../errors.js";
import {
  stableJson,
  type JsonObject,
  type JsonValue,
} from "../formats/json.js";
import type {
  JsonArrayDeletion,
  JsonArrayInsertion,
  JsonObjectMemberPatch,
} from "../formats/jsonSourcePatch.js";

export const MAX_TILE_UPDATES_PER_CHANGE_SET = 64;
export const MAX_TILE_CLASS_NAME_CODE_POINTS = 1_024;
export const MAX_TILE_ANIMATION_FRAMES_PER_TILE = 256;
export const MAX_TILE_ANIMATION_FRAME_DURATION_MS = 1_000_000_000;
export const MAX_TILE_PROBABILITY = 1_000_000_000;
export const MAX_TILE_PROPERTY_SETS_PER_TILE = 32;
export const MAX_TILE_PROPERTY_REMOVES_PER_TILE = 32;
export const MAX_TILE_PROPERTIES_PER_TILE = 128;
export const MAX_TILE_PROPERTY_NAME_CODE_POINTS = 256;
export const MAX_TILE_PROPERTY_VALUE_CODE_POINTS = 1_024;
export const TILE_PROPERTY_WRITE_TYPES = [
  "string",
  "int",
  "float",
  "bool",
  "color",
  "file",
] as const;

const TILE_PROPERTY_COLOR_PATTERN =
  /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const KNOWN_TILE_PROPERTY_TYPES = new Set([
  ...TILE_PROPERTY_WRITE_TYPES,
  "object",
  "class",
  "list",
]);

const TILESET_EDIT_PLAN_HASH_DOMAIN =
  "tiledmcp/tileset-edit-plan/v1\0";
const UPDATE_TILE_WARNING =
  "This rewrites only the targeted per-tile metadata members inside one external tileset. It never changes tile geometry, the atlas image, GID layout, or referencing maps, but pending map change sets pinned to the old tileset revision will conflict after apply.";

export interface TileAnimationFrameInput {
  tileId: number;
  durationMs: number;
}

export type TilePropertyWriteType =
  (typeof TILE_PROPERTY_WRITE_TYPES)[number];

export interface TilePropertyWrite {
  name: string;
  type: TilePropertyWriteType;
  value: string | number | boolean;
}

export interface TilePropertiesPatch {
  set?: TilePropertyWrite[] | undefined;
  remove?: string[] | undefined;
}

export interface TileMetadataPatch {
  /**
   * `null` or the Tiled default `1` removes the serialized member.
   */
  probability?: number | null | undefined;
  /**
   * `null` removes the serialized class member. Writes update an existing
   * `class` member, otherwise the Tiled 1.12.2 canonical `type` member.
   */
  className?: string | null | undefined;
  /**
   * Whole-array replacement serialized as Tiled `[{tileid,duration}]`.
   * `null` removes the member.
   */
  animation?: TileAnimationFrameInput[] | null | undefined;
  /**
   * Bounded scalar-only set/remove operations on the tile's `properties`
   * array. Targeting a class, enum, list, or object property fails closed;
   * untouched complex entries are preserved.
   */
  properties?: TilePropertiesPatch | undefined;
}

export interface TileMetadataUpdate {
  tileId: number;
  patch: TileMetadataPatch;
}

export type TileEntryAction =
  | "insert"
  | "update"
  | "remove"
  | "none";

export interface TileUpdateSummary {
  updateIndex: number;
  tileId: number;
  entryAction: TileEntryAction;
  requestedFields: string[];
  changedFields: string[];
  wouldChange: boolean;
  previousAnimationFrameCount?: number;
  newAnimationFrameCount?: number;
  propertiesSet?: number;
  propertiesRemoved?: number;
}

export type TilesMemberAction =
  | "insert"
  | "keep"
  | "remove"
  | "none";

export interface TilesetEditSummary {
  updateCount: number;
  tileUpdates: TileUpdateSummary[];
  tilesMemberAction: TilesMemberAction;
  wouldChange: boolean;
}

export interface TilesetEditPlan {
  kind: "tilesetEdit";
  version: 1;
  id: string;
  mapPath: string;
  tilesetPath: string;
  assetId: string;
  /**
   * Raw SHA-256 revision of the edited TSJ; the apply registry and the
   * document commit CAS both check this value.
   */
  baseRevision: string;
  mapRevision: string;
  updates: TileMetadataUpdate[];
  summary: TilesetEditSummary;
}

export interface UpdateTileOperationPreview {
  type: "updateTile";
  destructive: false;
  warning: string;
  tileId: number;
  entryAction: TileEntryAction;
  requestedFields: string[];
  changedFields: string[];
  wouldChange: boolean;
  previousAnimationFrameCount?: number;
  newAnimationFrameCount?: number;
  propertiesSet?: number;
  propertiesRemoved?: number;
}

export interface TilesetEditSourcePatches {
  memberPatches: JsonObjectMemberPatch[];
  insertions: JsonArrayInsertion[];
  deletions: JsonArrayDeletion[];
}

const PATCH_FIELDS = [
  "probability",
  "className",
  "animation",
  "properties",
] as const;
type TilePatchField = (typeof PATCH_FIELDS)[number];

/**
 * Validates the requested updates against a cloned TSJ document, mutates the
 * clone into the prospective state, and reports both the bounded summary and
 * the minimal source patches. The document must already have passed the
 * bounded tileset write-profile gate.
 */
export function applyTileMetadataUpdates(
  document: JsonObject,
  tileCount: number,
  updates: readonly TileMetadataUpdate[],
  tilesetPath: string,
): {
  summary: TilesetEditSummary;
  patches: TilesetEditSourcePatches;
} {
  if (
    !Array.isArray(updates) ||
    updates.length === 0 ||
    updates.length > MAX_TILE_UPDATES_PER_CHANGE_SET
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `updates must contain between 1 and ${MAX_TILE_UPDATES_PER_CHANGE_SET} tile updates.`,
      {
        min: 1,
        max: MAX_TILE_UPDATES_PER_CHANGE_SET,
        actual: Array.isArray(updates)
          ? updates.length
          : null,
      },
    );
  }
  const seenTileIds = new Set<number>();
  for (const [updateIndex, update] of updates.entries()) {
    assertExactKeys(
      update as unknown as Record<string, unknown>,
      ["patch", "tileId"],
      `updates[${updateIndex}]`,
    );
    if (
      !Number.isSafeInteger(update.tileId) ||
      update.tileId < 0
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `updates[${updateIndex}].tileId must be a nonnegative integer.`,
        { updateIndex },
      );
    }
    if (update.tileId >= tileCount) {
      throw new TiledMcpError(
        "TILE_ID_OUT_OF_RANGE",
        `updates[${updateIndex}].tileId ${update.tileId} is outside the tileset local ID range.`,
        {
          updateIndex,
          tileId: update.tileId,
          tileCount,
        },
      );
    }
    if (seenTileIds.has(update.tileId)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `updates[${updateIndex}] repeats tile ID ${update.tileId}.`,
        { updateIndex, tileId: update.tileId },
      );
    }
    seenTileIds.add(update.tileId);
    validateTilePatch(
      update.patch,
      tileCount,
      `updates[${updateIndex}].patch`,
    );
  }

  const hadTilesMember = document.tiles !== undefined;
  const entries =
    document.tiles === undefined
      ? []
      : (document.tiles as JsonValue[]);
  if (!Array.isArray(entries)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${tilesetPath}.tiles must be an array.`,
      { path: tilesetPath },
    );
  }
  const entryIndexById = new Map<number, number>();
  let previousId = -1;
  let sourceAscending = true;
  for (const [index, value] of entries.entries()) {
    const entry = expectEntryObject(
      value,
      index,
      tilesetPath,
    );
    const id = entry.id;
    if (
      typeof id !== "number" ||
      !Number.isSafeInteger(id)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${tilesetPath}.tiles[${index}].id must be an integer.`,
        { path: tilesetPath, index },
      );
    }
    entryIndexById.set(id, index);
    if (id <= previousId) {
      sourceAscending = false;
    }
    previousId = id;
  }

  const tileUpdates: TileUpdateSummary[] = [];
  const memberPatches: JsonObjectMemberPatch[] = [];
  let insertion:
    | { index: number; tileId: number }
    | undefined;
  let deletion: { index: number } | undefined;
  for (const [updateIndex, update] of updates.entries()) {
    const existingIndex = entryIndexById.get(
      update.tileId,
    );
    const summary = applyOneTileUpdate(
      entries,
      existingIndex,
      update,
      updateIndex,
      tilesetPath,
      sourceAscending,
    );
    tileUpdates.push(summary.entry);
    if (summary.entry.entryAction === "insert") {
      insertion = {
        index: summary.structuralIndex,
        tileId: update.tileId,
      };
    } else if (
      summary.entry.entryAction === "remove"
    ) {
      deletion = { index: summary.structuralIndex };
    } else if (
      summary.entry.changedFields.length > 0 &&
      existingIndex !== undefined
    ) {
      for (const key of summary.touchedMemberKeys) {
        memberPatches.push({
          path: ["tiles", existingIndex],
          key,
        });
      }
    }
  }
  const structuralCount =
    (insertion === undefined ? 0 : 1) +
    (deletion === undefined ? 0 : 1);
  if (structuralCount > 0 && updates.length !== 1) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "A tile update that inserts or removes a tiles[] entry must be the only update in its change set.",
      { updateCount: updates.length },
    );
  }

  let tilesMemberAction: TilesMemberAction = "none";
  const insertions: JsonArrayInsertion[] = [];
  const deletions: JsonArrayDeletion[] = [];
  if (insertion !== undefined) {
    if (hadTilesMember) {
      tilesMemberAction = "keep";
      insertions.push({
        path: ["tiles"],
        index: insertion.index,
      });
    } else {
      document.tiles = entries;
      tilesMemberAction = "insert";
      memberPatches.push({ path: [], key: "tiles" });
    }
  } else if (deletion !== undefined) {
    if (entries.length === 0) {
      delete document.tiles;
      tilesMemberAction = "remove";
      memberPatches.push({ path: [], key: "tiles" });
    } else {
      tilesMemberAction = "keep";
      deletions.push({
        path: ["tiles"],
        index: deletion.index,
      });
    }
  } else if (
    hadTilesMember &&
    tileUpdates.some((entry) => entry.wouldChange)
  ) {
    tilesMemberAction = "keep";
  }

  return {
    summary: {
      updateCount: updates.length,
      tileUpdates,
      tilesMemberAction,
      wouldChange: tileUpdates.some(
        (entry) => entry.wouldChange,
      ),
    },
    patches: {
      memberPatches,
      insertions,
      deletions,
    },
  };
}

function applyOneTileUpdate(
  entries: JsonValue[],
  existingIndex: number | undefined,
  update: TileMetadataUpdate,
  updateIndex: number,
  tilesetPath: string,
  sourceAscending: boolean,
): {
  entry: TileUpdateSummary;
  structuralIndex: number;
  touchedMemberKeys: string[];
} {
  const requestedFields = PATCH_FIELDS.filter(
    (field) => update.patch[field] !== undefined,
  );
  const target =
    existingIndex === undefined
      ? ({ id: update.tileId } as JsonObject)
      : expectEntryObject(
          entries[existingIndex] as JsonValue,
          existingIndex,
          tilesetPath,
        );
  const previousAnimation = target.animation;
  const changedFields: string[] = [];
  const touchedMemberKeys: string[] = [];
  let propertyCounts:
    | { propertiesSet: number; propertiesRemoved: number }
    | undefined;
  for (const field of requestedFields) {
    const change = applyTilePatchField(
      target,
      field,
      update.patch[field],
      tilesetPath,
      update.tileId,
    );
    if (field === "properties") {
      propertyCounts = {
        propertiesSet: change.propertiesSet ?? 0,
        propertiesRemoved:
          change.propertiesRemoved ?? 0,
      };
    }
    if (change.changed) {
      changedFields.push(field);
      for (const key of change.memberKeys) {
        if (!touchedMemberKeys.includes(key)) {
          touchedMemberKeys.push(key);
        }
      }
    }
  }
  const animationRequested = requestedFields.includes(
    "animation",
  );
  const animationCounts = animationRequested
    ? {
        previousAnimationFrameCount: Array.isArray(
          previousAnimation,
        )
          ? previousAnimation.length
          : 0,
        newAnimationFrameCount: Array.isArray(
          target.animation,
        )
          ? (target.animation as JsonValue[]).length
          : 0,
      }
    : {};

  if (existingIndex === undefined) {
    if (changedFields.length === 0) {
      return {
        entry: {
          updateIndex,
          tileId: update.tileId,
          entryAction: "none",
          requestedFields,
          changedFields,
          wouldChange: false,
          ...animationCounts,
        ...propertyCounts,
        },
        structuralIndex: 0,
        touchedMemberKeys,
      };
    }
    if (!sourceAscending) {
      throw new TiledMcpError(
        "UNSUPPORTED_TILESET",
        `${tilesetPath}.tiles is not sorted by ascending tile id, so a deterministic insertion position for tile ${update.tileId} cannot be chosen.`,
        { path: tilesetPath, tileId: update.tileId },
      );
    }
    let insertAt = entries.length;
    for (const [index, value] of entries.entries()) {
      const entry = value as JsonObject;
      if ((entry.id as number) > update.tileId) {
        insertAt = index;
        break;
      }
    }
    entries.splice(insertAt, 0, target);
    return {
      entry: {
        updateIndex,
        tileId: update.tileId,
        entryAction: "insert",
        requestedFields,
        changedFields,
        wouldChange: true,
        ...animationCounts,
        ...propertyCounts,
      },
      structuralIndex: insertAt,
      touchedMemberKeys,
    };
  }

  const remainingKeys = Object.keys(target);
  if (
    changedFields.length > 0 &&
    remainingKeys.length === 1 &&
    remainingKeys[0] === "id"
  ) {
    entries.splice(existingIndex, 1);
    return {
      entry: {
        updateIndex,
        tileId: update.tileId,
        entryAction: "remove",
        requestedFields,
        changedFields,
        wouldChange: true,
        ...animationCounts,
        ...propertyCounts,
      },
      structuralIndex: existingIndex,
      touchedMemberKeys,
    };
  }
  return {
    entry: {
      updateIndex,
      tileId: update.tileId,
      entryAction: "update",
      requestedFields,
      changedFields,
      wouldChange: changedFields.length > 0,
      ...animationCounts,
        ...propertyCounts,
    },
    structuralIndex: existingIndex,
    touchedMemberKeys,
  };
}

function applyTilePatchField(
  target: JsonObject,
  field: TilePatchField,
  value: TileMetadataPatch[TilePatchField],
  tilesetPath: string,
  tileId: number,
): {
  changed: boolean;
  memberKeys: string[];
  propertiesSet?: number;
  propertiesRemoved?: number;
} {
  if (field === "properties") {
    return applyTilePropertiesPatch(
      target,
      value as TilePropertiesPatch,
      tilesetPath,
      tileId,
    );
  }
  if (field === "probability") {
    const removal =
      value === null || value === 1;
    if (removal) {
      const changed =
        target.probability !== undefined;
      delete target.probability;
      return {
        changed,
        memberKeys: ["probability"],
      };
    }
    const changed =
      stableJson(
        (target.probability ?? null) as JsonValue,
      ) !== stableJson(value as JsonValue);
    target.probability = value as number;
    return { changed, memberKeys: ["probability"] };
  }
  if (field === "className") {
    const hasClass =
      Object.prototype.hasOwnProperty.call(
        target,
        "class",
      );
    const hasType =
      Object.prototype.hasOwnProperty.call(
        target,
        "type",
      );
    if (hasClass && hasType) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${tilesetPath} tile ${tileId} carries both class and type members, so the effective class is ambiguous.`,
        { path: tilesetPath, tileId },
      );
    }
    if (value === null) {
      const changed = hasClass || hasType;
      delete target.class;
      delete target.type;
      return {
        changed,
        memberKeys: hasClass ? ["class"] : ["type"],
      };
    }
    const key = hasClass ? "class" : "type";
    const changed =
      stableJson(
        (target[key] ?? null) as JsonValue,
      ) !== stableJson(value as JsonValue);
    target[key] = value as string;
    return { changed, memberKeys: [key] };
  }
  const serialized =
    value === null
      ? undefined
      : (value as TileAnimationFrameInput[]).map(
          (frame) => ({
            tileid: frame.tileId,
            duration: frame.durationMs,
          }),
        );
  const changed =
    stableJson(
      (target.animation ?? null) as JsonValue,
    ) !==
    stableJson((serialized ?? null) as JsonValue);
  if (serialized === undefined) {
    delete target.animation;
  } else {
    target.animation = serialized;
  }
  return { changed, memberKeys: ["animation"] };
}

function validateTilePatch(
  patch: TileMetadataPatch,
  tileCount: number,
  context: string,
): void {
  if (
    typeof patch !== "object" ||
    patch === null ||
    Array.isArray(patch)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be an object.`,
    );
  }
  assertExactKeys(
    patch as unknown as Record<string, unknown>,
    [...PATCH_FIELDS].sort(),
    context,
    true,
  );
  const requested = PATCH_FIELDS.filter(
    (field) => patch[field] !== undefined,
  );
  if (requested.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must contain at least one field.`,
    );
  }
  if (
    patch.probability !== undefined &&
    patch.probability !== null &&
    (typeof patch.probability !== "number" ||
      !Number.isFinite(patch.probability) ||
      patch.probability < 0 ||
      patch.probability > MAX_TILE_PROBABILITY)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.probability must be null or a finite number between 0 and ${MAX_TILE_PROBABILITY}.`,
    );
  }
  if (
    patch.className !== undefined &&
    patch.className !== null &&
    (typeof patch.className !== "string" ||
      patch.className.length === 0 ||
      !hasAtMostCodePoints(
        patch.className,
        MAX_TILE_CLASS_NAME_CODE_POINTS,
      ))
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.className must be null or a non-empty string of at most ${MAX_TILE_CLASS_NAME_CODE_POINTS} Unicode code points.`,
    );
  }
  if (
    patch.animation !== undefined &&
    patch.animation !== null
  ) {
    validateAnimationFrames(
      patch.animation,
      tileCount,
      `${context}.animation`,
    );
  }
  if (patch.properties !== undefined) {
    validateTilePropertiesPatch(
      patch.properties,
      `${context}.properties`,
    );
  }
}

function validateTilePropertiesPatch(
  patch: TilePropertiesPatch,
  context: string,
): void {
  if (
    typeof patch !== "object" ||
    patch === null ||
    Array.isArray(patch)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be an object.`,
    );
  }
  assertExactKeys(
    patch as unknown as Record<string, unknown>,
    ["remove", "set"],
    context,
    true,
  );
  const sets = patch.set ?? [];
  const removes = patch.remove ?? [];
  if (
    !Array.isArray(sets) ||
    !Array.isArray(removes) ||
    sets.length + removes.length === 0 ||
    sets.length > MAX_TILE_PROPERTY_SETS_PER_TILE ||
    removes.length >
      MAX_TILE_PROPERTY_REMOVES_PER_TILE
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must contain at least one entry, at most ${MAX_TILE_PROPERTY_SETS_PER_TILE} set entries, and at most ${MAX_TILE_PROPERTY_REMOVES_PER_TILE} removals.`,
    );
  }
  const seenNames = new Set<string>();
  const validateName = (
    name: unknown,
    nameContext: string,
  ): string => {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      !hasAtMostCodePoints(
        name,
        MAX_TILE_PROPERTY_NAME_CODE_POINTS,
      )
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${nameContext} must be a non-empty string of at most ${MAX_TILE_PROPERTY_NAME_CODE_POINTS} Unicode code points.`,
      );
    }
    if (seenNames.has(name)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${nameContext} repeats property name ${JSON.stringify(name)}.`,
      );
    }
    seenNames.add(name);
    return name;
  };
  for (const [index, write] of sets.entries()) {
    const writeContext = `${context}.set[${index}]`;
    assertExactKeys(
      write as unknown as Record<string, unknown>,
      ["name", "type", "value"],
      writeContext,
    );
    validateName(write.name, `${writeContext}.name`);
    if (
      !(
        TILE_PROPERTY_WRITE_TYPES as readonly string[]
      ).includes(write.type)
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${writeContext}.type must be one of ${TILE_PROPERTY_WRITE_TYPES.join(", ")}.`,
      );
    }
    validateTilePropertyValue(
      write.type,
      write.value,
      `${writeContext}.value`,
    );
  }
  for (const [index, name] of removes.entries()) {
    validateName(
      name,
      `${context}.remove[${index}]`,
    );
  }
}

function validateTilePropertyValue(
  type: TilePropertyWriteType,
  value: unknown,
  context: string,
): void {
  switch (type) {
    case "string":
    case "file":
      if (
        typeof value === "string" &&
        hasAtMostCodePoints(
          value,
          MAX_TILE_PROPERTY_VALUE_CODE_POINTS,
        )
      ) {
        return;
      }
      break;
    case "color":
      if (
        typeof value === "string" &&
        TILE_PROPERTY_COLOR_PATTERN.test(value)
      ) {
        return;
      }
      break;
    case "int":
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value)
      ) {
        return;
      }
      break;
    case "float":
      if (
        typeof value === "number" &&
        Number.isFinite(value)
      ) {
        return;
      }
      break;
    case "bool":
      if (typeof value === "boolean") {
        return;
      }
      break;
  }
  throw new TiledMcpError(
    "INVALID_ARGUMENT",
    `${context} is inconsistent with the declared property type ${type}.`,
    { type },
  );
}

function applyTilePropertiesPatch(
  target: JsonObject,
  patch: TilePropertiesPatch,
  tilesetPath: string,
  tileId: number,
): {
  changed: boolean;
  memberKeys: string[];
  propertiesSet: number;
  propertiesRemoved: number;
} {
  const context = `${tilesetPath} tile ${tileId}.properties`;
  const before = target.properties;
  if (
    before !== undefined &&
    !Array.isArray(before)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must be an array.`,
      { path: tilesetPath, tileId },
    );
  }
  const entries = (before ?? []) as JsonValue[];
  // Serialize the before-state up front: existing entries are later mutated
  // in place, so a deferred comparison would observe its own writes.
  const beforeSnapshot = stableJson(
    (before ?? null) as JsonValue,
  );
  const byName = new Map<string, number>();
  let sortedByName = true;
  let previousName: string | undefined;
  for (const [index, value] of entries.entries()) {
    const entry = expectEntryObject(
      value,
      index,
      tilesetPath,
    );
    const name = entry.name;
    if (typeof name !== "string") {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}[${index}].name must be a string.`,
        { path: tilesetPath, tileId, index },
      );
    }
    if (byName.has(name)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context} contains duplicate property name ${JSON.stringify(name)}.`,
        { path: tilesetPath, tileId },
      );
    }
    byName.set(name, index);
    if (
      previousName !== undefined &&
      !(previousName < name)
    ) {
      sortedByName = false;
    }
    previousName = name;
  }

  const targetedNames = [
    ...(patch.set ?? []).map((write) => write.name),
    ...(patch.remove ?? []),
  ];
  for (const name of targetedNames) {
    const index = byName.get(name);
    if (index === undefined) {
      continue;
    }
    const entry = entries[index] as JsonObject;
    const typeName =
      entry.type === undefined
        ? "string"
        : entry.type;
    if (
      typeof typeName !== "string" ||
      !KNOWN_TILE_PROPERTY_TYPES.has(typeName)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context} property ${JSON.stringify(name)} has an unrecognized type.`,
        { path: tilesetPath, tileId, name },
      );
    }
    if (
      entry.propertytype !== undefined ||
      !(
        TILE_PROPERTY_WRITE_TYPES as readonly string[]
      ).includes(typeName)
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_PROPERTY_WRITE",
        `${context} property ${JSON.stringify(name)} uses a custom or complex type; only built-in scalar properties can be edited.`,
        {
          path: tilesetPath,
          tileId,
          name,
          type: typeName,
          supportedTypes: [
            ...TILE_PROPERTY_WRITE_TYPES,
          ],
        },
      );
    }
  }

  const removeNames = new Set(patch.remove ?? []);
  let propertiesRemoved = 0;
  const working: JsonValue[] = [];
  for (const value of entries) {
    const entry = value as JsonObject;
    if (removeNames.has(entry.name as string)) {
      propertiesRemoved += 1;
      continue;
    }
    working.push(value);
  }
  let propertiesSet = 0;
  for (const write of patch.set ?? []) {
    const existingIndex = working.findIndex(
      (value) =>
        (value as JsonObject).name === write.name,
    );
    if (existingIndex >= 0) {
      const entry = working[
        existingIndex
      ] as JsonObject;
      const changedEntry =
        stableJson(
          (entry.type ?? "string") as JsonValue,
        ) !== stableJson(write.type) ||
        stableJson(
          (entry.value ?? null) as JsonValue,
        ) !== stableJson(write.value);
      if (changedEntry) {
        entry.type = write.type;
        entry.value = write.value;
        propertiesSet += 1;
      }
      continue;
    }
    if (!sortedByName) {
      throw new TiledMcpError(
        "UNSUPPORTED_PROPERTY_WRITE",
        `${context} is not sorted by property name, so a deterministic insertion position for ${JSON.stringify(write.name)} cannot be chosen.`,
        {
          path: tilesetPath,
          tileId,
          name: write.name,
        },
      );
    }
    let insertAt = working.length;
    for (const [
      index,
      value,
    ] of working.entries()) {
      if (
        write.name <
        ((value as JsonObject).name as string)
      ) {
        insertAt = index;
        break;
      }
    }
    working.splice(insertAt, 0, {
      name: write.name,
      type: write.type,
      value: write.value,
    });
    propertiesSet += 1;
  }
  if (working.length > MAX_TILE_PROPERTIES_PER_TILE) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${context} may contain at most ${MAX_TILE_PROPERTIES_PER_TILE} properties.`,
      {
        limit: MAX_TILE_PROPERTIES_PER_TILE,
        actual: working.length,
      },
    );
  }
  const changed =
    beforeSnapshot !==
    stableJson(
      (working.length === 0
        ? null
        : working) as JsonValue,
    );
  if (working.length === 0) {
    delete target.properties;
  } else {
    target.properties = working;
  }
  return {
    changed,
    memberKeys: ["properties"],
    propertiesSet,
    propertiesRemoved,
  };
}

function validateAnimationFrames(
  frames: readonly TileAnimationFrameInput[],
  tileCount: number,
  context: string,
): void {
  if (
    !Array.isArray(frames) ||
    frames.length === 0 ||
    frames.length > MAX_TILE_ANIMATION_FRAMES_PER_TILE
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be null or contain between 1 and ${MAX_TILE_ANIMATION_FRAMES_PER_TILE} frames.`,
      {
        min: 1,
        max: MAX_TILE_ANIMATION_FRAMES_PER_TILE,
        actual: Array.isArray(frames)
          ? frames.length
          : null,
      },
    );
  }
  let totalDurationMs = 0;
  for (const [frameIndex, frame] of frames.entries()) {
    assertExactKeys(
      frame as unknown as Record<string, unknown>,
      ["durationMs", "tileId"],
      `${context}[${frameIndex}]`,
    );
    if (
      !Number.isSafeInteger(frame.tileId) ||
      frame.tileId < 0
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}[${frameIndex}].tileId must be a nonnegative integer.`,
      );
    }
    if (frame.tileId >= tileCount) {
      throw new TiledMcpError(
        "TILE_ID_OUT_OF_RANGE",
        `${context}[${frameIndex}].tileId ${frame.tileId} is outside the tileset local ID range.`,
        {
          frameIndex,
          tileId: frame.tileId,
          tileCount,
        },
      );
    }
    if (
      !Number.isSafeInteger(frame.durationMs) ||
      frame.durationMs < 1 ||
      frame.durationMs >
        MAX_TILE_ANIMATION_FRAME_DURATION_MS
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}[${frameIndex}].durationMs must be an integer between 1 and ${MAX_TILE_ANIMATION_FRAME_DURATION_MS}.`,
      );
    }
    totalDurationMs += frame.durationMs;
    if (!Number.isSafeInteger(totalDurationMs)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} total duration exceeds safe integer bounds.`,
      );
    }
  }
}

export function updateTileOperationPreview(
  summary: TileUpdateSummary,
): UpdateTileOperationPreview {
  return {
    type: "updateTile",
    destructive: false,
    warning: UPDATE_TILE_WARNING,
    tileId: summary.tileId,
    entryAction: summary.entryAction,
    requestedFields: [...summary.requestedFields],
    changedFields: [...summary.changedFields],
    wouldChange: summary.wouldChange,
    ...(summary.previousAnimationFrameCount ===
    undefined
      ? {}
      : {
          previousAnimationFrameCount:
            summary.previousAnimationFrameCount,
        }),
    ...(summary.newAnimationFrameCount === undefined
      ? {}
      : {
          newAnimationFrameCount:
            summary.newAnimationFrameCount,
        }),
    ...(summary.propertiesSet === undefined
      ? {}
      : { propertiesSet: summary.propertiesSet }),
    ...(summary.propertiesRemoved === undefined
      ? {}
      : {
          propertiesRemoved:
            summary.propertiesRemoved,
        }),
  };
}

export function tilesetEditPlanId(
  value: Omit<TilesetEditPlan, "id">,
): string {
  const canonical = stableJson(
    value as unknown as JsonValue,
  );
  return `changeset:${createHash("sha256")
    .update(TILESET_EDIT_PLAN_HASH_DOMAIN)
    .update(canonical)
    .digest("hex")}`;
}

export function assertTilesetEditPlan(
  plan: TilesetEditPlan,
): void {
  assertExactKeys(
    plan as unknown as Record<string, unknown>,
    [
      "assetId",
      "baseRevision",
      "id",
      "kind",
      "mapPath",
      "mapRevision",
      "summary",
      "tilesetPath",
      "updates",
      "version",
    ],
    "tileset edit plan",
  );
  if (
    plan.kind !== "tilesetEdit" ||
    plan.version !== 1 ||
    typeof plan.id !== "string" ||
    typeof plan.mapPath !== "string" ||
    typeof plan.tilesetPath !== "string" ||
    typeof plan.assetId !== "string" ||
    typeof plan.baseRevision !== "string" ||
    typeof plan.mapRevision !== "string" ||
    !Array.isArray(plan.updates) ||
    typeof plan.summary !== "object" ||
    plan.summary === null
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The tileset edit plan is malformed.",
    );
  }
  const { id, ...unsigned } = plan;
  if (id !== tilesetEditPlanId(unsigned)) {
    throw new TiledMcpError(
      "CHANGE_SET_TAMPERED",
      "The tileset edit plan contents do not match its digest. Preview the updates again.",
    );
  }
}

function expectEntryObject(
  value: JsonValue,
  index: number,
  tilesetPath: string,
): JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${tilesetPath}.tiles[${index}] must be an object.`,
      { path: tilesetPath, index },
    );
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
  subsetOnly = false,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be an object.`,
    );
  }
  const keys = Object.keys(value).sort();
  if (subsetOnly) {
    const unknown = keys.find(
      (key) => !expected.includes(key),
    );
    if (unknown !== undefined) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} contains unsupported field ${unknown}.`,
      );
    }
    return;
  }
  if (
    keys.join(",") !== [...expected].sort().join(",")
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must contain exactly ${expected.join(", ")}.`,
    );
  }
}

function hasAtMostCodePoints(
  value: string,
  limit: number,
): boolean {
  let count = 0;
  for (const _ of value) {
    count += 1;
    if (count > limit) {
      return false;
    }
  }
  return true;
}
