import { createHash } from "node:crypto";

import { TiledMcpError } from "../errors.js";
import type { TilesetCollectionProfile } from "./tilesetDetails.js";
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
import {
  applyPropertiesPatch,
  assertExactKeys,
  hasAtMostCodePoints,
  validatePropertiesPatch,
  type PropertiesPatch,
} from "./propertyEdits.js";

export const MAX_TILE_UPDATES_PER_CHANGE_SET = 64;
export const MAX_TILE_CLASS_NAME_CODE_POINTS = 1_024;
export const MAX_TILE_ANIMATION_FRAMES_PER_TILE = 256;
export const MAX_TILE_ANIMATION_FRAME_DURATION_MS = 1_000_000_000;
export const MAX_TILE_PROBABILITY = 1_000_000_000;
export const MAX_TILE_COLLISION_SHAPES_PER_TILE = 128;
export const MAX_TILE_COLLISION_POINTS_PER_CHANGE_SET = 8_192;
export const MAX_TILE_COLLISION_COORDINATE = 1_000_000_000;
export const MIN_TILE_COLLISION_POLYGON_POINTS = 3;
export const MIN_TILE_COLLISION_POLYLINE_POINTS = 2;
export const MAX_TILE_COLLISION_SHAPE_POINTS = 256;
export const TILE_COLLISION_SHAPE_KINDS = [
  "rectangle",
  "point",
  "ellipse",
  "capsule",
  "polygon",
  "polyline",
] as const;

export {
  MAX_PROPERTY_SETS_PER_TARGET as MAX_TILE_PROPERTY_SETS_PER_TILE,
  MAX_PROPERTY_REMOVES_PER_TARGET as MAX_TILE_PROPERTY_REMOVES_PER_TILE,
  MAX_PROPERTIES_PER_TARGET as MAX_TILE_PROPERTIES_PER_TILE,
  MAX_PROPERTY_NAME_CODE_POINTS as MAX_TILE_PROPERTY_NAME_CODE_POINTS,
  MAX_PROPERTY_VALUE_CODE_POINTS as MAX_TILE_PROPERTY_VALUE_CODE_POINTS,
  PROPERTY_WRITE_TYPES as TILE_PROPERTY_WRITE_TYPES,
} from "./propertyEdits.js";
export type {
  PropertyWriteType as TilePropertyWriteType,
  PropertyWrite as TilePropertyWrite,
  PropertiesPatch as TilePropertiesPatch,
} from "./propertyEdits.js";

const TILESET_EDIT_PLAN_HASH_DOMAIN =
  "tiledmcp/tileset-edit-plan/v2\0";
const UPDATE_TILE_WARNING =
  "This rewrites only the targeted per-tile metadata members inside one external tileset. It never changes tile geometry, the atlas image, GID layout, or referencing maps, but pending map change sets pinned to the old tileset revision will conflict after apply.";
const COLLECTION_STRUCTURAL_WARNING =
  "This inserts or removes one image-collection tile entry and rewrites the tileset's tilecount and maximum tile size, changing the collection's GID span. Referencing maps are never rewritten; pending change sets pinned to the old tileset revision will conflict after apply.";

export interface TileAnimationFrameInput {
  tileId: number;
  durationMs: number;
}

export type TileCollisionShapeKind =
  (typeof TILE_COLLISION_SHAPE_KINDS)[number];

export interface TileCollisionShapeInput {
  shape: TileCollisionShapeKind;
  x: number;
  y: number;
  width?: number | undefined;
  height?: number | undefined;
  rotation?: number | undefined;
  name?: string | undefined;
  className?: string | undefined;
  points?:
    | Array<{ x: number; y: number }>
    | undefined;
}

