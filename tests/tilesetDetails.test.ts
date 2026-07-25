import { describe, expect, it } from "vitest";

import type { JsonObject } from "../src/formats/json.js";
import {
  assertTilesetDetailResultSize,
  MAX_TILESET_DETAIL_RESULT_BYTES,
  MAX_TILESET_PROPERTY_ENTRIES,
  readTilesetTileClass,
  summarizeTilesetDocument,
} from "../src/maps/tilesetDetails.js";

const TILESET_PATH = "tiles/terrain.tsj";
const IMAGE_PATH = "tiles/terrain.png";

function baseTileset(): JsonObject {
  return {
    type: "tileset",
    version: "1.10",
    tiledversion: "1.12.2",
    name: "Terrain",
    tilewidth: 16,
    tileheight: 16,
    tilecount: 4,
    columns: 2,
    image: "terrain.png",
    imagewidth: 32,
    imageheight: 32,
    margin: 0,
    spacing: 0,
  };
}

function summarize(document: JsonObject = baseTileset()) {
  return summarizeTilesetDocument({
    document,
    path: TILESET_PATH,
    imagePath: IMAGE_PATH,
    name: "Terrain",
    nameTruncated: false,
    tileCount: 4,
    startTileId: 0,
    limit: 64,
  });
}

describe("tileset detail rendering semantics", () => {
  it("bounds a very long tile class without changing its exact search value", () => {
    const fullName = "🌲".repeat(1_000_000);
    const tileClass = readTilesetTileClass(
      { id: 0, type: fullName },
      `${TILESET_PATH}.tiles[0]`,
    );

    expect(tileClass).toEqual({
      fullName,
      displayName: "🌲".repeat(128),
      source: "type",
      truncated: true,
    });
  });

  it("projects valid rendering enum values", () => {
    const document = baseTileset();
    document.objectalignment = "bottomright";
    document.tilerendersize = "grid";
    document.fillmode = "preserve-aspect-fit";
    document.tileoffset = { x: -3, y: 4 };
    document.transformations = {
      hflip: true,
      vflip: false,
      rotate: true,
      preferuntransformed: false,
    };
    document.grid = {
      orientation: "isometric",
      width: 8,
      height: 9,
    };

    expect(summarize(document)).toMatchObject({
      tileset: {
        rendering: {
          objectAlignment: "bottomright",
          tileRenderSize: "grid",
          fillMode: "preserve-aspect-fit",
          tileOffset: { x: -3, y: 4 },
          transformations: {
            flipH: true,
            flipV: false,
            rotate: true,
            preferUntransformed: false,
          },
          grid: {
            orientation: "isometric",
            width: 8,
            height: 9,
          },
        },
      },
    });
  });

  it.each([
    [
      "objectalignment",
      (document: JsonObject) => {
        document.objectalignment = "diagonal";
      },
    ],
    [
      "tilerendersize",
      (document: JsonObject) => {
        document.tilerendersize = "native";
      },
    ],
    [
      "fillmode",
      (document: JsonObject) => {
        document.fillmode = "cover";
      },
    ],
    [
      "grid.orientation",
      (document: JsonObject) => {
        document.grid = {
          orientation: "hexagonal",
          width: 16,
          height: 16,
        };
      },
    ],
  ] as const)("rejects an invalid %s enum value", (_field, mutate) => {
    const document = baseTileset();
    mutate(document);

    expect(() => summarize(document)).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "INVALID_DOCUMENT",
      }),
    );
  });

  it("rejects an oversized non-pageable rendering string before it can escape", () => {
    const document = baseTileset();
    document.objectalignment = "x".repeat(
      MAX_TILESET_DETAIL_RESULT_BYTES + 1,
    );

    expect(() => summarize(document)).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "INVALID_DOCUMENT",
      }),
    );
  });
});

