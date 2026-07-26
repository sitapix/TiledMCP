import { TiledMcpError } from "../errors.js";
import {
  expectArray,
  expectInteger,
  expectObject,
  expectString,
  type JsonObject,
  type JsonValue,
} from "../formats/json.js";
import {
  MAX_TILESET_METADATA_ENTRIES,
  MAX_TILESET_PROPERTY_ENTRIES,
  assertAtlasTileDefinition,
  readCollectionTileDefinition,
  readTilesetTileClass,
  type TilesetCollectionProfile,
  type TilesetTileClass,
} from "./tilesetDetails.js";

export const DEFAULT_TILE_FIND_LIMIT = 64;
export const MAX_TILE_FIND_LIMIT = 128;
export const MAX_TILE_FIND_CLAUSES = 8;
export const MAX_TILE_FIND_QUERY_CODE_POINTS = 256;
export const MAX_TILE_FIND_VALUE_CODE_POINTS = 1_024;
export const MAX_TILE_FIND_QUERY_BYTES = 32 * 1024;
export const MAX_TILE_FIND_EVALUATIONS = 800_000;
export const MAX_TILE_FIND_RESULT_BYTES = 256 * 1024;

export const TILE_FIND_PROPERTY_EQUALS_TYPES = [
  "string",
  "int",
  "float",
  "bool",
  "color",
  "file",
] as const;

export type TileFindPropertyEqualsType =
  (typeof TILE_FIND_PROPERTY_EQUALS_TYPES)[number];

export type TileFindClause =
  | {
      kind: "class";
      equals: string;
    }
  | {
      kind: "propertyExists";
      name: string;
    }
  | {
      kind: "propertyEquals";
      name: string;
      type: "string" | "color" | "file";
      value: string;
    }
  | {
      kind: "propertyEquals";
      name: string;
      type: "int" | "float";
      value: number;
    }
  | {
      kind: "propertyEquals";
      name: string;
      type: "bool";
      value: boolean;
    };

export interface TileFindQuery {
  mode: "all" | "any";
  clauses: TileFindClause[];
}

export interface SearchTilesetDocumentInput {
  document: JsonObject;
  path: string;
  assetId: string;
  tileCount: number;
  query: TileFindQuery;
  startTileId: number;
  limit: number;
  /** Present exactly for image-collection tilesets. */
  collection?: TilesetCollectionProfile;
}

interface ParsedTileProperty {
  sourceIndex: number;
  name: string;
  type: string;
  propertyType?: string;
  value: JsonValue;
}

interface TileSearchMatch {
  localId: number;
  sourceIndex: number;
  matchedClauseIndexes: number[];
  tileClass?: TilesetTileClass;
}

const KNOWN_PROPERTY_TYPES = new Set([
  "string",
  "int",
  "float",
  "bool",
  "color",
  "file",
  "object",
  "class",
  "list",
]);
const PROPERTY_EQUALS_TYPES = new Set<string>(
  TILE_FIND_PROPERTY_EQUALS_TYPES,
);
const COLOR_PATTERN = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu;