export interface TileCollisionPatch {
  shapes: TileCollisionShapeInput[];
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
   * Whole replacement of the tile collision `objectgroup.objects` array
   * with bounded basic shapes (Tiled 1.12.2 collision editor semantics:
   * ids continue after the existing maximum, an existing container's other
   * members are preserved, a new container gets canonical index draworder,
   * and `null` removes the member like clearing the collision editor).
   */
  collision?: TileCollisionPatch | null | undefined;
  /**
   * Bounded scalar-only set/remove operations on the tile's `properties`
   * array. Targeting a class, enum, list, or object property fails closed;
   * untouched complex entries are preserved.
   */
  properties?: PropertiesPatch | undefined;
}

export interface CollectionTileCreateInput {
  /** Image reference exactly as serialized in the TSJ (tileset-relative). */
  image: string;
  /**
   * Verified actual pixel size of the referenced image. The planner reads
   * the image and injects these before building the plan; replay re-reads
   * the image and fails closed on any mismatch, so declarations are never
   * trusted. Absent only on the wire before planning.
   */
  imageWidth?: number;
  imageHeight?: number;
}

/**
 * Exactly one of `patch` (metadata rewrite), `createCollectionTile`
 * (append a new image-collection tile entry), or `removeCollectionTile`
 * (delete an existing entry) must be present. Structural collection
 * updates must be the only update in their change set.
 */
export interface TileMetadataUpdate {
  tileId: number;
  patch?: TileMetadataPatch;
  createCollectionTile?: CollectionTileCreateInput;
  removeCollectionTile?: true;
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
  previousCollisionShapeCount?: number;
  collisionShapeCount?: number;
}

export type TilesMemberAction =
  | "insert"
  | "keep"
  | "remove"
  | "none";

export interface CollectionStructureSummary {
  action: "create" | "remove";
  tileId: number;
  tileCountBefore: number;
  tileCountAfter: number;
  tileSizeBefore: { width: number; height: number };
  tileSizeAfter: { width: number; height: number };
}

export interface TilesetEditSummary {
  updateCount: number;
  tileUpdates: TileUpdateSummary[];
  tilesMemberAction: TilesMemberAction;
  collectionStructure?: CollectionStructureSummary;
  wouldChange: boolean;
}

