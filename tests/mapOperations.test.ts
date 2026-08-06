import { describe, expect, it } from "vitest";

import type { JsonObject } from "../src/formats/json.js";
import type { TilesetBinding } from "../src/maps/mapDomain.js";
import { validateAndSummarizeOperations } from "../src/maps/mapOperations.js";
import type { PlannedMapEditOperation } from "../src/maps/types.js";

/**
 * The operation interpreter is reached directly here — no temp directory, no
 * DocumentStore, no MapService. A document in memory goes in and a summary
 * comes out, which is the whole point of the seam these tests sit on.
 */

const TILESET: TilesetBinding = {
  assetId: "asset_000000000000000000000001",
  path: "tiles/terrain.tsj",
  firstGid: 1,
  tileCount: 4,
  gidSpan: 4,
  name: "terrain",
  nameTruncated: false,
  revision: `sha256:${"0".repeat(64)}`,
};

function map(): JsonObject {
  return {
    type: "map",
    version: "1.10",
    tiledversion: "1.11.0",
    orientation: "orthogonal",
    renderorder: "right-down",
    infinite: false,
    width: 4,
    height: 4,
    tilewidth: 16,
    tileheight: 16,
    nextlayerid: 2,
    nextobjectid: 1,
    tilesets: [
      { firstgid: 1, source: "../tiles/terrain.tsj" },
    ],
    layers: [
      {
        id: 1,
        name: "ground",
        type: "tilelayer",
        visible: true,
        opacity: 1,
        x: 0,
        y: 0,
        width: 4,
        height: 4,
        data: new Array(16).fill(0),
      },
    ],
  } as unknown as JsonObject;
}

function summarize(
  document: JsonObject,
  operations: PlannedMapEditOperation[],
) {
  return validateAndSummarizeOperations(
    document,
    "orthogonal",
    [TILESET],
    operations,
    "maps/level.tmj",
  );
}

describe("validateAndSummarizeOperations", () => {
  it("writes the requested cells into the document it is given", () => {
    const document = map();

    const summary = summarize(document, [
      {
        type: "setTiles",
        layerId: 1,
        cells: [
          {
            x: 1,
            y: 2,
            tile: {
              tileset: {
                kind: "external",
                assetId: TILESET.assetId,
              },
              localId: 2,
            },
          },
        ],
      },
    ]);

    const layer = (
      document["layers"] as JsonObject[]
    )[0] as JsonObject;
    const data = layer["data"] as number[];
    // firstGid 1 + localId 2 => gid 3, at row 2 column 1 of a 4-wide layer.
    expect(data[2 * 4 + 1]).toBe(3);
    expect(summary).toBeDefined();
  });

  it("rejects a cell outside the layer without touching the document", () => {
    const document = map();
    const before = JSON.stringify(document);

    expect(() =>
      summarize(document, [
        {
          type: "setTiles",
          layerId: 1,
          cells: [
            {
              x: 99,
              y: 0,
              tile: {
                tileset: {
                  kind: "external",
                  assetId: TILESET.assetId,
                },
                localId: 0,
              },
            },
          ],
        },
      ]),
    ).toThrow();

    expect(JSON.stringify(document)).toBe(before);
  });

  it("rejects a local id outside the tileset's span", () => {
    expect(() =>
      summarize(map(), [
        {
          type: "setTiles",
          layerId: 1,
          cells: [
            {
              x: 0,
              y: 0,
              tile: {
                tileset: {
                  kind: "external",
                  assetId: TILESET.assetId,
                },
                localId: 99,
              },
            },
          ],
        },
      ]),
    ).toThrow();
  });

  it("rejects an unknown layer id", () => {
    expect(() =>
      summarize(map(), [
        {
          type: "setTiles",
          layerId: 404,
          cells: [
            {
              x: 0,
              y: 0,
              tile: null,
            },
          ],
        },
      ]),
    ).toThrow();
  });

  it("clears a cell when the tile is null", () => {
    const document = map();
    const layer = (
      document["layers"] as JsonObject[]
    )[0] as JsonObject;
    (layer["data"] as number[])[0] = 3;

    summarize(document, [
      {
        type: "setTiles",
        layerId: 1,
        cells: [{ x: 0, y: 0, tile: null }],
      },
    ]);

    expect((layer["data"] as number[])[0]).toBe(0);
  });
});
