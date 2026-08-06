import { readFile } from "node:fs/promises";
import { makeStore } from "./support/project.js";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MapService } from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { revisionOf } from "../src/storage/revision.js";

describe("checked-in M1 fixture", () => {
  it("exposes Tiled 1.12.2 atlas, tile class, collision and Wang metadata", async () => {
    const resolver = await ProjectPathResolver.create(
      resolve("fixtures/mvp"),
    );
    const store = makeStore(resolver);
    const service = new MapService(resolver, store);
    const summary = await service.getSummary("basic.tmj");
    const tileset = (
      summary.tilesets as Array<{ assetId: string; revision: string }>
    )[0];
    expect(tileset).toBeDefined();
    if (tileset === undefined) {
      throw new Error("Expected the fixture map to reference one tileset.");
    }

    const details = await service.getTileset({
      mapPath: "basic.tmj",
      tilesetAssetId: tileset.assetId,
    });
    const source = await readFile(resolve("fixtures/mvp/basic.tsj"));
    const sourceDocument = JSON.parse(source.toString("utf8")) as {
      tiles?: Array<{ id?: number; type?: string; class?: string }>;
    };

    expect(sourceDocument.tiles).toEqual([
      expect.objectContaining({ id: 0, type: "Grass" }),
      expect.objectContaining({ id: 1, type: "Rock" }),
    ]);
    expect(
      sourceDocument.tiles?.some((tile) => tile.class !== undefined),
    ).toBe(false);

    expect(details).toMatchObject({
      source: {
        assetId: tileset.assetId,
        revision: revisionOf(source),
      },
      tileset: {
        path: "basic.tsj",
        tileCount: 4,
        tileSize: { width: 16, height: 16 },
        atlas: { columns: 2, rows: 2 },
        image: {
          path: "tiles.svg",
          declaredPixelSize: { width: 32, height: 32 },
        },
        featureCounts: {
          metadataTiles: 2,
          animatedTiles: 0,
          collisionTiles: 1,
          collisionObjects: 1,
          propertyTiles: 1,
          wangSets: 1,
        },
      },
      tileMetadata: {
        total: 2,
        returned: 2,
        truncated: false,
        items: [
          {
            localId: 0,
            className: "Grass",
            classNameSource: "type",
            propertyCount: 1,
          },
          {
            localId: 1,
            className: "Rock",
            classNameSource: "type",
            collision: { objectCount: 1 },
          },
        ],
      },
      wangSets: {
        total: 1,
        returned: 1,
        truncated: false,
        items: [
          {
            name: "Ground",
            type: "mixed",
            colorCount: 1,
            wangTileCount: 1,
          },
        ],
      },
      truncated: false,
    });

    const found = await service.findTiles({
      mapPath: "basic.tmj",
      tilesetAssetId: tileset.assetId,
      query: {
        mode: "all",
        clauses: [
          { kind: "class", equals: "Grass" },
          {
            kind: "propertyEquals",
            name: "walkable",
            type: "bool",
            value: true,
          },
        ],
      },
      expectedMapRevision: summary.revision as string,
      expectedTilesetRevision: tileset.revision,
    });
    expect(found).toMatchObject({
      map: {
        path: "basic.tmj",
        revision: summary.revision,
      },
      source: {
        assetId: tileset.assetId,
        revision: revisionOf(source),
      },
      page: {
        order: "local-id",
        totalMatches: 1,
        returned: 1,
        hasMore: false,
      },
      items: [
        {
          tile: {
            tileset: {
              kind: "external",
              assetId: tileset.assetId,
            },
            localId: 0,
          },
          matchedClauseIndexes: [0, 1],
          class: {
            name: "Grass",
            source: "type",
          },
        },
      ],
      truncated: false,
    });
    expect(Object.keys(found).sort()).toEqual([
      "items",
      "map",
      "page",
      "projection",
      "query",
      "scan",
      "snapshotConsistency",
      "source",
      "truncated",
    ]);
    const foundItem = (found.items as Array<Record<string, unknown>>)[0];
    expect(foundItem).toBeDefined();
    expect(Object.keys(foundItem ?? {}).sort()).toEqual([
      "class",
      "matchedClauseIndexes",
      "sourceIndex",
      "tile",
    ]);
    expect(found).not.toHaveProperty("propertyValues");
    expect(found).not.toHaveProperty("wangSets");
    expect(found).not.toHaveProperty("wangAssignments");

    const anyFirst = await service.findTiles({
      mapPath: "basic.tmj",
      tilesetAssetId: tileset.assetId,
      query: {
        mode: "any",
        clauses: [
          { kind: "class", equals: "Rock" },
          {
            kind: "propertyEquals",
            name: "walkable",
            type: "bool",
            value: true,
          },
        ],
      },
      limit: 1,
    });
    expect(anyFirst).toMatchObject({
      page: {
        totalMatches: 2,
        returned: 1,
        hasEarlier: false,
        hasMore: true,
        nextStartTileId: 1,
      },
      items: [
        {
          tile: { localId: 0 },
          matchedClauseIndexes: [1],
        },
      ],
      nextPage: {
        startTileId: 1,
        expectedMapRevision: summary.revision,
        expectedTilesetRevision: tileset.revision,
      },
    });
    const nextPage = anyFirst.nextPage as
      | {
          startTileId: number;
          expectedMapRevision: string;
          expectedTilesetRevision: string;
        }
      | undefined;
    if (nextPage === undefined) {
      throw new Error("Expected a revision-pinned fixture search page.");
    }
    const anySecond = await service.findTiles({
      mapPath: "basic.tmj",
      tilesetAssetId: tileset.assetId,
      query: {
        mode: "any",
        clauses: [
          { kind: "class", equals: "Rock" },
          {
            kind: "propertyEquals",
            name: "walkable",
            type: "bool",
            value: true,
          },
        ],
      },
      limit: 1,
      ...nextPage,
    });
    expect(anySecond).toMatchObject({
      page: {
        startTileId: 1,
        totalMatches: 2,
        returned: 1,
        hasEarlier: true,
        hasMore: false,
      },
      items: [
        {
          tile: { localId: 1 },
          matchedClauseIndexes: [0],
        },
      ],
    });
    expect(anySecond).not.toHaveProperty("nextPage");
  });
});
