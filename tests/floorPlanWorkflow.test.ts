import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  withProject,
  type TestProject,
} from "./support/project.js";

/**
 * The `build_from_floor_plan` prompt, executed.
 *
 * Every step of that recipe has unit coverage somewhere in this suite, but
 * nothing asserted that the steps *compose* -- that a plan image plus a
 * tileset actually lands a finished room on disk. A recipe that has never
 * been run end to end is a claim, not a capability, so this drives the whole
 * sequence against the committed `fixtures/floorplan/` project and asserts
 * the resulting map bytes rather than merely that each call returned.
 *
 * Regenerate the fixture with `pnpm tsx scripts/generate-floorplan-fixture.ts`.
 */

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "floorplan",
);

const MAP_PATH = "maps/tavern.tmj";
const TILESET_PATH = "maps/interior.tsj";
const PLAN_PATH = "plans/plan.png";
const FLOOR_LAYER_ID = 1;
const OBJECT_LAYER_ID = 2;
const WIDTH = 16;
const HEIGHT = 12;

/** Local ids in `fixtures/floorplan/interior.tsj`, by role. */
const TILE = {
  floorWood: 0,
  floorStone: 1,
  wallBrick: 2,
  wallWindow: 3,
  doorClosed: 4,
  floorRug: 5,
  propBarrel: 6,
  propTable: 7,
} as const;

/** The plan colours, which are also the atlas colours. */
const COLOR = {
  floorWood: "#cfc4a8",
  floorStone: "#8f8f96",
  wallBrick: "#6b4a2f",
  wallWindow: "#6fa8c8",
  doorClosed: "#3f6ba3",
  floorRug: "#b8433a",
  propBarrel: "#2f6b4a",
  propTable: "#a33f5b",
} as const;

async function fixture(name: string): Promise<Buffer> {
  return readFile(join(FIXTURE_DIR, name));
}

async function floorPlanProject(): Promise<{
  files: Record<string, Buffer>;
}> {
  return {
    files: {
      [MAP_PATH]: await fixture("tavern.tmj"),
      [TILESET_PATH]: await fixture(
        "interior.tsj",
      ),
      "maps/tiles.png": await fixture(
        "tiles.png",
      ),
      [PLAN_PATH]: await fixture("plan.png"),
    },
  };
}

interface Pins {
  expectedMapRevision: string;
  expectedDependencyRevisions: Record<
    string,
    string
  >;
}

/** Step 2 of the recipe: read the map and keep the pins from that one read. */
async function readPins(
  project: TestProject,
): Promise<Pins & { tilesetAssetId: string }> {
  const summary = (await project.service.getSummary({
    mapPath: MAP_PATH,
  })) as unknown as {
    revision: string;
    dependencyRevisions: Record<string, string>;
    tilesets: Array<{ assetId: string }>;
  };
  const tileset = summary.tilesets[0];
  expect(tileset).toBeDefined();
  return {
    expectedMapRevision: summary.revision,
    expectedDependencyRevisions:
      summary.dependencyRevisions,
    tilesetAssetId: tileset!.assetId,
  };
}

/** Reads the saved map's Floor layer back as a 2D grid of local ids. */
async function savedFloorGrid(
  project: TestProject,
): Promise<number[][]> {
  const saved = JSON.parse(
    await readFile(project.path(MAP_PATH), "utf8"),
  ) as {
    layers: Array<{
      id: number;
      data?: number[];
    }>;
  };
  const layer = saved.layers.find(
    (candidate) =>
      candidate.id === FLOOR_LAYER_ID,
  );
  const data = layer?.data ?? [];
  const rows: number[][] = [];
  for (let y = 0; y < HEIGHT; y++) {
    rows.push(
      data
        .slice(y * WIDTH, (y + 1) * WIDTH)
        // firstgid is 1, so a local id is the raw gid minus one; 0 stays 0
        // meaning "empty" and is rendered here as -1 to keep it distinct.
        .map((gid) => (gid === 0 ? -1 : gid - 1)),
    );
  }
  return rows;
}

