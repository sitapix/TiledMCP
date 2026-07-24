import { describe, expect, it } from "vitest";

import type { JsonObject } from "../src/formats/json.js";
import {
  assertTileFindResultSize,
  MAX_TILE_FIND_CLAUSES,
  MAX_TILE_FIND_LIMIT,
  MAX_TILE_FIND_QUERY_BYTES,
  MAX_TILE_FIND_QUERY_CODE_POINTS,
  MAX_TILE_FIND_RESULT_BYTES,
  MAX_TILE_FIND_VALUE_CODE_POINTS,
  searchTilesetDocument,
  type TileFindQuery,
} from "../src/maps/tileSearch.js";
import {
  MAX_TILESET_METADATA_ENTRIES,
  MAX_TILESET_PROPERTY_ENTRIES,
} from "../src/maps/tilesetDetails.js";

const TILESET_PATH = "tiles/terrain.tsj";
const ASSET_ID = "asset_0123456789abcdef01234567";

interface SearchItem {
  tile: {
    tileset: {
      kind: "external";
      assetId: string;
    };
    localId: number;
  };
  sourceIndex: number;
  matchedClauseIndexes: number[];
  class?: {
    name: string;
    source: "type" | "class";
    truncated?: true;
  };
}

interface SearchPage {
  order: "local-id";
  startTileId: number;
  limit: number;
  totalMatches: number;
  returned: number;
  hasEarlier: boolean;
  hasMore: boolean;
  truncated: boolean;
  nextStartTileId?: number;
}

function tileset(
  tiles: JsonObject[],
  tileCount = Math.max(1, tiles.length),
): JsonObject {
  return {
    type: "tileset",
    tilecount: tileCount,
    tiles,
  };
}

function search(
  document: JsonObject,
  query: TileFindQuery,
  options: {
    tileCount?: number;
    startTileId?: number;
    limit?: number;
  } = {},
): Record<string, unknown> {
  const tileCount =
    options.tileCount ??
    (typeof document.tilecount === "number" ? document.tilecount : 1);
  return searchTilesetDocument({
    document,
    path: TILESET_PATH,
    assetId: ASSET_ID,
    tileCount,
    query,
    startTileId: options.startTileId ?? 0,
    limit: options.limit ?? 64,
  });
}

function resultItems(result: Record<string, unknown>): SearchItem[] {
  return result.items as SearchItem[];
}

function resultPage(result: Record<string, unknown>): SearchPage {
  return result.page as SearchPage;
}

