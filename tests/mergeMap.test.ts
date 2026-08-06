import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withProject } from "./support/project.js";

/**
 * Stamping one map's tile layers into another.
 *
 * The interesting part is GID translation. Two maps rarely order their
 * tilesets alike, so the same picture has different GIDs in each; copying raw
 * numbers between them is the classic way to silently repaint a map. The
 * planner decodes each source cell against the *source's* firstgid table and
 * re-expresses it as a TileRef into the destination's binding for the same
 * tileset file, which is why the second test below builds a source whose
 * tileset order is deliberately reversed.
 *
 * The plan itself is ordinary setTiles operations, so apply inherits every
 * existing bound and GID check rather than getting a new path of its own.
 */

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "floorplan",
);

const MAP_PATH = "maps/tavern.tmj";
const SOURCE_PATH = "maps/room.tmj";
const TILESET_PATH = "maps/interior.tsj";
const SECOND_TILESET_PATH = "maps/extra.tsj";
const FLOOR_LAYER_ID = 1;

interface Service {
  getSummary(mapPath: string): Promise<unknown>;
  getRegion(input: unknown): Promise<unknown>;
  planMergeMap(input: unknown): Promise<unknown>;
  applyEdits(plan: unknown): Promise<unknown>;
}

interface Summary {
  revision: string;
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

const json = (value: unknown): Buffer =>
  Buffer.from(
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );

/**
 * A 4x3 source map whose Floor layer holds a couple of known tiles.
 * `tilesets` is supplied by the caller so the ordering can be varied.
 */
function sourceMap(
  tilesets: Array<Record<string, unknown>>,
  data: number[],
): Record<string, unknown> {
  return {
    compressionlevel: -1,
    width: 4,
    height: 3,
    infinite: false,
    nextlayerid: 2,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tilewidth: 16,
    tileheight: 16,
    type: "map",
    version: "1.10",
    tilesets,
    layers: [
      {
        id: 1,
        name: "Floor",
        type: "tilelayer",
        width: 4,
        height: 3,
        opacity: 1,
        visible: true,
        x: 0,
        y: 0,
        data,
      },
    ],
  };
}

const summaryOf = async (
  service: Service,
): Promise<Summary> =>
  (await service.getSummary(
    MAP_PATH,
  )) as Summary;

async function merge(
  service: Service,
  extra?: Record<string, number>,
): Promise<unknown> {
  const summary = await summaryOf(service);
  return service.planMergeMap({
    mapPath: MAP_PATH,
    sourceMapPath: SOURCE_PATH,
    expectedMapRevision: summary.revision,
    expectedDependencyRevisions:
      Object.fromEntries(
        summary.tilesets.map((tileset) => [
          tileset.assetId,
          tileset.revision,
        ]),
      ),
    ...(extra ?? {}),
  });
}

/** Local ids of the destination Floor layer, row-major, null where empty. */
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

describe("mergeMap", () => {
  it("stamps the source's tiles at an offset and skips its empty cells", async () => {
    await withProject(
      {
        files: {
          [MAP_PATH]: await fixture("tavern.tmj"),
          [TILESET_PATH]: await fixture(
            "interior.tsj",
          ),
          "maps/tiles.png": await fixture(
            "tiles.png",
          ),
          // Row 0 holds local ids 0 and 2; everything else is empty.
          [SOURCE_PATH]: json(
            sourceMap(
              [
                {
                  firstgid: 1,
                  source: "interior.tsj",
                },
              ],
              [1, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            ),
          ),
        },
        prefix: "tiledmcp-merge",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        await service.applyEdits(
          await merge(service, {
            offsetX: 2,
            offsetY: 1,
          }),
        );

        const cells = await floorCells(service);
        const at = (x: number, y: number) =>
          cells[y * 16 + x];
        expect(at(2, 1)).toBe(0);
        expect(at(4, 1)).toBe(2);
        // The source's empty cells left the destination alone.
        expect(at(3, 1)).toBeNull();
        expect(
          cells.filter((cell) => cell !== null),
        ).toHaveLength(2);
      },
    );
  });

  it("translates GIDs when the source orders its tilesets differently", async () => {
    const interior = JSON.parse(
      (await fixture("interior.tsj")).toString(
        "utf8",
      ),
    ) as Record<string, unknown>;
    const extra = {
      ...interior,
      name: "extra",
    };
    await withProject(
      {
        files: {
          // Destination: interior at firstgid 1, extra at 9.
          [MAP_PATH]: json({
            ...(JSON.parse(
              (
                await fixture("tavern.tmj")
              ).toString("utf8"),
            ) as Record<string, unknown>),
            tilesets: [
              {
                firstgid: 1,
                source: "interior.tsj",
              },
              { firstgid: 9, source: "extra.tsj" },
            ],
          }),
          [TILESET_PATH]: await fixture(
            "interior.tsj",
          ),
          [SECOND_TILESET_PATH]: json(extra),
          "maps/tiles.png": await fixture(
            "tiles.png",
          ),
          // Source: the SAME two tilesets, reversed. GID 1 here is `extra`
          // local 0; GID 9 is `interior` local 0. A raw copy would swap them.
          [SOURCE_PATH]: json(
            sourceMap(
              [
                { firstgid: 1, source: "extra.tsj" },
                {
                  firstgid: 9,
                  source: "interior.tsj",
                },
              ],
              [1, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            ),
          ),
        },
        prefix: "tiledmcp-merge",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        await service.applyEdits(
          await merge(service),
        );

        const region = (await service.getRegion({
          mapPath: MAP_PATH,
          layerId: FLOOR_LAYER_ID,
          x: 0,
          y: 0,
          width: 2,
          height: 1,
        })) as {
          rows: Array<
            Array<{
              localId: number;
              tileset: { assetId: string };
            } | null>
          >;
        };
        const summary = await summaryOf(service);
        const [interiorAsset, extraAsset] =
          summary.tilesets;
        const row = region.rows[0]!;
        // Source cell 0 was `extra` local 0 and must still be `extra`.
        expect(row[0]!.localId).toBe(0);
        expect(row[0]!.tileset.assetId).toBe(
          extraAsset!.assetId,
        );
        // Source cell 1 was `interior` local 0.
        expect(row[1]!.localId).toBe(0);
        expect(row[1]!.tileset.assetId).toBe(
          interiorAsset!.assetId,
        );
      },
    );
  });

  it("refuses a source tileset the destination does not reference", async () => {
    const interior = JSON.parse(
      (await fixture("interior.tsj")).toString(
        "utf8",
      ),
    ) as Record<string, unknown>;
    await withProject(
      {
        files: {
          [MAP_PATH]: await fixture("tavern.tmj"),
          [TILESET_PATH]: await fixture(
            "interior.tsj",
          ),
          [SECOND_TILESET_PATH]: json({
            ...interior,
            name: "extra",
          }),
          "maps/tiles.png": await fixture(
            "tiles.png",
          ),
          [SOURCE_PATH]: json(
            sourceMap(
              [
                { firstgid: 1, source: "extra.tsj" },
              ],
              [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            ),
          ),
        },
        prefix: "tiledmcp-merge",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        await expect(
          merge(service),
        ).rejects.toMatchObject({
          code: "TILESET_NOT_FOUND",
        });
      },
    );
  });

  it("refuses a source layer with no matching destination layer", async () => {
    await withProject(
      {
        files: {
          [MAP_PATH]: await fixture("tavern.tmj"),
          [TILESET_PATH]: await fixture(
            "interior.tsj",
          ),
          "maps/tiles.png": await fixture(
            "tiles.png",
          ),
          [SOURCE_PATH]: json({
            ...sourceMap(
              [
                {
                  firstgid: 1,
                  source: "interior.tsj",
                },
              ],
              [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            ),
            layers: [
              {
                id: 1,
                name: "Decoration",
                type: "tilelayer",
                width: 4,
                height: 3,
                opacity: 1,
                visible: true,
                x: 0,
                y: 0,
                data: [
                  1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                  0,
                ],
              },
            ],
          }),
        },
        prefix: "tiledmcp-merge",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        await expect(
          merge(service),
        ).rejects.toMatchObject({
          code: "LAYER_NOT_FOUND",
        });
      },
    );
  });

  it("refuses a source whose grid does not line up", async () => {
    await withProject(
      {
        files: {
          [MAP_PATH]: await fixture("tavern.tmj"),
          [TILESET_PATH]: await fixture(
            "interior.tsj",
          ),
          "maps/tiles.png": await fixture(
            "tiles.png",
          ),
          [SOURCE_PATH]: json({
            ...sourceMap(
              [
                {
                  firstgid: 1,
                  source: "interior.tsj",
                },
              ],
              [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            ),
            tilewidth: 32,
          }),
        },
        prefix: "tiledmcp-merge",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        await expect(
          merge(service),
        ).rejects.toMatchObject({
          code: "UNSUPPORTED_MAP_PROFILE",
        });
      },
    );
  });
});
