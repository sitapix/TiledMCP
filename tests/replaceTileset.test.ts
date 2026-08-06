import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withProject } from "./support/project.js";

/**
 * Swapping the art a map is built from, without rebuilding the map.
 *
 * This is the operation remove-then-add cannot express: removal refuses any
 * tileset still in use, so retargeting a map's art that way would mean
 * clearing every referring cell first -- destroying the thing being
 * retargeted. Here `firstgid` never moves, so every GID keeps its value and
 * its slot, and only one `tilesets[]` member changes.
 *
 * The failure modes are the interesting part. A replacement too small to cover
 * a referenced local id would leave those GIDs decoding past the end of the
 * tileset, which is why the planner surveys what is actually in use rather
 * than comparing declared tile counts.
 */

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "floorplan",
);

const MAP_PATH = "maps/tavern.tmj";
const ORIGINAL = "maps/interior.tsj";
const REPLACEMENT = "maps/final.tsj";
const FLOOR_LAYER_ID = 1;
/** The highest local id the tests paint, so a replacement must cover it. */
const PAINTED_LOCAL_ID = 5;
/** Tiles in the committed floor-plan atlas. */
const TOTAL_FIXTURE_TILES = 8;

interface Service {
  getSummary(mapPath: string): Promise<unknown>;
  getRegion(input: unknown): Promise<unknown>;
  planEdits(
    mapPath: string,
    expectedMapRevision: string,
    expectedDependencyRevisions: Record<
      string,
      string
    >,
    operations: unknown[],
  ): Promise<unknown>;
  planReplaceTilesetInMap(
    input: unknown,
  ): Promise<unknown>;
  applyEdits(plan: unknown): Promise<unknown>;
}

interface Summary {
  revision: string;
  tilesets: Array<{
    assetId: string;
    path: string;
    revision: string;
  }>;
}

async function fixture(
  name: string,
): Promise<Buffer> {
  return readFile(join(FIXTURE_DIR, name));
}

/** The fixture tileset renamed, and optionally cut down to fewer tiles. */
async function variantTileset(
  tileCount?: number,
): Promise<Buffer> {
  const tileset = JSON.parse(
    (await fixture("interior.tsj")).toString(
      "utf8",
    ),
  ) as {
    name: string;
    tilecount: number;
    columns: number;
    tilewidth: number;
    image: string;
    imagewidth: number;
    tiles: Array<{ id: number }>;
  };
  tileset.name = "final";
  if (tileCount !== undefined) {
    // The atlas grid has to agree with the image, so a narrower tileset
    // points at a correspondingly narrower one.
    tileset.tilecount = tileCount;
    tileset.columns = tileCount;
    tileset.image = "final.png";
    tileset.imagewidth =
      tileset.tilewidth * tileCount;
    tileset.tiles = tileset.tiles.filter(
      (tile) => tile.id < tileCount,
    );
  }
  return Buffer.from(
    `${JSON.stringify(tileset, null, 2)}\n`,
    "utf8",
  );
}

/** The fixture atlas cropped to its first `tileCount` tiles. */
async function croppedAtlas(
  tileCount: number,
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const source = await fixture("tiles.png");
  const { width, height } = await sharp(
    source,
  ).metadata();
  const tileWidth =
    (width ?? 0) / TOTAL_FIXTURE_TILES;
  return sharp(source)
    .extract({
      left: 0,
      top: 0,
      width: tileWidth * tileCount,
      height: height ?? 0,
    })
    .png()
    .toBuffer();
}

async function project(
  replacementTileCount?: number,
): Promise<{ files: Record<string, Buffer> }> {
  return {
    files: {
      [MAP_PATH]: await fixture("tavern.tmj"),
      [ORIGINAL]: await fixture("interior.tsj"),
      [REPLACEMENT]: await variantTileset(
        replacementTileCount,
      ),
      "maps/tiles.png": await fixture(
        "tiles.png",
      ),
      ...(replacementTileCount === undefined
        ? {}
        : {
            "maps/final.png": await croppedAtlas(
              replacementTileCount,
            ),
          }),
    },
  };
}

const summaryOf = async (
  service: Service,
): Promise<Summary> =>
  (await service.getSummary(
    MAP_PATH,
  )) as Summary;

