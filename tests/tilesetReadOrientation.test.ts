import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withProject } from "./support/project.js";

/**
 * Reading a tileset must not depend on the map's projection.
 *
 * `getTileset`, `findTiles`, `renderTilesetSheet` and `renderTiles` take a
 * `mapPath` only to resolve the tileset reference and pin revisions; what they
 * read and draw is the tileset, which has no orientation. All four once shared
 * the edit path's loader and so inherited its orthogonal-only guard, which
 * meant that on an isometric or hexagonal map a client could not read a
 * tileset at all -- and therefore could not discover a single tile id, class
 * or property. These maps are documented as readable, so that made the
 * documentation false rather than the maps unsupported.
 *
 * Both non-orthogonal projections are covered because the guard treats them as
 * two separate permissions, so a fix that only widened one would leave the
 * other broken in exactly the same way.
 */

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "isotown",
);

const MAP_PATH = "maps/town.tmj";
const HEX_MAP_PATH = "maps/hex.tmj";
const EMBEDDED_MAP_PATH = "maps/embedded.tmj";
const TILESET_PATH = "maps/town.tsj";

async function fixture(name: string): Promise<Buffer> {
  return readFile(join(FIXTURE_DIR, name));
}

/**
 * The isometric fixture's map, rewritten as a hexagonal one.
 *
 * Only the header fields that select the projection change; the layers and the
 * tileset reference are the fixture's own, so a failure here is about the
 * orientation guard rather than about the map being different.
 */
async function hexagonalMapBytes(): Promise<Buffer> {
  const map = JSON.parse(
    (await fixture("town.tmj")).toString("utf8"),
  ) as Record<string, unknown>;
  map["orientation"] = "hexagonal";
  map["staggeraxis"] = "y";
  map["staggerindex"] = "odd";
  map["hexsidelength"] = 16;
  return Buffer.from(
    `${JSON.stringify(map, null, 2)}\n`,
    "utf8",
  );
}

/**
 * The same map with its tileset inlined instead of referenced.
 *
 * `tiled_get_tileset` serves embedded tilesets from a different branch with
 * its own context load, so an external-only test would have left that half of
 * the tool still refusing these maps.
 */
async function embeddedMapBytes(): Promise<Buffer> {
  const map = JSON.parse(
    (await fixture("town.tmj")).toString("utf8"),
  ) as { tilesets: unknown[] };
  const tileset = JSON.parse(
    (await fixture("town.tsj")).toString("utf8"),
  ) as Record<string, unknown>;
  map.tilesets = [
    { firstgid: 1, ...tileset },
  ];
  return Buffer.from(
    `${JSON.stringify(map, null, 2)}\n`,
    "utf8",
  );
}

async function project(): Promise<{
  files: Record<string, Buffer>;
}> {
  return {
    files: {
      [MAP_PATH]: await fixture("town.tmj"),
      [HEX_MAP_PATH]: await hexagonalMapBytes(),
      [EMBEDDED_MAP_PATH]:
        await embeddedMapBytes(),
      [TILESET_PATH]: await fixture("town.tsj"),
      "maps/tiles.png": await fixture("tiles.png"),
    },
  };
}

interface Service {
  getSummary(mapPath: string): Promise<unknown>;
  getTileset(input: unknown): Promise<unknown>;
  findTiles(input: unknown): Promise<unknown>;
  renderTilesetSheet(
    input: unknown,
  ): Promise<unknown>;
  renderTiles(input: unknown): Promise<unknown>;
}

describe("tileset reads across map orientations", () => {
  for (const [orientation, mapPath] of [
    ["isometric", MAP_PATH],
    ["hexagonal", HEX_MAP_PATH],
  ] as const) {
    it(`reads a tileset referenced by a ${orientation} map`, async () => {
      await withProject(
        {
          ...(await project()),
          prefix: "tiledmcp-tileset-orientation",
        },
        async (harness) => {
          const service =
            harness.service as unknown as Service;
          const summary =
            (await service.getSummary(
              mapPath,
            )) as {
              orientation: string;
              tilesets: Array<{ assetId: string }>;
            };
          expect(summary.orientation).toBe(
            orientation,
          );
          const tilesetAssetId =
            summary.tilesets[0]!.assetId;

          const tileset =
            (await service.getTileset({
              mapPath,
              tilesetAssetId,
            })) as { tileCount?: number };
          expect(tileset).toBeDefined();

          // The whole point of reading the tileset is to learn what is in it,
          // so assert the tiles are actually enumerable rather than that the
          // call merely returned.
          const found = (await service.findTiles({
            mapPath,
            tilesetAssetId,
            query: {
              mode: "all",
              clauses: [
                { kind: "class", equals: "Water" },
              ],
            },
          })) as { items: unknown[] };
          expect(found.items.length).toBe(1);

          const sheet =
            (await service.renderTilesetSheet({
              mapPath,
              tilesetAssetId,
            })) as { image?: unknown };
          expect(sheet).toBeDefined();

          const tiles = (await service.renderTiles(
            {
              mapPath,
              tilesetAssetId,
              localIds: [0, 1],
            },
          )) as { image?: unknown };
          expect(tiles).toBeDefined();
        },
      );
    });
  }

  it("reads an embedded tileset on a non-orthogonal map", async () => {
    await withProject(
      {
        ...(await project()),
        prefix: "tiledmcp-tileset-orientation",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const embedded =
          (await service.getTileset({
            mapPath: EMBEDDED_MAP_PATH,
            embeddedIndex: 0,
          })) as { tiles?: unknown[] };
        expect(embedded).toBeDefined();
      },
    );
  });
});