export function searchTilesetDocument(
  input: SearchTilesetDocumentInput,
): Record<string, unknown> {
  const {
    document,
    path,
    assetId,
    tileCount,
    query,
    startTileId,
    limit,
    collection,
  } = input;
  const idSpan = collection?.idSpan ?? tileCount;
  if (document.type !== "tileset") {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${path} is not a Tiled tileset.`,
      { path },
    );
  }
  const declaredTileCount = expectInteger(
    document.tilecount,
    `${path}.tilecount`,
  );
  if (declaredTileCount !== tileCount) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${path}.tilecount changed while its map binding was being searched.`,
      { path, expectedTileCount: tileCount, actualTileCount: declaredTileCount },
    );
  }
  if (
    !Number.isSafeInteger(startTileId) ||
    startTileId < 0 ||
    startTileId >= idSpan
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `startTileId must be between 0 and ${idSpan - 1}.`,
      { path, startTileId, tileCount },
    );
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_TILE_FIND_LIMIT
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `limit must be between 1 and ${MAX_TILE_FIND_LIMIT}.`,
      { limit, maxLimit: MAX_TILE_FIND_LIMIT },
    );
  }
  assertTileFindQuery(query);

  const tileValues =
    document.tiles === undefined
      ? []
      : expectArray(document.tiles, `${path}.tiles`);
  if (tileValues.length > MAX_TILESET_METADATA_ENTRIES) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${path} has more than ${MAX_TILESET_METADATA_ENTRIES} tile metadata entries.`,
      {
        path,
        actual: tileValues.length,
        limit: MAX_TILESET_METADATA_ENTRIES,
      },
    );
  }
  const evaluations = tileValues.length * query.clauses.length;
  if (
    !Number.isSafeInteger(evaluations) ||
    evaluations > MAX_TILE_FIND_EVALUATIONS
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${path} requires more than ${MAX_TILE_FIND_EVALUATIONS} tile query evaluations.`,
      {
        path,
        actual: evaluations,
        limit: MAX_TILE_FIND_EVALUATIONS,
      },
    );
  }

  const needsProperties = query.clauses.some(
    ({ kind }) =>
      kind === "propertyExists" || kind === "propertyEquals",
  );
  const seenTileIds = new Set<number>();
  const pageCandidates: TileSearchMatch[] = [];
  let propertyEntries = 0;
  let totalMatches = 0;
  let eligibleMatchCount = 0;
  let hasEarlier = false;

  for (const [sourceIndex, value] of tileValues.entries()) {
    const tile = expectObject(value, `${path}.tiles[${sourceIndex}]`);
    const context = `${path}.tiles[${sourceIndex}]`;
    const localId = expectInteger(tile.id, `${context}.id`);
    if (
      localId < 0 ||
      (collection === undefined
        ? localId >= tileCount
        : !collection.localIds.has(localId))
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.id is outside the tileset local ID range.`,
        { path, sourceIndex, localId, tileCount },
      );
    }
    if (seenTileIds.has(localId)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${path} contains duplicate tile metadata for local ID ${localId}.`,
        { path, localId },
      );
    }
    seenTileIds.add(localId);

    if (collection === undefined) {
      assertAtlasTileDefinition(tile, path, localId);
    } else {
      readCollectionTileDefinition(
        tile,
        path,
        localId,
      );
    }
    const tileClass = readTilesetTileClass(tile, context);
    const parsedProperties = needsProperties
      ? readTileProperties(
          tile,
          context,
          path,
          localId,
          propertyEntries,
        )
      : {
          properties: new Map<string, ParsedTileProperty>(),
          totalEntries: propertyEntries,
        };
    const properties = parsedProperties.properties;
    propertyEntries = parsedProperties.totalEntries;

    const matchedClauseIndexes: number[] = [];
    for (const [clauseIndex, clause] of query.clauses.entries()) {
      if (matchesClause(clause, tileClass, properties, path, localId)) {
        matchedClauseIndexes.push(clauseIndex);
      }
    }
    const matched =
      query.mode === "all"
        ? matchedClauseIndexes.length === query.clauses.length
        : matchedClauseIndexes.length > 0;
    if (matched) {
      totalMatches += 1;
      const match = {
        localId,
        sourceIndex,
        matchedClauseIndexes,
        ...(tileClass === undefined ? {} : { tileClass }),
      };
      if (localId < startTileId) {
        hasEarlier = true;
      } else {
        eligibleMatchCount += 1;
        insertBoundedMatch(pageCandidates, match, limit + 1);
      }
    }
  }

  const selectedMatches = pageCandidates.slice(0, limit);
  const hasMore = eligibleMatchCount > selectedMatches.length;
  const nextMatch = hasMore ? pageCandidates[limit] : undefined;
  const truncated = hasEarlier || hasMore;

  return {
    projection: {
      kind: "explicit-tile-semantics-search",
      classResolution: "name-only",
      tileClassField: "type-with-class-compatibility-fallback",
      properties: "explicit-serialized-only",
      propertyValuesReturned: false,
      inheritedPropertiesResolved: false,
      wangAssignments: "not-indexed",
      sourceImages: "not-read",
      comparison: "case-sensitive-exact",
    },
    query: structuredClone(query),
    scan: {
      metadataEntries: tileValues.length,
      propertyEntries,
      evaluations,
    },
    page: {
      order: "local-id",
      startTileId,
      limit,
      totalMatches,
      returned: selectedMatches.length,
      hasEarlier,
      hasMore,
      truncated,
      ...(nextMatch === undefined
        ? {}
        : { nextStartTileId: nextMatch.localId }),
    },
    items: selectedMatches.map((match) => ({
      tile: {
        tileset: { kind: "external", assetId },
        localId: match.localId,
      },
      sourceIndex: match.sourceIndex,
      matchedClauseIndexes: match.matchedClauseIndexes,
      ...(match.tileClass === undefined
        ? {}
        : {
            class: {
              name: match.tileClass.displayName,
              source: match.tileClass.source,
              ...(match.tileClass.truncated
                ? { truncated: true }
                : {}),
            },
          }),
    })),
    truncated,
  };
}

