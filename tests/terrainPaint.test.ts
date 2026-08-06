import {
  hasTiledCli,
  TILED_CLI_PATH,
} from "./support/tiledCli.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { wireProject } from "./support/project.js";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { TiledCliAdapter } from "../src/adapters/tiledCli.js";
import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import { TERRAIN_OK_MARKER } from "../src/maps/terrainPaint.js";

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
// Resolved from TILED_CLI_PATH/PATH rather than a hardcoded Linux path,
// which made these permanently skip on macOS regardless of the install.
const REAL_TILED = TILED_CLI_PATH;

interface Harness {
  root: string;
  service: MapService;
  assetId: string;
  mapRevision: string;
  dependencyRevisions: Record<string, string>;
}

type Evaluate = (scriptPath: string) => Promise<{
  stdout: string;
  stderr: string;
}>;

/**
 * Extracts the embedded params literal from the generated static script
 * and writes a caller-provided output document where the script would.
 */
function fakeEvaluate(
  outputLayers: (params: {
    layerId: number;
  }) => JsonObject,
): Evaluate {
  return async (scriptPath) => {
    const source = await readFile(
      scriptPath,
      "utf8",
    );
    const match = source.match(
      /JSON\.parse\((".*")\);/u,
    );
    if (match === null) {
      throw new Error("params literal missing");
    }
    const params = JSON.parse(
      JSON.parse(match[1]!) as string,
    ) as {
      layerId: number;
      outputPath: string;
    };
    await writeFile(
      params.outputPath,
      serializeJsonDocument(
        outputLayers(params),
      ),
    );
    return {
      stdout: `${TERRAIN_OK_MARKER}\n`,
      stderr: "",
    };
  };
}

