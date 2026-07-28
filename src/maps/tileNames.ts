import { TiledMcpError } from "../errors.js";
import {
  expectObject,
  type JsonObject,
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
