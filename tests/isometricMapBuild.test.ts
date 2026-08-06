import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withProject } from "./support/project.js";

/**
 * Building on an isometric map, not just reading one.
 *
 * `planEdits` has always accepted isometric maps -- painting cells is
 * orientation-independent. But `planAddTilesetToMap` and `planCreateLayer`
 * loaded through the same context helper without asking for isometric, and so
 * inherited the orthogonal-only guard. The result was a map you could read and
 * paint but could not give a new layer or a new tileset to: every route that
 * would let you start building on it was closed.
 *
 * Neither operation reads the projection. Binding a tileset appends to
 * `tilesets[]` and allocates a GID range; creating a tile layer allocates the
 * map's own dimensions filled with GID zero. This drives the whole sequence to
 * prove the map is actually buildable, rather than asserting the two calls
 * merely return.
 */

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "isotown",
);

const MAP_PATH = "maps/bare.tmj";
const TILESET_PATH = "maps/town.tsj";

interface Service {
  getSummary(mapPath: string): Promise<unknown>;
  getRegion(input: unknown): Promise<unknown>;
  planAddTilesetToMap(
    input: unknown,
  ): Promise<unknown>;
  planCreateLayer(input: unknown): Promise<unknown>;
  planEdits(
    mapPath: string,
    expectedMapRevision: string,
    expectedDependencyRevisions: Record<
      string,
      string
    >,
    operations: unknown[],
  ): Promise<unknown>;
  applyEdits(plan: unknown): Promise<unknown>;
}

interface Summary {
  revision: string;
  orientation: string;
  layers: Array<{ id: number; name: string }>;
  tilesets: Array<{
    assetId: string;
    revision: string;
  }>;
}

async function fixture(
  name: string,
): Promise<Buffer> {
  return readFile(join(FIXTURE_DIR, name));
}

/** The isometric fixture stripped back to a header: no layers, no tilesets. */
async function bareIsometricMap(): Promise<Buffer> {
  const map = JSON.parse(
    (await fixture("town.tmj")).toString("utf8"),
  ) as Record<string, unknown>;
  map["layers"] = [];
  map["tilesets"] = [];
  map["nextlayerid"] = 1;
  return Buffer.from(
    `${JSON.stringify(map, null, 2)}\n`,
    "utf8",
  );
}

const summaryOf = async (
  service: Service,
): Promise<Summary> =>
  (await service.getSummary(
    MAP_PATH,
  )) as Summary;

describe("building on an isometric map", () => {
  it("attaches a tileset, adds a layer and paints into it", async () => {
    await withProject(
      {
        files: {
          [MAP_PATH]: await bareIsometricMap(),
          [TILESET_PATH]: await fixture(
            "town.tsj",
          ),
          "maps/tiles.png": await fixture(
            "tiles.png",
          ),
        },
        prefix: "tiledmcp-isometric-build",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        expect(
          (await summaryOf(service)).orientation,
        ).toBe("isometric");

        // 1. Attach the tileset.
        const bare = await summaryOf(service);
        await service.applyEdits(
          await service.planAddTilesetToMap({
            mapPath: MAP_PATH,
            tilesetPath: TILESET_PATH,
            expectedMapRevision: bare.revision,
            expectedDependencyRevisions: {},
          }),
        );

        // 2. Add a tile layer to paint into.
        const attached = await summaryOf(service);
        expect(attached.tilesets).toHaveLength(1);
        const tileset = attached.tilesets[0]!;
        await service.applyEdits(
          await service.planCreateLayer({
            mapPath: MAP_PATH,
            layerType: "tilelayer",
            name: "Ground",
            expectedMapRevision:
              attached.revision,
            expectedDependencyRevisions: {
              [tileset.assetId]: tileset.revision,
            },
          }),
        );

        // 3. Paint, which always worked -- the point is it is now reachable.
        const built = await summaryOf(service);
        const layerId = built.layers[0]!.id;
        expect(built.layers[0]!.name).toBe(
          "Ground",
        );
        await service.applyEdits(
          await service.planEdits(
            MAP_PATH,
            built.revision,
            {
              [tileset.assetId]: tileset.revision,
            },
            [
              {
                type: "setTiles",
                layerId,
                cells: [
                  {
                    x: 1,
                    y: 2,
                    tile: {
                      tileset: {
                        kind: "external",
                        assetId: tileset.assetId,
                      },
                      localId: 3,
                    },
                  },
                ],
              },
            ],
          ),
        );

        const region = (await service.getRegion({
          mapPath: MAP_PATH,
          layerId,
          x: 0,
          y: 0,
          width: 8,
          height: 6,
        })) as {
          rows: Array<
            Array<{ localId: number } | null>
          >;
        };
        expect(
          region.rows[2]![1]!.localId,
        ).toBe(3);
      },
    );
  });
});