export interface TilesetEditPlan {
  kind: "tilesetEdit";
  version: 2;
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
  /** True exactly for a removeCollectionTile structural update. */
  destructive: boolean;
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
  previousCollisionShapeCount?: number;
  collisionShapeCount?: number;
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
  "collision",
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
  collection?: TilesetCollectionProfile,
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
  let collisionPoints = 0;
  for (const [updateIndex, update] of updates.entries()) {
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
    if (seenTileIds.has(update.tileId)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `updates[${updateIndex}] repeats tile ID ${update.tileId}.`,
        { updateIndex, tileId: update.tileId },
      );
    }
    seenTileIds.add(update.tileId);
    if (
      update.createCollectionTile !== undefined ||
      update.removeCollectionTile !== undefined
    ) {
      validateCollectionStructuralUpdate(
        update,
        updateIndex,
        collection,
      );
      continue;
    }
    assertExactKeys(
      update as unknown as Record<string, unknown>,
      ["patch", "tileId"],
      `updates[${updateIndex}]`,
    );
    const patch = update.patch;
    if (patch === undefined) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `updates[${updateIndex}] must carry exactly one of patch, createCollectionTile, or removeCollectionTile.`,
        { updateIndex },
      );
    }
    if (
      collection === undefined
        ? update.tileId >= tileCount
        : !collection.localIds.has(update.tileId)
    ) {
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
    validateTilePatch(
      patch,
      tileCount,
      `updates[${updateIndex}].patch`,
      collection,
    );
    collisionPoints += tileCollisionPointCount(
      patch.collision,
    );
    if (
      collisionPoints >
      MAX_TILE_COLLISION_POINTS_PER_CHANGE_SET
    ) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `Collision shapes may contain at most ${MAX_TILE_COLLISION_POINTS_PER_CHANGE_SET} total polygon and polyline points per change set.`,
        {
          limit:
            MAX_TILE_COLLISION_POINTS_PER_CHANGE_SET,
          actual: collisionPoints,
        },
      );
    }
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
  let collectionStructure:
    | CollectionStructureSummary
    | undefined;
  for (const [updateIndex, update] of updates.entries()) {
    const existingIndex = entryIndexById.get(
      update.tileId,
    );
    if (
      update.createCollectionTile !== undefined ||
      update.removeCollectionTile !== undefined
    ) {
      const structural = applyCollectionStructural(
        document,
        entries,
        existingIndex,
        update,
        updateIndex,
        tilesetPath,
        sourceAscending,
        memberPatches,
      );
      tileUpdates.push(structural.entry);
      collectionStructure = structural.structure;
      if (structural.entry.entryAction === "insert") {
        insertion = {
          index: structural.structuralIndex,
          tileId: update.tileId,
        };
      } else {
        deletion = {
          index: structural.structuralIndex,
        };
      }
      continue;
    }
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
      ...(collectionStructure === undefined
        ? {}
        : { collectionStructure }),
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

function validateCollectionStructuralUpdate(
  update: TileMetadataUpdate,
  updateIndex: number,
  collection: TilesetCollectionProfile | undefined,
): void {
  const context = `updates[${updateIndex}]`;
  if (collection === undefined) {
    throw new TiledMcpError(
      "UNSUPPORTED_TILESET",
      `${context} edits image-collection tile entries, but the selected tileset is an atlas.`,
      { updateIndex },
    );
  }
  if (update.createCollectionTile !== undefined) {
    assertExactKeys(
      update as unknown as Record<string, unknown>,
      ["createCollectionTile", "tileId"],
      context,
    );
    const create = update.createCollectionTile;
    assertExactKeys(
      create as unknown as Record<string, unknown>,
      ["image", "imageHeight", "imageWidth"],
      `${context}.createCollectionTile`,
    );
    if (
      typeof create.image !== "string" ||
      create.image.length === 0
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.createCollectionTile.image must be a non-empty string.`,
        { updateIndex },
      );
    }
    if (
      create.imageWidth === undefined ||
      !Number.isSafeInteger(create.imageWidth) ||
      create.imageWidth <= 0 ||
      create.imageHeight === undefined ||
      !Number.isSafeInteger(create.imageHeight) ||
      create.imageHeight <= 0
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.createCollectionTile image dimensions must be positive integers.`,
        { updateIndex },
      );
    }
    if (collection.localIds.has(update.tileId)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.tileId ${update.tileId} already exists in the collection.`,
        { updateIndex, tileId: update.tileId },
      );
    }
    return;
  }
  assertExactKeys(
    update as unknown as Record<string, unknown>,
    ["removeCollectionTile", "tileId"],
    context,
  );
  if (update.removeCollectionTile !== true) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.removeCollectionTile must be true when present.`,
      { updateIndex },
    );
  }
  if (!collection.localIds.has(update.tileId)) {
    throw new TiledMcpError(
      "TILE_ID_OUT_OF_RANGE",
      `${context}.tileId ${update.tileId} does not exist in the collection.`,
      { updateIndex, tileId: update.tileId },
    );
  }
  if (collection.localIds.size <= 1) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} would remove the collection's last tile entry; an empty image collection is not writable.`,
      { updateIndex, tileId: update.tileId },
    );
  }
}

/**
 * Applies one structural collection update and its root-member fallout:
 * `tilecount` follows the entry count, and `tilewidth`/`tileheight` follow
 * Tiled's maximum-tile-size semantics (`Tileset::addTile` only ever grows
 * them; `removeTiles` triggers `updateTileSize`, a full recompute over the
 * remaining entries' verified image sizes).
 */