describe("tile class search", () => {
  it("uses Tiled 1.12 type before class and falls back to legacy class", () => {
    const document = tileset(
      [
        { id: 2, type: "Rock", class: "Grass" },
        { id: 0, type: "Grass", class: "IgnoredLegacyValue" },
        { id: 1, class: "Grass" },
      ],
      3,
    );

    const result = search(document, {
      mode: "all",
      clauses: [{ kind: "class", equals: "Grass" }],
    });

    expect(resultItems(result)).toEqual([
      {
        tile: {
          tileset: { kind: "external", assetId: ASSET_ID },
          localId: 0,
        },
        sourceIndex: 1,
        matchedClauseIndexes: [0],
        class: { name: "Grass", source: "type" },
      },
      {
        tile: {
          tileset: { kind: "external", assetId: ASSET_ID },
          localId: 1,
        },
        sourceIndex: 2,
        matchedClauseIndexes: [0],
        class: { name: "Grass", source: "class" },
      },
    ]);
  });

  it("implements all and any while reporting every matched clause index", () => {
    const document = tileset(
      [
        {
          id: 0,
          type: "Grass",
          properties: [
            { name: "walkable", type: "bool", value: true },
          ],
        },
        { id: 1, type: "Grass" },
        {
          id: 2,
          type: "Rock",
          properties: [
            { name: "walkable", type: "bool", value: false },
          ],
        },
      ],
      3,
    );
    const clauses: TileFindQuery["clauses"] = [
      { kind: "class", equals: "Grass" },
      { kind: "propertyExists", name: "walkable" },
    ];

    const allResult = search(document, { mode: "all", clauses });
    expect(
      resultItems(allResult).map(({ tile, matchedClauseIndexes }) => ({
        localId: tile.localId,
        matchedClauseIndexes,
      })),
    ).toEqual([{ localId: 0, matchedClauseIndexes: [0, 1] }]);

    const anyResult = search(document, { mode: "any", clauses });
    expect(
      resultItems(anyResult).map(({ tile, matchedClauseIndexes }) => ({
        localId: tile.localId,
        matchedClauseIndexes,
      })),
    ).toEqual([
      { localId: 0, matchedClauseIndexes: [0, 1] },
      { localId: 1, matchedClauseIndexes: [0] },
      { localId: 2, matchedClauseIndexes: [1] },
    ]);
  });

  it("sorts sparse source metadata by local ID and paginates by matching ID", () => {
    const document = tileset(
      [
        { id: 9, type: "Hit" },
        { id: 1, type: "Hit" },
        { id: 7, type: "Hit" },
        { id: 3, type: "Hit" },
      ],
      10,
    );
    const query: TileFindQuery = {
      mode: "all",
      clauses: [{ kind: "class", equals: "Hit" }],
    };

    const first = search(document, query, { limit: 2 });
    expect(
      resultItems(first).map(({ tile, sourceIndex }) => ({
        localId: tile.localId,
        sourceIndex,
      })),
    ).toEqual([
      { localId: 1, sourceIndex: 1 },
      { localId: 3, sourceIndex: 3 },
    ]);
    expect(resultPage(first)).toEqual({
      order: "local-id",
      startTileId: 0,
      limit: 2,
      totalMatches: 4,
      returned: 2,
      hasEarlier: false,
      hasMore: true,
      truncated: true,
      nextStartTileId: 7,
    });

    const second = search(document, query, {
      startTileId: 7,
      limit: 2,
    });
    expect(
      resultItems(second).map(({ tile, sourceIndex }) => ({
        localId: tile.localId,
        sourceIndex,
      })),
    ).toEqual([
      { localId: 7, sourceIndex: 2 },
      { localId: 9, sourceIndex: 0 },
    ]);
    expect(resultPage(second)).toEqual({
      order: "local-id",
      startTileId: 7,
      limit: 2,
      totalMatches: 4,
      returned: 2,
      hasEarlier: true,
      hasMore: false,
      truncated: true,
    });
  });
});

describe("tile property search", () => {
  it("matches false, zero and an empty string without mixing declared types", () => {
    const document = tileset(
      [
        {
          id: 0,
          properties: [
            { name: "enabled", type: "bool", value: false },
            { name: "count", type: "int", value: 0 },
            { name: "ratio", type: "float", value: 0 },
            { name: "label", type: "string", value: "" },
          ],
        },
        {
          id: 1,
          properties: [
            { name: "enabled", type: "bool", value: true },
            { name: "count", type: "float", value: 0 },
            { name: "ratio", type: "int", value: 0 },
            { name: "label", type: "string", value: "0" },
          ],
        },
      ],
      2,
    );
    const query: TileFindQuery = {
      mode: "all",
      clauses: [
        {
          kind: "propertyEquals",
          name: "enabled",
          type: "bool",
          value: false,
        },
        {
          kind: "propertyEquals",
          name: "count",
          type: "int",
          value: 0,
        },
        {
          kind: "propertyEquals",
          name: "ratio",
          type: "float",
          value: 0,
        },
        {
          kind: "propertyEquals",
          name: "label",
          type: "string",
          value: "",
        },
      ],
    };

    expect(
      resultItems(search(document, query)).map(
        ({ tile, matchedClauseIndexes }) => ({
          localId: tile.localId,
          matchedClauseIndexes,
        }),
      ),
    ).toEqual([
      {
        localId: 0,
        matchedClauseIndexes: [0, 1, 2, 3],
      },
    ]);

    const intResult = search(document, {
      mode: "all",
      clauses: [
        {
          kind: "propertyEquals",
          name: "count",
          type: "int",
          value: 0,
        },
      ],
    });
    expect(resultItems(intResult).map(({ tile }) => tile.localId)).toEqual([
      0,
    ]);
  });

  it("treats an omitted property type as string", () => {
    const document = tileset(
      [
        {
          id: 0,
          properties: [{ name: "label", value: "" }],
        },
      ],
      1,
    );

    const result = search(document, {
      mode: "all",
      clauses: [
        {
          kind: "propertyEquals",
          name: "label",
          type: "string",
          value: "",
        },
      ],
    });

    expect(resultItems(result).map(({ tile }) => tile.localId)).toEqual([0]);
    expect(result.scan).toEqual({
      metadataEntries: 1,
      propertyEntries: 1,
      evaluations: 1,
    });
  });

  it("matches color and file scalars exactly without case normalization", () => {
    const document = tileset(
      [
        {
          id: 0,
          properties: [
            { name: "tint", type: "color", value: "#AAbbCC" },
            {
              name: "source",
              type: "file",
              value: "Images/Ground.png",
            },
          ],
        },
        {
          id: 1,
          properties: [
            { name: "tint", type: "color", value: "#aabbcc" },
            {
              name: "source",
              type: "file",
              value: "images/ground.png",
            },
          ],
        },
      ],
      2,
    );

    const result = search(document, {
      mode: "all",
      clauses: [
        {
          kind: "propertyEquals",
          name: "tint",
          type: "color",
          value: "#AAbbCC",
        },
        {
          kind: "propertyEquals",
          name: "source",
          type: "file",
          value: "Images/Ground.png",
        },
      ],
    });

    expect(resultItems(result).map(({ tile }) => tile.localId)).toEqual([0]);
  });

  it("allows propertyExists for custom and complex serialized properties", () => {
    const document = tileset(
      [
        {
          id: 0,
          properties: [
            {
              name: "configuration",
              type: "class",
              propertytype: "GameplayConfig",
              value: { enabled: true },
            },
          ],
        },
      ],
      1,
    );

    const result = search(document, {
      mode: "all",
      clauses: [
        { kind: "propertyExists", name: "configuration" },
      ],
    });

    expect(resultItems(result).map(({ tile }) => tile.localId)).toEqual([0]);
  });
});

