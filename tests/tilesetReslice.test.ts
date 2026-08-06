import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withProject } from "./support/project.js";

/**
 * Re-cutting an atlas over the same image.
 *
 * The dangerous member is `tilecount`: it sets the tileset's GID span, and
 * every map referencing the tileset decodes its cells against that span --
 * but a tileset edit pins only one map. So a cut that changes the count is
 * allowed only when the pinned map still resolves under the new one and no
 * other project asset references the tileset at all, which is the same rule
 * `removeCollectionTile` follows and for the same reason.
 *
 * A cut that leaves the count alone touches no GID span and is unguarded.
 */

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "floorplan",
);

const MAP_PATH = "maps/tavern.tmj";
const TILESET_PATH = "maps/interior.tsj";
const FLOOR_LAYER_ID = 1;

interface Service {
  getSummary(mapPath: string): Promise<unknown>;
  getTileset(input: unknown): Promise<unknown>;
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
  planTilesetPropertyEdit(
    input: unknown,
  ): Promise<unknown>;
  applyTilesetPropertyEdit(
    plan: unknown,
  ): Promise<unknown>;
}

interface Summary {
  revision: string;
  tilesets: Array<{
    assetId: string;
    revision: string;
    tileCount: number;
  }>;
}

async function fixture(
  name: string,
): Promise<Buffer> {
  return readFile(join(FIXTURE_DIR, name));
}

async function project(
  extra?: Record<string, Buffer>,
): Promise<{ files: Record<string, Buffer> }> {
  return {
    files: {
      [MAP_PATH]: await fixture("tavern.tmj"),
      [TILESET_PATH]: await fixture(
        "interior.tsj",
      ),
      "maps/tiles.png": await fixture(
        "tiles.png",
      ),
      ...(extra ?? {}),
    },
  };
}

const summaryOf = async (
  service: Service,
): Promise<Summary> =>
  (await service.getSummary(
    MAP_PATH,
  )) as Summary;

async function reslice(
  service: Service,
  atlas: Record<string, number>,
): Promise<unknown> {
  const summary = await summaryOf(service);
  const tileset = summary.tilesets[0]!;
  return service.planTilesetPropertyEdit({
    mapPath: MAP_PATH,
    tilesetAssetId: tileset.assetId,
    expectedMapRevision: summary.revision,
    expectedTilesetRevision: tileset.revision,
    patch: { atlas },
  });
}

describe("atlas re-slice", () => {
  it("re-cuts the grid and recomputes columns and tile count", async () => {
    await withProject(
      {
        ...(await project()),
        prefix: "tiledmcp-reslice",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const before = await summaryOf(service);
        expect(
          before.tilesets[0]!.tileCount,
        ).toBe(8);

        // The atlas is 128x16 at 16x16. Cutting at 8x16 doubles the columns.
        await service.applyTilesetPropertyEdit(
          await reslice(service, {
            tileWidth: 8,
            tileHeight: 16,
          }),
        );

        const after = await summaryOf(service);
        expect(
          after.tilesets[0]!.tileCount,
        ).toBe(16);
      },
    );
  });

  it("refuses a cut that drops a tile the pinned map still uses", async () => {
    await withProject(
      {
        ...(await project()),
        prefix: "tiledmcp-reslice",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const summary = await summaryOf(service);
        const tileset = summary.tilesets[0]!;
        // Paint local id 5, then try to cut down to four tiles.
        await service.applyEdits(
          await service.planEdits(
            MAP_PATH,
            summary.revision,
            {
              [tileset.assetId]:
                tileset.revision,
            },
            [
              {
                type: "setTiles",
                layerId: FLOOR_LAYER_ID,
                cells: [
                  {
                    x: 0,
                    y: 0,
                    tile: {
                      tileset: {
                        kind: "external",
                        assetId: tileset.assetId,
                      },
                      localId: 5,
                    },
                  },
                ],
              },
            ],
          ),
        );

        await expect(
          reslice(service, {
            tileWidth: 32,
            tileHeight: 16,
          }),
        ).rejects.toMatchObject({
          code: "TILESET_IN_USE",
        });
      },
    );
  });

  it("refuses a count change while another asset references the tileset", async () => {
    const other = JSON.parse(
      (await fixture("tavern.tmj")).toString(
        "utf8",
      ),
    ) as Record<string, unknown>;
    await withProject(
      {
        ...(await project({
          "maps/other.tmj": Buffer.from(
            `${JSON.stringify(other, null, 2)}\n`,
            "utf8",
          ),
        })),
        prefix: "tiledmcp-reslice",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        await expect(
          reslice(service, {
            tileWidth: 8,
            tileHeight: 16,
          }),
        ).rejects.toMatchObject({
          code: "TILESET_IN_USE",
        });
      },
    );
  });

  it("allows a cut that leaves the tile count alone", async () => {
    // A 128x32 atlas holds 16 tiles at 16x16 and also 16 at 32x8. The second
    // cut changes the geometry without moving the GID span, so the
    // other-referrer rule has nothing to protect and must not fire.
    const sharp = (await import("sharp")).default;
    const tall = await sharp(
      await fixture("tiles.png"),
    )
      .extend({ bottom: 16 })
      .png()
      .toBuffer();
    const tileset = JSON.parse(
      (await fixture("interior.tsj")).toString(
        "utf8",
      ),
    ) as Record<string, unknown>;
    tileset["imageheight"] = 32;
    tileset["tilecount"] = 16;
    tileset["columns"] = 8;
    const other = JSON.parse(
      (await fixture("tavern.tmj")).toString(
        "utf8",
      ),
    ) as Record<string, unknown>;

    await withProject(
      {
        files: {
          [MAP_PATH]: await fixture(
            "tavern.tmj",
          ),
          [TILESET_PATH]: Buffer.from(
            `${JSON.stringify(tileset, null, 2)}\n`,
            "utf8",
          ),
          "maps/tiles.png": tall,
          "maps/other.tmj": Buffer.from(
            `${JSON.stringify(other, null, 2)}\n`,
            "utf8",
          ),
        },
        prefix: "tiledmcp-reslice",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        expect(
          (await summaryOf(service)).tilesets[0]!
            .tileCount,
        ).toBe(16);

        await service.applyTilesetPropertyEdit(
          await reslice(service, {
            tileWidth: 32,
            tileHeight: 8,
          }),
        );

        const after = await summaryOf(service);
        expect(
          after.tilesets[0]!.tileCount,
        ).toBe(16);
      },
    );
  });

});