export function assertTileFindResultSize(result: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify({ result }), "utf8");
  if (bytes > MAX_TILE_FIND_RESULT_BYTES) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Tile search result requires ${bytes} bytes; limit is ${MAX_TILE_FIND_RESULT_BYTES}.`,
      {
        bytes,
        limit: MAX_TILE_FIND_RESULT_BYTES,
        suggestion:
          "Request a smaller result page or use a more selective exact query.",
      },
    );
  }
}

function readTileProperties(
  tile: JsonObject,
  context: string,
  path: string,
  localId: number,
  previousTotal: number,
): {
  properties: Map<string, ParsedTileProperty>;
  totalEntries: number;
} {
  const values =
    tile.properties === undefined
      ? []
      : expectArray(tile.properties, `${context}.properties`);
  const totalEntries = previousTotal + values.length;
  assertPropertyScanBudget(totalEntries, path);
  const seenNames = new Set<string>();
  const properties = new Map<string, ParsedTileProperty>();
  for (const [sourceIndex, value] of values.entries()) {
    const propertyContext = `${context}.properties[${sourceIndex}]`;
    const property = expectObject(value, propertyContext);
    const name = expectString(property.name, `${propertyContext}.name`);
    if (seenNames.has(name)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context} contains duplicate tile property name ${JSON.stringify(name)}.`,
        { path, localId, propertyName: name },
      );
    }
    seenNames.add(name);
    const type =
      property.type === undefined
        ? "string"
        : expectString(property.type, `${propertyContext}.type`);
    if (!KNOWN_PROPERTY_TYPES.has(type)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${propertyContext}.type is not a recognized Tiled 1.12 property type.`,
        { path, localId, propertyName: name, type },
      );
    }
    const propertyType =
      property.propertytype === undefined
        ? undefined
        : expectString(
            property.propertytype,
            `${propertyContext}.propertytype`,
          );
    if (!Object.hasOwn(property, "value")) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${propertyContext}.value is required.`,
        { path, localId, propertyName: name },
      );
    }
    properties.set(name, {
      sourceIndex,
      name,
      type,
      ...(propertyType === undefined ? {} : { propertyType }),
      value: property.value as JsonValue,
    });
  }
  return { properties, totalEntries };
}

