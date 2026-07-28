import { createHash } from "node:crypto";

import { TiledMcpError } from "../errors.js";
import {
  expectObject,
  stableJson,
  type JsonObject,
  type JsonValue,
} from "../formats/json.js";

export const TILE_NAMES_FILE =
  "tile-names.json";
export const MAX_TILE_NAMES = 4_096;
export const MAX_TILE_NAMES_BYTES = 1024 * 1024;
export const TILE_NAME_PATTERN =
  /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export interface TileNameEntry {
  name: string;
  tileset: string;
  localId: number;
}

/**
 * Validates the .tiledmcp/tile-names.json registry document: version
 * 1, a names object keyed by restricted lowercase identifiers, each
 * entry carrying a project tileset path and a non-negative local id.
 * Unknown members anywhere fail closed — the registry is server-owned
 * metadata and never guesses.
 */
export function readTileNamesDocument(
  document: JsonObject,
  context: string,
): TileNameEntry[] {
  if (document.version !== 1) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context}.version must be 1.`,
    );
  }
  const unknown = Object.keys(document).find(
    (member) =>
      member !== "version" &&
      member !== "names",
  );
  if (unknown !== undefined) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context}.${unknown} is not part of the tile-name registry format.`,
    );
  }
  const names = expectObject(
    document.names,
    `${context}.names`,
  );
  const entries = Object.entries(names);
  if (entries.length > MAX_TILE_NAMES) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `The tile-name registry may hold at most ${MAX_TILE_NAMES} names.`,
      { limit: MAX_TILE_NAMES },
    );
  }
  const result: TileNameEntry[] = [];
  for (const [name, value] of entries) {
    if (!TILE_NAME_PATTERN.test(name)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.names key ${JSON.stringify(name)} must match ${TILE_NAME_PATTERN.source}.`,
      );
    }
    const entry = expectObject(
      value,
      `${context}.names[${name}]`,
    );
    const unknownMember = Object.keys(
      entry,
    ).find(
      (member) =>
        member !== "tileset" &&
        member !== "localId",
    );
    if (unknownMember !== undefined) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.names[${name}].${unknownMember} is not part of the tile-name registry format.`,
      );
    }
    if (
      typeof entry.tileset !== "string" ||
      entry.tileset.length === 0
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.names[${name}].tileset must be a project path.`,
      );
    }
    if (
      typeof entry.localId !== "number" ||
      !Number.isSafeInteger(entry.localId) ||
      entry.localId < 0
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.names[${name}].localId must be a non-negative integer.`,
      );
    }
    result.push({
      name,
      tileset: entry.tileset,
      localId: entry.localId,
    });
  }
  result.sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  return result;
}

export const MAX_TILE_NAME_OPERATIONS = 64;

const TILE_NAME_EDIT_PLAN_HASH_DOMAIN =
  "tiledmcp/tile-name-edit-plan/v1\0";

export type TileNameOperation =
  | {
      type: "upsertName";
      name: string;
      tileset: string;
      localId: number;
    }
  | { type: "deleteName"; name: string };

export interface TileNameEditPlan {
  kind: "tileNameEdit";
  version: 1;
  id: string;
  /**
   * Raw SHA-256 of the registry file at planning time, or null when
   * the file did not exist — apply re-verifies either way, so a
   * concurrent registry write fails closed.
   */
  registryRevision: string | null;
  /**
   * Raw SHA-256 of the approved serialized registry content — the
   * uniform apply guard, mirroring fileExport's no-replace pin.
   */
  baseRevision: string;
  operations: TileNameOperation[];
  summary: {
    upserts: number;
    deletes: number;
    resultingCount: number;
    wouldChange: true;
  };
}

export function tileNameEditPlanId(
  value: Omit<TileNameEditPlan, "id">,
): string {
  return `changeset:${createHash("sha256")
    .update(TILE_NAME_EDIT_PLAN_HASH_DOMAIN)
    .update(
      stableJson(value as unknown as JsonValue),
    )
    .digest("hex")}`;
}

export function assertTileNameEditPlan(
  plan: TileNameEditPlan,
): void {
  if (
    typeof plan !== "object" ||
    plan === null ||
    plan.kind !== "tileNameEdit" ||
    plan.version !== 1 ||
    typeof plan.id !== "string" ||
    (plan.registryRevision !== null &&
      typeof plan.registryRevision !==
        "string") ||
    typeof plan.baseRevision !== "string" ||
    !Array.isArray(plan.operations) ||
    plan.operations.length === 0 ||
    plan.operations.length >
      MAX_TILE_NAME_OPERATIONS ||
    typeof plan.summary !== "object" ||
    plan.summary === null
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The tile-name edit plan is malformed.",
    );
  }
  const { id, ...unsigned } = plan;
  if (id !== tileNameEditPlanId(unsigned)) {
    throw new TiledMcpError(
      "CHANGE_SET_TAMPERED",
      "The tile-name edit plan contents do not match its digest. Preview the edits again.",
    );
  }
}

/**
 * Applies validated operations to a name map, returning the new map.
 * Upserts replace in place; deleting an absent name fails closed.
 */
export function applyTileNameOperations(
  current: ReadonlyMap<
    string,
    { tileset: string; localId: number }
  >,
  operations: readonly TileNameOperation[],
): Map<
  string,
  { tileset: string; localId: number }
> {
  const next = new Map(current);
  for (const [
    index,
    operation,
  ] of operations.entries()) {
    if (operation.type === "upsertName") {
      if (
        !TILE_NAME_PATTERN.test(operation.name)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${index}].name must match ${TILE_NAME_PATTERN.source}.`,
        );
      }
      next.set(operation.name, {
        tileset: operation.tileset,
        localId: operation.localId,
      });
    } else {
      if (!next.has(operation.name)) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `operations[${index}] deletes ${JSON.stringify(operation.name)}, which is not registered.`,
        );
      }
      next.delete(operation.name);
    }
  }
  if (next.size > MAX_TILE_NAMES) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `The tile-name registry may hold at most ${MAX_TILE_NAMES} names.`,
      { limit: MAX_TILE_NAMES },
    );
  }
  return next;
}

/** Canonical registry serialization: sorted names, two-space indent. */
export function serializeTileNames(
  names: ReadonlyMap<
    string,
    { tileset: string; localId: number }
  >,
): string {
  const sorted = [...names.keys()].sort();
  const document = {
    version: 1,
    names: Object.fromEntries(
      sorted.map((name) => [
        name,
        names.get(name)!,
      ]),
    ),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export interface TileNameEditApplyResult {
  path: string;
  beforeRevision: string | null;
  revision: string;
  changed: true;
  changeSetId: string;
  nameCount: number;
}