/** Paints a couple of cells so the swap has something to preserve. */
async function paint(
  service: Service,
): Promise<void> {
  const summary = await summaryOf(service);
  const tileset = summary.tilesets[0]!;
  const plan = await service.planEdits(
    MAP_PATH,
    summary.revision,
    { [tileset.assetId]: tileset.revision },
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
              localId: 0,
            },
          },
          {
            x: 1,
            y: 0,
            tile: {
              tileset: {
                kind: "external",
                assetId: tileset.assetId,
              },
              localId: PAINTED_LOCAL_ID,
            },
          },
        ],
      },
    ],
  );
  await service.applyEdits(plan);
}

/** Every cell of the Floor layer as a local id, or null where empty. */
async function floorCells(
  service: Service,
): Promise<Array<number | null>> {
  const region = (await service.getRegion({
    mapPath: MAP_PATH,
    layerId: FLOOR_LAYER_ID,
    x: 0,
    y: 0,
    width: 16,
    height: 12,
  })) as {
    rows: Array<Array<{ localId: number } | null>>;
  };
  return region.rows
    .flat()
    .map((cell) =>
      cell === null ? null : cell.localId,
    );
}

async function replace(
  service: Service,
): Promise<unknown> {
  const summary = await summaryOf(service);
  const tileset = summary.tilesets[0]!;
  return service.planReplaceTilesetInMap({
    mapPath: MAP_PATH,
    tilesetAssetId: tileset.assetId,
    tilesetPath: REPLACEMENT,
    expectedMapRevision: summary.revision,
    expectedDependencyRevisions: {
      [tileset.assetId]: tileset.revision,
    },
  });
}

describe("replaceTilesetInMap", () => {
  it("repoints the reference and leaves every cell untouched", async () => {
    await withProject(
      {
        ...(await project()),
        prefix: "tiledmcp-replace-tileset",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        await paint(service);
        const before = await floorCells(service);
        expect(
          before.filter(
            (cell) => cell !== null,
          ),
        ).toEqual([0, PAINTED_LOCAL_ID]);

        await service.applyEdits(
          await replace(service),
        );

        const after = await summaryOf(service);
        expect(after.tilesets).toHaveLength(1);
        expect(after.tilesets[0]!.path).toContain(
          "final.tsj",
        );
        // The point of the operation: the cells are byte-identical in meaning.
        expect(await floorCells(service)).toEqual(
          before,
        );
      },
    );
  });

  it("refuses a replacement that cannot cover a referenced local id", async () => {
    await withProject(
      {
        // Three tiles cannot hold the painted local id 5.
        ...(await project(3)),
        prefix: "tiledmcp-replace-tileset",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        await paint(service);
        await expect(
          replace(service),
        ).rejects.toMatchObject({
          code: "TILESET_IN_USE",
        });
      },
    );
  });

  it("allows a smaller replacement when nothing references the missing tiles", async () => {
    await withProject(
      {
        ...(await project(3)),
        prefix: "tiledmcp-replace-tileset",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        // Nothing painted, so no local id is referenced at all.
        await service.applyEdits(
          await replace(service),
        );
        const after = await summaryOf(service);
        expect(after.tilesets[0]!.path).toContain(
          "final.tsj",
        );
      },
    );
  });

  it("refuses a tileset the map does not reference", async () => {
    await withProject(
      {
        ...(await project()),
        prefix: "tiledmcp-replace-tileset",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const summary = await summaryOf(service);
        await expect(
          service.planReplaceTilesetInMap({
            mapPath: MAP_PATH,
            tilesetAssetId:
              "asset_000000000000000000000000",
            tilesetPath: REPLACEMENT,
            expectedMapRevision: summary.revision,
            expectedDependencyRevisions: {
              [summary.tilesets[0]!.assetId]:
                summary.tilesets[0]!.revision,
            },
          }),
        ).rejects.toMatchObject({
          code: "TILESET_NOT_FOUND",
        });
      },
    );
  });

  it("refuses to replace a tileset with itself", async () => {
    await withProject(
      {
        ...(await project()),
        prefix: "tiledmcp-replace-tileset",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const summary = await summaryOf(service);
        const tileset = summary.tilesets[0]!;
        await expect(
          service.planReplaceTilesetInMap({
            mapPath: MAP_PATH,
            tilesetAssetId: tileset.assetId,
            tilesetPath: ORIGINAL,
            expectedMapRevision: summary.revision,
            expectedDependencyRevisions: {
              [tileset.assetId]: tileset.revision,
            },
          }),
        ).rejects.toMatchObject({
          code: "INVALID_ARGUMENT",
        });
      },
    );
  });
});