function matchesClause(
  clause: TileFindClause,
  tileClass: TilesetTileClass | undefined,
  properties: ReadonlyMap<string, ParsedTileProperty>,
  path: string,
  localId: number,
): boolean {
  switch (clause.kind) {
    case "class":
      return tileClass?.fullName === clause.equals;
    case "propertyExists":
      return properties.has(clause.name);
    case "propertyEquals": {
      const property = properties.get(clause.name);
      if (property === undefined) {
        return false;
      }
      if (
        property.propertyType !== undefined ||
        !PROPERTY_EQUALS_TYPES.has(property.type)
      ) {
        throw new TiledMcpError(
          "UNSUPPORTED_PROPERTY_QUERY",
          `Property ${JSON.stringify(clause.name)} on tile ${localId} uses a custom or complex type; the M1 search profile can only compare built-in scalar properties.`,
          {
            path,
            localId,
            propertyName: clause.name,
            type: property.type,
            ...(property.propertyType === undefined
              ? {}
              : { propertyType: property.propertyType }),
            supportedTypes: TILE_FIND_PROPERTY_EQUALS_TYPES,
          },
        );
      }
      validateScalarPropertyValue(property, path, localId);
      return (
        property.type === clause.type &&
        property.value === clause.value
      );
    }
  }
}

function validateScalarPropertyValue(
  property: ParsedTileProperty,
  path: string,
  localId: number,
): void {
  const context = `${path} tile ${localId} property ${JSON.stringify(property.name)}`;
  switch (property.type) {
    case "string":
    case "file":
      if (typeof property.value === "string") {
        return;
      }
      break;
    case "color":
      if (
        typeof property.value === "string" &&
        COLOR_PATTERN.test(property.value)
      ) {
        return;
      }
      break;
    case "int":
      if (
        typeof property.value === "number" &&
        Number.isSafeInteger(property.value)
      ) {
        return;
      }
      break;
    case "float":
      if (
        typeof property.value === "number" &&
        Number.isFinite(property.value)
      ) {
        return;
      }
      break;
    case "bool":
      if (typeof property.value === "boolean") {
        return;
      }
      break;
  }
  throw new TiledMcpError(
    "INVALID_DOCUMENT",
    `${context} has a value inconsistent with its declared type ${property.type}.`,
    {
      path,
      localId,
      propertyName: property.name,
      type: property.type,
    },
  );
}

function assertTileFindQuery(query: TileFindQuery): void {
  if (!isRecord(query)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "query must be an object.",
    );
  }
  assertExactKeys(query, ["mode", "clauses"], "query");
  if (query.mode !== "all" && query.mode !== "any") {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      'query.mode must be "all" or "any".',
    );
  }
  if (
    !Array.isArray(query.clauses) ||
    query.clauses.length < 1 ||
    query.clauses.length > MAX_TILE_FIND_CLAUSES
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `query.clauses must contain between 1 and ${MAX_TILE_FIND_CLAUSES} clauses.`,
      {
        actual: Array.isArray(query.clauses)
          ? query.clauses.length
          : undefined,
        limit: MAX_TILE_FIND_CLAUSES,
      },
    );
  }
  for (const [index, clause] of query.clauses.entries()) {
    assertTileFindClause(clause, index);
  }
  const queryBytes = Buffer.byteLength(JSON.stringify(query), "utf8");
  if (queryBytes > MAX_TILE_FIND_QUERY_BYTES) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `query exceeds the ${MAX_TILE_FIND_QUERY_BYTES} byte serialized limit.`,
      {
        bytes: queryBytes,
        limit: MAX_TILE_FIND_QUERY_BYTES,
      },
    );
  }
  const seenClauses = new Set<string>();
  for (const [index, clause] of query.clauses.entries()) {
    const key = canonicalClauseKey(clause);
    if (seenClauses.has(key)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `query.clauses[${index}] duplicates an earlier clause.`,
        { clauseIndex: index },
      );
    }
    seenClauses.add(key);
  }
}