function applyCollectionStructural(
  document: JsonObject,
  entries: JsonValue[],
  existingIndex: number | undefined,
  update: TileMetadataUpdate,
  updateIndex: number,
  tilesetPath: string,
  sourceAscending: boolean,
  memberPatches: JsonObjectMemberPatch[],
): {
  entry: TileUpdateSummary;
  structuralIndex: number;
  structure: CollectionStructureSummary;
} {
  const tileCountBefore = requiredRootInteger(
    document,
    "tilecount",
    tilesetPath,
  );
  const tileSizeBefore = {
    width: requiredRootInteger(
      document,
      "tilewidth",
      tilesetPath,
    ),
    height: requiredRootInteger(
      document,
      "tileheight",
      tilesetPath,
    ),
  };
  if (update.createCollectionTile !== undefined) {
    if (!sourceAscending) {
      throw new TiledMcpError(
        "UNSUPPORTED_TILESET",
        `${tilesetPath}.tiles is not sorted by ascending tile id, so a deterministic insertion position for tile ${update.tileId} cannot be chosen.`,
        { path: tilesetPath, tileId: update.tileId },
      );
    }
    const create = update.createCollectionTile;
    const imageWidth = create.imageWidth;
    const imageHeight = create.imageHeight;
    if (
      imageWidth === undefined ||
      imageHeight === undefined
    ) {
      throw new TiledMcpError(
        "INTERNAL_ERROR",
        `Collection tile ${update.tileId} reached application without verified image dimensions.`,
        { tileId: update.tileId },
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
    entries.splice(insertAt, 0, {
      id: update.tileId,
      image: create.image,
      imageheight: imageHeight,
      imagewidth: imageWidth,
    });
    const tileSizeAfter = {
      width: Math.max(
        tileSizeBefore.width,
        imageWidth,
      ),
      height: Math.max(
        tileSizeBefore.height,
        imageHeight,
      ),
    };
    applyRootStructuralPatches(
      document,
      memberPatches,
      tileCountBefore + 1,
      tileSizeBefore,
      tileSizeAfter,
    );
    return {
      entry: {
        updateIndex,
        tileId: update.tileId,
        entryAction: "insert",
        requestedFields: ["createCollectionTile"],
        changedFields: ["createCollectionTile"],
        wouldChange: true,
      },
      structuralIndex: insertAt,
      structure: {
        action: "create",
        tileId: update.tileId,
        tileCountBefore,
        tileCountAfter: tileCountBefore + 1,
        tileSizeBefore,
        tileSizeAfter,
      },
    };
  }
  if (existingIndex === undefined) {
    throw new TiledMcpError(
      "INTERNAL_ERROR",
      `Collection tile ${update.tileId} passed validation but has no tiles[] entry.`,
      { tileId: update.tileId },
    );
  }
  entries.splice(existingIndex, 1);
  let maxWidth = 0;
  let maxHeight = 0;
  for (const [index, value] of entries.entries()) {
    const entry = value as JsonObject;
    const width = entry.imagewidth;
    const height = entry.imageheight;
    if (
      typeof width !== "number" ||
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      typeof height !== "number" ||
      !Number.isSafeInteger(height) ||
      height <= 0
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_TILESET",
        `${tilesetPath}.tiles[${index}] lacks positive declared image dimensions, so the collection tile size cannot be recomputed after a removal.`,
        { path: tilesetPath, index },
      );
    }
    maxWidth = Math.max(maxWidth, width);
    maxHeight = Math.max(maxHeight, height);
  }
  const tileSizeAfter = {
    width: maxWidth,
    height: maxHeight,
  };
  applyRootStructuralPatches(
    document,
    memberPatches,
    tileCountBefore - 1,
    tileSizeBefore,
    tileSizeAfter,
  );
  return {
    entry: {
      updateIndex,
      tileId: update.tileId,
      entryAction: "remove",
      requestedFields: ["removeCollectionTile"],
      changedFields: ["removeCollectionTile"],
      wouldChange: true,
    },
    structuralIndex: existingIndex,
    structure: {
      action: "remove",
      tileId: update.tileId,
      tileCountBefore,
      tileCountAfter: tileCountBefore - 1,
      tileSizeBefore,
      tileSizeAfter,
    },
  };
}

function requiredRootInteger(
  document: JsonObject,
  key: "tilecount" | "tilewidth" | "tileheight",
  tilesetPath: string,
): number {
  const value = document[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${tilesetPath}.${key} must be a positive integer.`,
      { path: tilesetPath, key },
    );
  }
  return value;
}

function applyRootStructuralPatches(
  document: JsonObject,
  memberPatches: JsonObjectMemberPatch[],
  tileCountAfter: number,
  tileSizeBefore: { width: number; height: number },
  tileSizeAfter: { width: number; height: number },
): void {
  document.tilecount = tileCountAfter;
  memberPatches.push({ path: [], key: "tilecount" });
  if (tileSizeAfter.width !== tileSizeBefore.width) {
    document.tilewidth = tileSizeAfter.width;
    memberPatches.push({
      path: [],
      key: "tilewidth",
    });
  }
  if (
    tileSizeAfter.height !== tileSizeBefore.height
  ) {
    document.tileheight = tileSizeAfter.height;
    memberPatches.push({
      path: [],
      key: "tileheight",
    });
  }
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
  const patch = update.patch;
  if (patch === undefined) {
    throw new TiledMcpError(
      "INTERNAL_ERROR",
      "A metadata tile update reached application without its patch.",
      { tileId: update.tileId },
    );
  }
  const requestedFields = PATCH_FIELDS.filter(
    (field) => patch[field] !== undefined,
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
  let collisionCounts:
    | {
        previousCollisionShapeCount: number;
        collisionShapeCount: number;
      }
    | undefined;
  for (const field of requestedFields) {
    const change = applyTilePatchField(
      target,
      field,
      patch[field],
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
    if (field === "collision") {
      collisionCounts = {
        previousCollisionShapeCount:
          change.previousCollisionShapeCount ??
          0,
        collisionShapeCount:
          change.collisionShapeCount ?? 0,
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
          ...collisionCounts,
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
        ...collisionCounts,
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
        ...collisionCounts,
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
      ...collisionCounts,
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
  previousCollisionShapeCount?: number;
  collisionShapeCount?: number;
} {
  if (field === "collision") {
    return applyTileCollisionPatch(
      target,
      value as TileCollisionPatch | null,
      tilesetPath,
      tileId,
    );
  }
  if (field === "properties") {
    return applyPropertiesPatch(
      target,
      value as PropertiesPatch,
      `${tilesetPath} tile ${tileId}.properties`,
      { path: tilesetPath, tileId },
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
  collection?: TilesetCollectionProfile,
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
      collection,
    );
  }
  if (
    patch.collision !== undefined &&
    patch.collision !== null
  ) {
    validateTileCollisionPatch(
      patch.collision,
      `${context}.collision`,
    );
  }
  if (patch.properties !== undefined) {
    validatePropertiesPatch(
      patch.properties,
      `${context}.properties`,
    );
  }
}

function tileCollisionPointCount(
  collision:
    | TileCollisionPatch
    | null
    | undefined,
): number {
  if (
    collision === undefined ||
    collision === null ||
    !Array.isArray(collision.shapes)
  ) {
    return 0;
  }
  let total = 0;
  for (const shape of collision.shapes) {
    if (Array.isArray(shape?.points)) {
      total += shape.points.length;
    }
  }
  return total;
}

function validateTileCollisionPatch(
  collision: TileCollisionPatch,
  context: string,
): void {
  assertExactKeys(
    collision as unknown as Record<
      string,
      unknown
    >,
    ["shapes"],
    context,
  );
  if (
    !Array.isArray(collision.shapes) ||
    collision.shapes.length === 0 ||
    collision.shapes.length >
      MAX_TILE_COLLISION_SHAPES_PER_TILE
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.shapes must contain between 1 and ${MAX_TILE_COLLISION_SHAPES_PER_TILE} shapes; null removes the collision group.`,
      {
        min: 1,
        max: MAX_TILE_COLLISION_SHAPES_PER_TILE,
        actual: Array.isArray(collision.shapes)
          ? collision.shapes.length
          : null,
      },
    );
  }
  for (const [
    index,
    shape,
  ] of collision.shapes.entries()) {
    validateTileCollisionShape(
      shape,
      `${context}.shapes[${index}]`,
    );
  }
}