describe("build a map from a floor plan", () => {
  it("imports the plan image into a finished room", async () => {
    await withProject(
      {
        ...(await floorPlanProject()),
        prefix: "tiledmcp-floorplan",
      },
      async (project) => {
        // Step 3: name the tiles by role, so the palette below reads as
        // meaning rather than as local ids.
        const namePlan =
          await project.service.planTileNameEdits({
            operations: Object.entries({
              "floor.wood": TILE.floorWood,
              "floor.stone": TILE.floorStone,
              "wall.brick": TILE.wallBrick,
              "wall.window": TILE.wallWindow,
              "door.closed": TILE.doorClosed,
              "floor.rug": TILE.floorRug,
              "prop.barrel": TILE.propBarrel,
              "prop.table": TILE.propTable,
            }).map(([name, localId]) => ({
              type: "upsertName" as const,
              name,
              tileset: TILESET_PATH,
              localId,
            })),
            expectedRegistryRevision: null,
          });
        await project.service.applyTileNameEdit(
          namePlan,
        );
        expect(
          (
            await project.service.listTileNames()
          ).count,
        ).toBe(8);

        // Steps 4 and 5: build the palette by meaning, then import.
        const pins = await readPins(project);
        const importPlan =
          await project.service.planImportImage({
            mapPath: MAP_PATH,
            layerId: FLOOR_LAYER_ID,
            imagePath: PLAN_PATH,
            region: {
              x: 0,
              y: 0,
              width: WIDTH,
              height: HEIGHT,
            },
            palette: [
              {
                color: COLOR.floorWood,
                tile: { name: "floor.wood" },
              },
              {
                color: COLOR.floorStone,
                tile: { name: "floor.stone" },
              },
              {
                color: COLOR.wallBrick,
                tile: { name: "wall.brick" },
              },
              {
                color: COLOR.wallWindow,
                tile: { name: "wall.window" },
              },
              {
                color: COLOR.doorClosed,
                tile: { name: "door.closed" },
              },
              {
                color: COLOR.floorRug,
                tile: { name: "floor.rug" },
              },
              {
                color: COLOR.propBarrel,
                tile: { name: "prop.barrel" },
              },
              {
                color: COLOR.propTable,
                tile: { name: "prop.table" },
              },
            ],
            expectedMapRevision:
              pins.expectedMapRevision,
            expectedDependencyRevisions:
              pins.expectedDependencyRevisions,
          });
        const applied =
          await project.service.applyEdits(
            importPlan,
          );
        expect(applied).toMatchObject({
          changed: true,
        });

        // The room the plan image describes, cell for cell. `#` brick,
        // `w` window, `D` door, `.` wood, `s` stone, `r` rug, `b` barrel,
        // `T` table -- the same picture the fixture generator draws.
        const legend: Record<number, string> = {
          [TILE.floorWood]: ".",
          [TILE.floorStone]: "s",
          [TILE.wallBrick]: "#",
          [TILE.wallWindow]: "w",
          [TILE.doorClosed]: "D",
          [TILE.floorRug]: "r",
          [TILE.propBarrel]: "b",
          [TILE.propTable]: "T",
          [-1]: " ",
        };
        const rendered = (
          await savedFloorGrid(project)
        ).map((row) =>
          row
            .map((id) => legend[id] ?? "?")
            .join(""),
        );
        expect(rendered).toEqual([
          "####ww####ww####",
          "#..............#",
          "#.b..........b.#",
          "#..............#",
          "#.....rrrr.....#",
          "#.....rrrr.....#",
          "#.....rrrr.....#",
          "#......TT......#",
          "#..............#",
          "#..............#",
          "#......ss......#",
          "#######DD#######",
        ]);
      },
    );
  });

  it("places sprites as objects and renders the finished map", async () => {
    await withProject(
      {
        ...(await floorPlanProject()),
        prefix: "tiledmcp-floorplan-objects",
      },
      async (project) => {
        // Step 7: sprites as objects on the object layer, in pixel
        // coordinates. The fixture's tiles are 16px, so cell (7, 7) is
        // pixel (112, 112).
        const pins = await readPins(project);
        const plan =
          await project.service.planEdits({
            mapPath: MAP_PATH,
            operations: [
              {
                type: "createObject",
                layerId: OBJECT_LAYER_ID,
                shape: "point",
                object: {
                  name: "hearth",
                  x: 112,
                  y: 112,
                },
              },
              {
                type: "createObject",
                layerId: OBJECT_LAYER_ID,
                shape: "rectangle",
                object: {
                  name: "bar",
                  x: 32,
                  y: 32,
                  width: 64,
                  height: 16,
                },
              },
            ],
            expectedRevision:
              pins.expectedMapRevision,
            expectedDependencyRevisions:
              pins.expectedDependencyRevisions,
          });
        await project.service.applyEdits(plan);

        const listed =
          (await project.service.listObjects({
            mapPath: MAP_PATH,
          })) as unknown as {
            objects: Array<{
              name: string;
              x: number;
              y: number;
            }>;
          };
        expect(
          listed.objects.map(
            ({ name }) => name,
          ),
        ).toEqual(["hearth", "bar"]);

        // Step 8: verify by rendering. A render that throws, or that comes
        // back without pixels, means the composed map is not actually
        // drawable -- which is the failure this whole test exists to catch.
        const preview =
          await project.service.renderPreview({
            mapPath: MAP_PATH,
          });
        expect(preview.png.byteLength).toBeGreaterThan(0);
        expect(preview.result).toMatchObject({
          width: WIDTH * 16,
          height: HEIGHT * 16,
        });
      },
    );
  });

  it("refuses a stale pin rather than merging", async () => {
    await withProject(
      {
        ...(await floorPlanProject()),
        prefix: "tiledmcp-floorplan-stale",
      },
      async (project) => {
        const pins = await readPins(project);
        const first =
          await project.service.planEdits({
            mapPath: MAP_PATH,
            operations: [
              {
                type: "fillRegion",
                layerId: FLOOR_LAYER_ID,
                region: {
                  x: 0,
                  y: 0,
                  width: 2,
                  height: 2,
                },
                tile: {
                  tileset: {
                    kind: "external",
                    assetId: pins.tilesetAssetId,
                  },
                  localId: TILE.floorWood,
                },
              },
            ],
            expectedRevision:
              pins.expectedMapRevision,
            expectedDependencyRevisions:
              pins.expectedDependencyRevisions,
          });
        await project.service.applyEdits(first);

        // The map has moved on; the original pin must now fail closed.
        await expect(
          project.service.planEdits({
            mapPath: MAP_PATH,
            operations: [
              {
                type: "fillRegion",
                layerId: FLOOR_LAYER_ID,
                region: {
                  x: 2,
                  y: 2,
                  width: 2,
                  height: 2,
                },
                tile: {
                  tileset: {
                    kind: "external",
                    assetId: pins.tilesetAssetId,
                  },
                  localId: TILE.wallBrick,
                },
              },
            ],
            expectedRevision:
              pins.expectedMapRevision,
            expectedDependencyRevisions:
              pins.expectedDependencyRevisions,
          }),
        ).rejects.toMatchObject({
          code: "REVISION_MISMATCH",
        });
      },
    );
  });
});