function assertTileFindClause(
  clause: TileFindClause,
  index: number,
): void {
  if (!isRecord(clause)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `query.clauses[${index}] must be an object.`,
    );
  }
  const context = `query.clauses[${index}]`;
  switch (clause.kind) {
    case "class":
      assertExactKeys(clause, ["kind", "equals"], context);
      assertQueryString(
        clause.equals,
        `${context}.equals`,
        MAX_TILE_FIND_QUERY_CODE_POINTS,
        false,
      );
      return;
    case "propertyExists":
      assertExactKeys(clause, ["kind", "name"], context);
      assertQueryString(
        clause.name,
        `${context}.name`,
        MAX_TILE_FIND_QUERY_CODE_POINTS,
        false,
      );
      return;
    case "propertyEquals":
      assertExactKeys(
        clause,
        ["kind", "name", "type", "value"],
        context,
      );
      assertQueryString(
        clause.name,
        `${context}.name`,
        MAX_TILE_FIND_QUERY_CODE_POINTS,
        false,
      );
      if (
        !TILE_FIND_PROPERTY_EQUALS_TYPES.includes(
          clause.type as TileFindPropertyEqualsType,
        )
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context}.type is not supported for scalar equality.`,
          {
            type: clause.type,
            supportedTypes: TILE_FIND_PROPERTY_EQUALS_TYPES,
          },
        );
      }
      assertPropertyQueryValue(clause, context);
      return;
    default:
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context}.kind must be class, propertyExists or propertyEquals.`,
      );
  }
}

function assertPropertyQueryValue(
  clause: Extract<TileFindClause, { kind: "propertyEquals" }>,
  context: string,
): void {
  switch (clause.type) {
    case "string":
    case "file":
      assertQueryString(
        clause.value,
        `${context}.value`,
        MAX_TILE_FIND_VALUE_CODE_POINTS,
        true,
      );
      return;
    case "color":
      if (
        typeof clause.value !== "string" ||
        !COLOR_PATTERN.test(clause.value)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context}.value must be a #RRGGBB or #AARRGGBB color.`,
        );
      }
      return;
    case "int":
      if (
        typeof clause.value !== "number" ||
        !Number.isSafeInteger(clause.value)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context}.value must be a safe integer.`,
        );
      }
      return;
    case "float":
      if (
        typeof clause.value !== "number" ||
        !Number.isFinite(clause.value)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context}.value must be a finite number.`,
        );
      }
      return;
    case "bool":
      if (typeof clause.value !== "boolean") {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context}.value must be a boolean.`,
        );
      }
      return;
  }
}

function assertQueryString(
  value: unknown,
  context: string,
  maximumCodePoints: number,
  allowEmpty: boolean,
): asserts value is string {
  if (typeof value !== "string") {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be a string.`,
    );
  }
  const codePoints = Array.from(value).length;
  if ((!allowEmpty && codePoints === 0) || codePoints > maximumCodePoints) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must contain ${allowEmpty ? "at most" : "between 1 and"} ${maximumCodePoints} Unicode code points.`,
      { codePoints, maximumCodePoints },
    );
  }
}

function assertPropertyScanBudget(actual: number, path: string): void {
  if (!Number.isSafeInteger(actual) || actual > MAX_TILESET_PROPERTY_ENTRIES) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${path} exceeds the ${MAX_TILESET_PROPERTY_ENTRIES} tile property scan limit.`,
      {
        path,
        kind: "tile property entries",
        actual,
        limit: MAX_TILESET_PROPERTY_ENTRIES,
      },
    );
  }
}

function insertBoundedMatch(
  matches: TileSearchMatch[],
  match: TileSearchMatch,
  maximum: number,
): void {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = matches[middle] as TileSearchMatch;
    if (
      candidate.localId < match.localId ||
      (candidate.localId === match.localId &&
        candidate.sourceIndex <= match.sourceIndex)
    ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  matches.splice(low, 0, match);
  if (matches.length > maximum) {
    matches.pop();
  }
}

function canonicalClauseKey(clause: TileFindClause): string {
  switch (clause.kind) {
    case "class":
      return JSON.stringify([clause.kind, clause.equals]);
    case "propertyExists":
      return JSON.stringify([clause.kind, clause.name]);
    case "propertyEquals":
      return JSON.stringify([
        clause.kind,
        clause.name,
        clause.type,
        clause.value,
      ]);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const unexpected = Object.keys(value).filter(
    (key) => !allowed.includes(key),
  );
  if (unexpected.length > 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported fields.`,
      { context, unexpected },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