function validateTileCollisionShape(
  shape: TileCollisionShapeInput,
  context: string,
): void {
  if (
    typeof shape !== "object" ||
    shape === null ||
    Array.isArray(shape)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be an object.`,
    );
  }
  const kind = shape.shape;
  if (
    !(
      TILE_COLLISION_SHAPE_KINDS as readonly string[]
    ).includes(kind)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.shape must be one of ${TILE_COLLISION_SHAPE_KINDS.join(", ")}.`,
    );
  }
  const hasDimensions =
    kind === "rectangle" ||
    kind === "ellipse" ||
    kind === "capsule";
  const hasPoints =
    kind === "polygon" || kind === "polyline";
  assertExactKeys(
    shape as unknown as Record<string, unknown>,
    [
      "className",
      "name",
      "rotation",
      "shape",
      "x",
      "y",
      ...(hasDimensions
        ? ["height", "width"]
        : []),
      ...(hasPoints ? ["points"] : []),
    ].sort(),
    context,
    true,
  );
  const assertCoordinate = (
    value: unknown,
    field: string,
  ): void => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      Math.abs(value) >
        MAX_TILE_COLLISION_COORDINATE
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.${field} must be a finite number within ±${MAX_TILE_COLLISION_COORDINATE}.`,
      );
    }
  };
  assertCoordinate(shape.x, "x");
  assertCoordinate(shape.y, "y");
  if (shape.rotation !== undefined) {
    assertCoordinate(shape.rotation, "rotation");
  }
  if (hasDimensions) {
    for (const field of [
      "width",
      "height",
    ] as const) {
      const value = shape[field];
      if (value === undefined) {
        continue;
      }
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > MAX_TILE_COLLISION_COORDINATE
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context}.${field} must be a nonnegative finite number within ${MAX_TILE_COLLISION_COORDINATE}.`,
        );
      }
    }
  }
  if (hasPoints) {
    const minimum =
      kind === "polygon"
        ? MIN_TILE_COLLISION_POLYGON_POINTS
        : MIN_TILE_COLLISION_POLYLINE_POINTS;
    if (
      !Array.isArray(shape.points) ||
      shape.points.length < minimum ||
      shape.points.length >
        MAX_TILE_COLLISION_SHAPE_POINTS
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.points must contain between ${minimum} and ${MAX_TILE_COLLISION_SHAPE_POINTS} points.`,
        {
          min: minimum,
          max: MAX_TILE_COLLISION_SHAPE_POINTS,
          actual: Array.isArray(shape.points)
            ? shape.points.length
            : null,
        },
      );
    }
    for (const [
      pointIndex,
      point,
    ] of shape.points.entries()) {
      assertExactKeys(
        point as unknown as Record<
          string,
          unknown
        >,
        ["x", "y"],
        `${context}.points[${pointIndex}]`,
      );
      assertCoordinate(
        point.x,
        `points[${pointIndex}].x`,
      );
      assertCoordinate(
        point.y,
        `points[${pointIndex}].y`,
      );
    }
  }
  for (const field of [
    "name",
    "className",
  ] as const) {
    const value = shape[field];
    if (value === undefined) {
      continue;
    }
    if (
      typeof value !== "string" ||
      !hasAtMostCodePoints(
        value,
        MAX_TILE_CLASS_NAME_CODE_POINTS,
      )
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.${field} must be a string of at most ${MAX_TILE_CLASS_NAME_CODE_POINTS} Unicode code points.`,
      );
    }
  }
}