describe("terrain painting via Tiled wangEdit", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("paints isometric maps identically — wang adjacency is orientation-independent", async () => {
    const harness = await createHarness(roots, {
      orientation: "isometric",
    });
    const plan = await harness.service.planTerrainPaint(
      {
        mapPath: MAP_PATH,
        layerId: 1,
        tilesetAssetId: harness.assetId,
        wangSetIndex: 0,
        corners: [
          { x: 1, y: 1, colorIndex: 1 },
        ],
        expectedMapRevision:
          harness.mapRevision,
        expectedDependencyRevisions:
          harness.dependencyRevisions,
      },
      fakeEvaluate(() =>
        baseMap({ data: [1, 1, 1, 1] }, "isometric"),
      ),
    );
    expect(plan).toMatchObject({
      kind: "mapEdit",
      operations: [
        { type: "setTiles", layerId: 1 },
      ],
    });
  });

  it("turns the CLI result diff into an ordinary setTiles change set", async () => {
    const harness = await createHarness(roots);
    const plan = await harness.service.planTerrainPaint(
      {
        mapPath: MAP_PATH,
        layerId: 1,
        tilesetAssetId: harness.assetId,
        wangSetIndex: 0,
        corners: [
          { x: 1, y: 1, colorIndex: 1 },
        ],
        expectedMapRevision: harness.mapRevision,
        expectedDependencyRevisions:
          harness.dependencyRevisions,
      },
      fakeEvaluate(() =>
        baseMap({ data: [1, 1, 1, 1] }),
      ),
    );
    expect(plan).toMatchObject({
      kind: "mapEdit",
      operations: [
        {
          type: "setTiles",
          layerId: 1,
          cells: [
            {
              x: 1,
              y: 0,
              tile: expect.objectContaining({
                localId: 0,
              }),
            },
            {
              x: 0,
              y: 1,
              tile: expect.objectContaining({
                localId: 0,
              }),
            },
            {
              x: 1,
              y: 1,
              tile: expect.objectContaining({
                localId: 0,
              }),
            },
          ],
        },
      ],
    });

    await harness.service.applyEdits(plan);
    const after = JSON.parse(
      (
        await readFile(
          join(harness.root, MAP_PATH),
        )
      ).toString("utf8"),
    ) as JsonObject;
    expect(
      (after.layers as JsonObject[])[0]?.data,
    ).toEqual([1, 1, 1, 1]);
  });

  it("fails closed on bad selectors, corners, and no-op paints", async () => {
    const harness = await createHarness(roots);
    const plan_ = (
      overrides: Record<string, unknown>,
      evaluate: Evaluate,
    ) =>
      harness.service.planTerrainPaint(
        {
          mapPath: MAP_PATH,
          layerId: 1,
          tilesetAssetId: harness.assetId,
          wangSetIndex: 0,
          corners: [
            { x: 1, y: 1, colorIndex: 1 },
          ],
          expectedMapRevision:
            harness.mapRevision,
          expectedDependencyRevisions:
            harness.dependencyRevisions,
          ...overrides,
        } as never,
        evaluate,
      );
    const neverRuns: Evaluate = async () => {
      throw new Error("must not reach the CLI");
    };

    await expect(
      plan_({ wangSetIndex: 7 }, neverRuns),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      plan_(
        {
          corners: [
            { x: 9, y: 0, colorIndex: 1 },
          ],
        },
        neverRuns,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      plan_(
        {
          corners: [
            { x: 1, y: 1, colorIndex: 5 },
          ],
        },
        neverRuns,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    // A paint that changes nothing fails closed.
    await expect(
      plan_(
        {},
        fakeEvaluate(() =>
          baseMap({ data: [1, 0, 0, 0] }),
        ),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    // A failing script surfaces its marker.
    await expect(
      plan_({}, async () => ({
        stdout:
          "TILEDMCP_TERRAIN_ERR: Error: boom\n",
        stderr: "",
      })),
    ).rejects.toMatchObject({
      code: "TILED_CLI_UNEXPECTED_OUTPUT",
    });
  });

  it.skipIf(!hasTiledCli)(
    "paints through the real Tiled CLI end to end",
    async () => {
      const harness = await createHarness(roots, {
        realImage: true,
      });
      const adapter = new TiledCliAdapter({
        tiledCliPath: REAL_TILED,
        rasterizerPath: process.execPath,
      });
      const plan =
        await harness.service.planTerrainPaint(
          {
            mapPath: MAP_PATH,
            layerId: 1,
            tilesetAssetId: harness.assetId,
            wangSetIndex: 0,
            corners: [
              { x: 1, y: 1, colorIndex: 1 },
            ],
            expectedMapRevision:
              harness.mapRevision,
            expectedDependencyRevisions:
              harness.dependencyRevisions,
          },
          (scriptPath) =>
            adapter.runEvaluate({ scriptPath }),
        );
      const cells = (
        plan.operations[0] as {
          cells: unknown[];
        }
      ).cells;
      expect(cells.length).toBeGreaterThan(0);
      await harness.service.applyEdits(plan);
    },
  );
});

function baseMap(
  layer: { data: number[] } = {
    data: [1, 0, 0, 0],
  },
  orientation = "orthogonal",
): JsonObject {
  return {
    compressionlevel: -1,
    height: 2,
    infinite: false,
    layers: [
      {
        data: layer.data,
        height: 2,
        id: 1,
        name: "ground",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 2,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 2,
    nextobjectid: 1,
    orientation,
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [
      {
        firstgid: 1,
        source: "../tiles/terrain.tsj",
      },
    ],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 2,
  };
}

async function createHarness(
  roots: Set<string>,
  options: {
    realImage?: boolean;
    orientation?: string;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-terrain-test-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeFile(
    join(root, "tiles/terrain.png"),
    options.realImage === true
      ? await sharp({
          create: {
            width: 32,
            height: 16,
            channels: 4,
            background: {
              r: 60,
              g: 140,
              b: 60,
              alpha: 1,
            },
          },
        })
          .png()
          .toBuffer()
      : Buffer.from(
          "placeholder image bytes",
          "utf8",
        ),
  );
  await writeFile(
    join(root, TILESET_PATH),
    serializeJsonDocument({
      columns: 2,
      image: "terrain.png",
      imageheight: 16,
      imagewidth: 32,
      margin: 0,
      name: "Terrain",
      spacing: 0,
      tilecount: 2,
      tiledversion: "1.12.2",
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.10",
      wangsets: [
        {
          name: "Ground",
          type: "corner",
          tile: -1,
          colors: [
            {
              color: "#00ff00",
              name: "Grass",
              probability: 1,
              tile: -1,
            },
          ],
          wangtiles: [
            {
              tileid: 0,
              wangid: [0, 1, 0, 1, 0, 1, 0, 1],
            },
            {
              tileid: 1,
              wangid: [0, 0, 0, 0, 0, 0, 0, 0],
            },
          ],
        },
      ],
    }),
  );
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument(
      baseMap(undefined, options.orientation),
    ),
  );

  const { service } =
    await wireProject(root);
  const summary = (await service.getSummary(
    MAP_PATH,
  )) as {
    revision: string;
    tilesets: Array<{ assetId: string }>;
    dependencyRevisions: Record<string, string>;
  };
  return {
    root,
    service,
    assetId: summary.tilesets[0]!.assetId,
    mapRevision: summary.revision,
    dependencyRevisions:
      summary.dependencyRevisions,
  };
}