describe("invalid tile metadata", () => {
  it("rejects duplicate tile metadata IDs", () => {
    const document = tileset(
      [{ id: 0, type: "Grass" }, { id: 0, type: "Grass" }],
      1,
    );

    expect(() =>
      search(document, {
        mode: "all",
        clauses: [{ kind: "class", equals: "Grass" }],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "INVALID_DOCUMENT",
        details: expect.objectContaining({ localId: 0 }),
      }),
    );
  });

  it("rejects duplicate property names on one tile", () => {
    const document = tileset(
      [
        {
          id: 0,
          properties: [
            { name: "walkable", type: "bool", value: true },
            { name: "walkable", type: "bool", value: false },
          ],
        },
      ],
      1,
    );

    expect(() =>
      search(document, {
        mode: "all",
        clauses: [
          { kind: "propertyExists", name: "walkable" },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "INVALID_DOCUMENT",
        details: expect.objectContaining({
          localId: 0,
          propertyName: "walkable",
        }),
      }),
    );
  });

  it("rejects a tile metadata ID outside the declared local ID range", () => {
    const document = tileset([{ id: 2, type: "Grass" }], 2);

    expect(() =>
      search(document, {
        mode: "all",
        clauses: [{ kind: "class", equals: "Grass" }],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "INVALID_DOCUMENT",
        details: expect.objectContaining({
          localId: 2,
          tileCount: 2,
        }),
      }),
    );
  });

  it.each(["image", "x"] as const)(
    "rejects an atlas tile definition with a per-tile %s override",
    (field) => {
      const document = tileset(
        [
          {
            id: 0,
            type: "Grass",
            [field]: field === "image" ? "override.png" : 1,
          },
        ],
        1,
      );

      expect(() =>
        search(document, {
          mode: "all",
          clauses: [{ kind: "class", equals: "Grass" }],
        }),
      ).toThrowError(
        expect.objectContaining({
          name: "TiledMcpError",
          code: "UNSUPPORTED_TILESET",
          details: expect.objectContaining({
            localId: 0,
            field,
          }),
        }),
      );
    },
  );

  it.each([
    ["string", false, "string", "false"],
    ["file", 1, "file", "1"],
    ["color", "red", "color", "#ff0000"],
    ["int", 1.5, "int", 1],
    ["float", Number.POSITIVE_INFINITY, "float", 1],
    ["bool", 0, "bool", false],
  ] as const)(
    "rejects a malformed %s scalar property value",
    (propertyType, propertyValue, queryType, queryValue) => {
      const document = tileset(
        [
          {
            id: 0,
            properties: [
              {
                name: "value",
                type: propertyType,
                value: propertyValue,
              },
            ],
          },
        ],
        1,
      );
      const query = {
        mode: "all",
        clauses: [
          {
            kind: "propertyEquals",
            name: "value",
            type: queryType,
            value: queryValue,
          },
        ],
      } as TileFindQuery;

      expect(() => search(document, query)).toThrowError(
        expect.objectContaining({
          name: "TiledMcpError",
          code: "INVALID_DOCUMENT",
          details: expect.objectContaining({
            localId: 0,
            propertyName: "value",
            type: propertyType,
          }),
        }),
      );
    },
  );

  it.each([
    {
      label: "custom enum",
      property: {
        name: "biome",
        type: "string",
        propertytype: "Biome",
        value: "forest",
      },
      expected: { type: "string", propertyType: "Biome" },
    },
    {
      label: "class",
      property: {
        name: "biome",
        type: "class",
        propertytype: "BiomeConfig",
        value: { name: "forest" },
      },
      expected: { type: "class", propertyType: "BiomeConfig" },
    },
    {
      label: "list",
      property: {
        name: "biome",
        type: "list",
        value: [{ type: "string", value: "forest" }],
      },
      expected: { type: "list" },
    },
  ])("rejects propertyEquals for a $label property", ({ property, expected }) => {
    const document = tileset(
      [{ id: 0, properties: [property] }],
      1,
    );

    expect(() =>
      search(document, {
        mode: "all",
        clauses: [
          {
            kind: "propertyEquals",
            name: "biome",
            type: "string",
            value: "forest",
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "UNSUPPORTED_PROPERTY_QUERY",
        details: expect.objectContaining({
          localId: 0,
          propertyName: "biome",
          ...expected,
        }),
      }),
    );
  });
});

describe("tile query and result safety limits", () => {
  it("returns an empty page when the optional tiles array is absent", () => {
    const result = search(
      { type: "tileset", tilecount: 4 },
      {
        mode: "all",
        clauses: [{ kind: "class", equals: "Grass" }],
      },
      { tileCount: 4 },
    );

    expect(resultItems(result)).toEqual([]);
    expect(resultPage(result)).toMatchObject({
      totalMatches: 0,
      returned: 0,
      hasEarlier: false,
      hasMore: false,
      truncated: false,
    });
  });

  it("rejects a cursor equal to tilecount", () => {
    expect(() =>
      search(
        tileset([], 4),
        {
          mode: "all",
          clauses: [{ kind: "class", equals: "Grass" }],
        },
        { tileCount: 4, startTileId: 4 },
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "INVALID_ARGUMENT",
      }),
    );
  });

  it("enforces selector and scalar-value Unicode code-point limits", () => {
    const selector = "🌲".repeat(MAX_TILE_FIND_QUERY_CODE_POINTS);
    const value = "🧩".repeat(MAX_TILE_FIND_VALUE_CODE_POINTS);
    const document = tileset(
      [
        {
          id: 0,
          type: selector,
          properties: [{ name: "value", value }],
        },
      ],
      1,
    );
    expect(
      resultItems(
        search(document, {
          mode: "all",
          clauses: [
            { kind: "class", equals: selector },
            {
              kind: "propertyEquals",
              name: "value",
              type: "string",
              value,
            },
          ],
        }),
      ).map(({ tile }) => tile.localId),
    ).toEqual([0]);

    expect(() =>
      search(tileset([], 1), {
        mode: "all",
        clauses: [
          {
            kind: "class",
            equals: `${selector}x`,
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "INVALID_ARGUMENT",
      }),
    );
    expect(() =>
      search(tileset([], 1), {
        mode: "all",
        clauses: [
          {
            kind: "propertyEquals",
            name: "value",
            type: "string",
            value: `${value}x`,
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "INVALID_ARGUMENT",
      }),
    );
  });

  it("rejects more than 100000 sparse metadata entries", () => {
    const document = tileset(
      Array.from(
        { length: MAX_TILESET_METADATA_ENTRIES + 1 },
        (_, id) => ({ id }),
      ),
      MAX_TILESET_METADATA_ENTRIES + 1,
    );

    expect(() =>
      search(document, {
        mode: "all",
        clauses: [{ kind: "class", equals: "Grass" }],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "RESULT_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          actual: MAX_TILESET_METADATA_ENTRIES + 1,
          limit: MAX_TILESET_METADATA_ENTRIES,
        }),
      }),
    );
  });

  it("rejects a duplicate clause", () => {
    const query: TileFindQuery = {
      mode: "any",
      clauses: [
        { kind: "class", equals: "Grass" },
        { kind: "class", equals: "Grass" },
      ],
    };

    expect(() => search(tileset([], 1), query)).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "INVALID_ARGUMENT",
        details: expect.objectContaining({ clauseIndex: 1 }),
      }),
    );
  });

  it("rejects nine clauses", () => {
    const query: TileFindQuery = {
      mode: "any",
      clauses: Array.from(
        { length: MAX_TILE_FIND_CLAUSES + 1 },
        (_, index) => ({
          kind: "class" as const,
          equals: `Class${index}`,
        }),
      ),
    };

    expect(() => search(tileset([], 1), query)).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "INVALID_ARGUMENT",
        details: expect.objectContaining({
          actual: MAX_TILE_FIND_CLAUSES + 1,
          limit: MAX_TILE_FIND_CLAUSES,
        }),
      }),
    );
  });

  it("rejects a serialized query larger than 32 KiB", () => {
    const query: TileFindQuery = {
      mode: "any",
      clauses: Array.from(
        { length: MAX_TILE_FIND_CLAUSES },
        (_, index) => ({
          kind: "propertyEquals" as const,
          name: `property${index}`,
          type: "string" as const,
          value: "🧩".repeat(1_024),
        }),
      ),
    };
    expect(
      Buffer.byteLength(JSON.stringify(query), "utf8"),
    ).toBeGreaterThan(MAX_TILE_FIND_QUERY_BYTES);

    expect(() => search(tileset([], 1), query)).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "INVALID_ARGUMENT",
        details: expect.objectContaining({
          limit: MAX_TILE_FIND_QUERY_BYTES,
        }),
      }),
    );
  });

  it("enforces the aggregate 100001-property scan boundary", () => {
    const document = tileset(
      [
        {
          id: 0,
          properties: Array.from(
            { length: MAX_TILESET_PROPERTY_ENTRIES + 1 },
            (_, index) => ({
              name: `property${index}`,
              type: "int",
              value: index,
            }),
          ),
        },
      ],
      1,
    );

    expect(() =>
      search(document, {
        mode: "all",
        clauses: [
          { kind: "propertyExists", name: "missing" },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "RESULT_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          kind: "tile property entries",
          actual: MAX_TILESET_PROPERTY_ENTRIES + 1,
          limit: MAX_TILESET_PROPERTY_ENTRIES,
        }),
      }),
    );
  });

  it("keeps a normal maximum page inside the 256 KiB result limit", () => {
    const fullClassName = "🌲".repeat(256);
    const document = tileset(
      Array.from({ length: MAX_TILE_FIND_LIMIT }, (_, localId) => ({
        id: localId,
        type: fullClassName,
      })),
      MAX_TILE_FIND_LIMIT,
    );

    const result = search(
      document,
      {
        mode: "all",
        clauses: [{ kind: "class", equals: fullClassName }],
      },
      { limit: MAX_TILE_FIND_LIMIT },
    );
    const bytes = Buffer.byteLength(JSON.stringify({ result }), "utf8");

    expect(resultItems(result)).toHaveLength(MAX_TILE_FIND_LIMIT);
    expect(resultPage(result)).toEqual({
      order: "local-id",
      startTileId: 0,
      limit: MAX_TILE_FIND_LIMIT,
      totalMatches: MAX_TILE_FIND_LIMIT,
      returned: MAX_TILE_FIND_LIMIT,
      hasEarlier: false,
      hasMore: false,
      truncated: false,
    });
    expect(resultItems(result)[0]?.class).toEqual({
      name: "🌲".repeat(128),
      source: "type",
      truncated: true,
    });
    expect(bytes).toBeLessThanOrEqual(MAX_TILE_FIND_RESULT_BYTES);
    expect(() => assertTileFindResultSize(result)).not.toThrow();
  });

  it("rejects a directly constructed result larger than 256 KiB", () => {
    const oversizedResult = {
      payload: "x".repeat(MAX_TILE_FIND_RESULT_BYTES + 1),
    };

    expect(() =>
      assertTileFindResultSize(oversizedResult),
    ).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "RESULT_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          limit: MAX_TILE_FIND_RESULT_BYTES,
        }),
      }),
    );
  });
});