describe("tileset detail safety limits", () => {
  it("rejects a directly constructed result larger than 256 KiB", () => {
    const oversizedResult = {
      payload: "x".repeat(MAX_TILESET_DETAIL_RESULT_BYTES + 1),
    };

    expect(() =>
      assertTilesetDetailResultSize(oversizedResult),
    ).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "RESULT_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          limit: MAX_TILESET_DETAIL_RESULT_BYTES,
        }),
      }),
    );
  });

  it("enforces the aggregate property scan budget across root and tile properties", () => {
    const document = baseTileset();
    const property = { name: "weight", type: "int", value: 1 };
    document.properties = Array.from({ length: 50_001 }, () => property);
    document.tiles = [
      {
        id: 0,
        properties: Array.from({ length: 50_000 }, () => property),
      },
    ];

    expect(() => summarize(document)).toThrowError(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "RESULT_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          kind: "property entries",
          actual: MAX_TILESET_PROPERTY_ENTRIES + 1,
          limit: MAX_TILESET_PROPERTY_ENTRIES,
        }),
      }),
    );
  });

  it("reads scalar tile property values back with explicit omission markers", () => {
    const document = baseTileset();
    document.tiles = [
      {
        id: 0,
        properties: [
          {
            name: "walkable",
            type: "bool",
            value: true,
          },
          {
            name: "weight",
            type: "int",
            value: 5,
          },
          {
            name: "linked",
            type: "object",
            value: 7,
          },
          {
            name: "style",
            propertytype: "GroundStyle",
            type: "string",
            value: "grass",
          },
          {
            name: "big",
            type: "string",
            value: "v".repeat(2_000),
          },
        ],
      },
      { id: 1 },
    ];

    const result = summarize(document);
    const tiles = (
      result.tileMetadata as {
        items: Array<Record<string, unknown>>;
      }
    ).items;
    expect(tiles[0]).toMatchObject({
      localId: 0,
      propertyCount: 5,
      properties: [
        {
          name: "walkable",
          type: "bool",
          value: true,
        },
        { name: "weight", type: "int", value: 5 },
        {
          name: "linked",
          type: "object",
          valueOmitted: true,
          reason: "complex-type",
        },
        {
          name: "style",
          type: "string",
          propertytype: "GroundStyle",
          valueOmitted: true,
          reason: "custom-propertytype",
        },
        {
          name: "big",
          type: "string",
          valueOmitted: true,
          reason: "oversized-value",
          valueCodePoints: 2_000,
        },
      ],
    });
    expect(result.projection).toMatchObject({
      properties:
        "tile-scalar-values-with-omission-markers-others-counts-only",
    });
  });

  it("fails closed on duplicate tile property names and truncates beyond 128 entries", () => {
    const document = baseTileset();
    document.tiles = [
      {
        id: 0,
        properties: [
          { name: "dup", type: "int", value: 1 },
          { name: "dup", type: "int", value: 2 },
        ],
      },
    ];
    expect(() =>
      summarize(document),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_DOCUMENT",
        message: expect.stringContaining(
          "duplicate property name",
        ),
      }),
    );

    document.tiles = [
      {
        id: 0,
        properties: Array.from(
          { length: 130 },
          (_, index) => ({
            name: `p${String(index).padStart(3, "0")}`,
            type: "int",
            value: index,
          }),
        ),
      },
    ];
    const truncated = summarize(document);
    const tile = (
      truncated.tileMetadata as {
        items: Array<Record<string, unknown>>;
      }
    ).items[0]!;
    expect(tile).toMatchObject({
      propertyCount: 130,
      propertiesTruncated: true,
    });
    expect(
      (tile.properties as unknown[]).length,
    ).toBe(128);
  });

  it("projects collision shape geometry with omission markers", () => {
    const document = baseTileset();
    document.tiles = [
      {
        id: 0,
        objectgroup: {
          draworder: "index",
          name: "",
          objects: [
            {
              height: 6,
              id: 1,
              name: "wall",
              rotation: 15,
              type: "solid",
              visible: true,
              width: 10,
              x: 1,
              y: 2,
            },
            {
              height: 0,
              id: 2,
              name: "",
              polygon: [
                { x: 0, y: 0 },
                { x: 8, y: 0 },
                { x: 4, y: 8 },
              ],
              rotation: 0,
              type: "",
              visible: true,
              width: 0,
              x: 0,
              y: 0,
            },
            {
              ellipse: true,
              height: 4,
              id: 3,
              name: "",
              rotation: 0,
              type: "",
              visible: true,
              width: 4,
              x: 6,
              y: 6,
            },
            {
              gid: 1,
              height: 16,
              id: 4,
              name: "prop",
              rotation: 0,
              type: "",
              visible: true,
              width: 16,
              x: 0,
              y: 16,
            },
            {
              height: 0,
              id: 5,
              name: "",
              polyline: Array.from(
                { length: 300 },
                (_, i) => ({ x: i, y: i }),
              ),
              rotation: 0,
              type: "",
              visible: true,
              width: 0,
              x: 0,
              y: 0,
              properties: [
                {
                  name: "oneWay",
                  type: "bool",
                  value: true,
                },
              ],
            },
          ],
          opacity: 1,
          type: "objectgroup",
          visible: true,
          x: 0,
          y: 0,
        },
      },
    ];

    const result = summarize(document);
    const tile = (
      result.tileMetadata as {
        items: Array<Record<string, unknown>>;
      }
    ).items[0]!;
    expect(tile.collision).toMatchObject({
      objectCount: 5,
      shapes: [
        {
          index: 0,
          id: 1,
          shape: "rectangle",
          x: 1,
          y: 2,
          width: 10,
          height: 6,
          rotation: 15,
          name: "wall",
          className: "solid",
        },
        {
          index: 1,
          id: 2,
          shape: "polygon",
          pointCount: 3,
          points: [
            { x: 0, y: 0 },
            { x: 8, y: 0 },
            { x: 4, y: 8 },
          ],
        },
        {
          index: 2,
          id: 3,
          shape: "ellipse",
          width: 4,
          height: 4,
        },
        {
          index: 3,
          id: 4,
          geometryOmitted: true,
          reason: "tile-object",
          name: "prop",
        },
        {
          index: 4,
          id: 5,
          shape: "polyline",
          pointCount: 300,
          pointsOmitted: true,
          propertyCount: 1,
        },
      ],
    });
    const shapes = (
      tile.collision as {
        shapes: Array<Record<string, unknown>>;
      }
    ).shapes;
    expect(shapes[4]).not.toHaveProperty(
      "points",
    );
    expect(result.projection).toMatchObject({
      collision:
        "bounded-shape-geometry-with-omission-markers",
    });
  });

  it("fails closed on conflicting or malformed collision shapes", () => {
    const document = baseTileset();
    document.tiles = [
      {
        id: 0,
        objectgroup: {
          draworder: "index",
          objects: [
            {
              ellipse: true,
              point: true,
              id: 1,
              x: 0,
              y: 0,
            },
          ],
          type: "objectgroup",
        },
      },
    ];
    expect(() =>
      summarize(document),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_DOCUMENT",
        message: expect.stringContaining(
          "conflicting shape markers",
        ),
      }),
    );

    document.tiles = [
      {
        id: 0,
        objectgroup: {
          draworder: "index",
          objects: [
            {
              id: 1,
              x: Number.NaN,
              y: 0,
            },
          ],
          type: "objectgroup",
        },
      },
    ];
    expect(() =>
      summarize(document),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_DOCUMENT",
      }),
    );
  });

  it("keeps a normal projection within the 256 KiB serialized result limit", () => {
    const document = baseTileset();
    document.objectalignment = "center";
    document.tilerendersize = "tile";
    document.fillmode = "stretch";
    document.grid = {
      orientation: "orthogonal",
      width: 16,
      height: 16,
    };
    document.tiles = [
      {
        id: 0,
        type: "Ground",
        probability: 0.75,
        properties: [{ name: "walkable", type: "bool", value: true }],
      },
      {
        id: 3,
        animation: [
          { tileid: 2, duration: 100 },
          { tileid: 3, duration: 150 },
        ],
      },
    ];

    const result = summarize(document);
    const bytes = Buffer.byteLength(JSON.stringify({ result }), "utf8");

    expect(bytes).toBeLessThanOrEqual(MAX_TILESET_DETAIL_RESULT_BYTES);
    expect(() => assertTilesetDetailResultSize(result)).not.toThrow();
  });

  it("fits a response-shaped maximum metadata page without all-map dependency revisions", () => {
    const document = baseTileset();
    const maximumDisplayName = "🌲".repeat(128);
    document.class = maximumDisplayName;
    document.tilecount = 128;
    document.columns = 16;
    document.imagewidth = 256;
    document.imageheight = 128;
    document.tiles = Array.from({ length: 128 }, (_, localId) => ({
      id: localId,
      type: maximumDisplayName,
      properties: [{ name: "weight", type: "int", value: 1 }],
      objectgroup: { type: "objectgroup", objects: [{ id: 1 }] },
      animation: Array.from({ length: 16 }, (_, frameIndex) => ({
        tileid: frameIndex,
        duration: frameIndex + 1,
      })),
    }));
    document.wangsets = Array.from({ length: 32 }, () => ({
      name: maximumDisplayName,
      type: "mixed",
      class: maximumDisplayName,
      colors: [],
      wangtiles: [],
      properties: [],
    }));

    const projection = summarizeTilesetDocument({
      document,
      path: "p".repeat(4_096),
      imagePath: "i".repeat(4_096),
      name: maximumDisplayName,
      nameTruncated: false,
      tileCount: 128,
      startTileId: 0,
      limit: 128,
    });
    const result = {
      map: {
        path: "m".repeat(4_096),
        revision: `sha256:${"0".repeat(64)}`,
      },
      source: {
        assetId: `asset_${"0".repeat(24)}`,
        revision: `sha256:${"1".repeat(64)}`,
      },
      binding: { firstGid: 1, lastGid: 128 },
      ...projection,
      snapshotConsistency: "non-atomic-read-set",
    };
    const bytes = Buffer.byteLength(JSON.stringify({ result }), "utf8");

    expect(result).not.toHaveProperty("dependencyRevisions");
    expect(bytes).toBeLessThanOrEqual(MAX_TILESET_DETAIL_RESULT_BYTES);
    expect(() => assertTilesetDetailResultSize(result)).not.toThrow();
  });
});