function applyTileCollisionPatch(
  target: JsonObject,
  collision: TileCollisionPatch | null,
  tilesetPath: string,
  tileId: number,
): {
  changed: boolean;
  memberKeys: string[];
  previousCollisionShapeCount: number;
  collisionShapeCount: number;
} {
  const context = `${tilesetPath} tile ${tileId}.objectgroup`;
  const before = target.objectgroup;
  const beforeSnapshot = stableJson(
    (before ?? null) as JsonValue,
  );
  let previousObjects: JsonValue[] = [];
  let existingGroup: JsonObject | undefined;
  if (before !== undefined) {
    if (
      typeof before !== "object" ||
      before === null ||
      Array.isArray(before) ||
      (before as JsonObject).type !==
        "objectgroup"
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context} must be an objectgroup object.`,
        { path: tilesetPath, tileId },
      );
    }
    existingGroup = before as JsonObject;
    const objects = existingGroup.objects;
    if (
      objects !== undefined &&
      !Array.isArray(objects)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.objects must be an array.`,
        { path: tilesetPath, tileId },
      );
    }
    previousObjects = Array.isArray(objects)
      ? objects
      : [];
  }
  if (collision === null) {
    const changed = before !== undefined;
    delete target.objectgroup;
    return {
      changed,
      memberKeys: ["objectgroup"],
      previousCollisionShapeCount:
        previousObjects.length,
      collisionShapeCount: 0,
    };
  }
  let maximumId = 0;
  for (const [
    index,
    value,
  ] of previousObjects.entries()) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.objects[${index}] must be an object.`,
        { path: tilesetPath, tileId, index },
      );
    }
    const id = (value as JsonObject).id;
    if (id === undefined) {
      continue;
    }
    if (
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      id < 0
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.objects[${index}].id must be a nonnegative integer.`,
        { path: tilesetPath, tileId, index },
      );
    }
    if (id > maximumId) {
      maximumId = id;
    }
  }
  // Tiled's collision editor seeds the dummy map's nextObjectId with the
  // existing group's highest id + 1, so replacement ids continue after it.
  const objects = collision.shapes.map(
    (shape, index) => {
      const hasDimensions =
        shape.shape === "rectangle" ||
        shape.shape === "ellipse" ||
        shape.shape === "capsule";
      const object: JsonObject = {
        height: hasDimensions
          ? (shape.height ?? 0)
          : 0,
        id: maximumId + 1 + index,
        name: shape.name ?? "",
        rotation: shape.rotation ?? 0,
        type: shape.className ?? "",
        visible: true,
        width: hasDimensions
          ? (shape.width ?? 0)
          : 0,
        x: shape.x,
        y: shape.y,
      };
      if (
        shape.shape === "polygon" ||
        shape.shape === "polyline"
      ) {
        object[shape.shape] = (
          shape.points ?? []
        ).map((point) => ({
          x: point.x,
          y: point.y,
        }));
      } else if (shape.shape !== "rectangle") {
        object[shape.shape] = true;
      }
      return object;
    },
  );
  if (existingGroup !== undefined) {
    existingGroup.objects = objects;
  } else {
    target.objectgroup = {
      draworder: "index",
      name: "",
      objects,
      opacity: 1,
      type: "objectgroup",
      visible: true,
      x: 0,
      y: 0,
    };
  }
  const changed =
    beforeSnapshot !==
    stableJson(
      (target.objectgroup ?? null) as JsonValue,
    );
  return {
    changed,
    memberKeys: ["objectgroup"],
    previousCollisionShapeCount:
      previousObjects.length,
    collisionShapeCount: objects.length,
  };
}

function validateAnimationFrames(
  frames: readonly TileAnimationFrameInput[],
  tileCount: number,
  context: string,
  collection?: TilesetCollectionProfile,
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
    if (
      collection === undefined
        ? frame.tileId >= tileCount
        : !collection.localIds.has(frame.tileId)
    ) {
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
  const structural =
    summary.requestedFields.includes(
      "createCollectionTile",
    ) ||
    summary.requestedFields.includes(
      "removeCollectionTile",
    );
  return {
    type: "updateTile",
    destructive: summary.requestedFields.includes(
      "removeCollectionTile",
    ),
    warning: structural
      ? COLLECTION_STRUCTURAL_WARNING
      : UPDATE_TILE_WARNING,
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
    plan.version !== 2 ||
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
