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

import { afterEach, describe, expect, it } from "vitest";

import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import { computeScatterPicks } from "../src/maps/scatter.js";

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/decor.tsj";

describe("deterministic decoration scatter", () => {
  it("is reproducible, translation-stable, and density-gated", () => {
    const region = { x: 4, y: 4, width: 20, height: 20 };
    const first = computeScatterPicks(
      42,
      region,
      0.3,
      [{ tile: "flower", weight: 1 }],
    );
    expect(
      computeScatterPicks(42, region, 0.3, [
        { tile: "flower", weight: 1 },
      ]),
    ).toEqual(first);
    expect(
      computeScatterPicks(43, region, 0.3, [
        { tile: "flower", weight: 1 },
      ]),
    ).not.toEqual(first);
    // The hash reads absolute coordinates: an overlapping shifted
    // region reproduces the same picks on the shared cells.
    const shifted = computeScatterPicks(
      42,
      { ...region, x: 5 },
      0.3,
      [{ tile: "flower", weight: 1 }],
    );
    const inOverlap = (pick: {
      x: number;
    }): boolean => pick.x >= 5 && pick.x < 24;
    expect(
      shifted.filter(inOverlap),
    ).toEqual(first.filter(inOverlap));
    const everything = computeScatterPicks(
      42,
      region,
      1,
      [{ tile: "flower", weight: 1 }],
    );
    expect(everything).toHaveLength(400);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(
      everything.length,
    );
  });

  it("picks weighted choices deterministically and validates bounds", () => {
    const region = { x: 0, y: 0, width: 30, height: 30 };
    const picks = computeScatterPicks(7, region, 1, [
      { tile: "common", weight: 9 },
      { tile: "rare", weight: 1 },
    ]);
    const common = picks.filter(
      (pick) => pick.tile === "common",
    ).length;
    const rare = picks.filter(
      (pick) => pick.tile === "rare",
    ).length;
    expect(common + rare).toBe(900);
    expect(common).toBeGreaterThan(rare);
    expect(rare).toBeGreaterThan(0);

    expect(() =>
      computeScatterPicks(7, region, 0, [
        { tile: "x", weight: 1 },
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
    expect(() =>
      computeScatterPicks(7, region, 1.5, [
        { tile: "x", weight: 1 },
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
    expect(() =>
      computeScatterPicks(7, region, 0.5, []),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
    expect(() =>
      computeScatterPicks(7, region, 0.5, [
        { tile: "x", weight: 0 },
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  });
});

describe("scatter planning via map edits", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("skips occupied cells and applies as an ordinary setTiles change set", async () => {
    const harness = await createHarness(roots);
    const plan = await harness.service.planScatter({
      mapPath: MAP_PATH,
      layerId: 1,
      region: { x: 0, y: 0, width: 2, height: 2 },
      seed: 42,
      density: 1,
      choices: [
        {
          tile: {
            tileset: {
              kind: "external",
              assetId: harness.assetId,
            },
            localId: 1,
          },
          weight: 1,
        },
      ],
      skipOccupied: true,
      expectedMapRevision: harness.mapRevision,
      expectedDependencyRevisions:
        harness.dependencyRevisions,
    });
    expect(plan).toMatchObject({
      kind: "mapEdit",
      operations: [
        {
          type: "setTiles",
          layerId: 1,
          cells: [
            { x: 1, y: 0 },
            { x: 0, y: 1 },
            { x: 1, y: 1 },
          ],
        },
      ],
    });
    await harness.service.applyEdits(plan);
    const saved = JSON.parse(
      await readFile(
        join(harness.root, MAP_PATH),
        "utf8",
      ),
    ) as {
      layers: Array<{ data: number[] }>;
    };
    // The occupied corner keeps its tile; every other cell gets
    // firstgid 1 + localId 1 = 2.
    expect(saved.layers[0]!.data).toEqual([
      1, 2, 2, 2,
    ]);
  });

  it("fails closed when every matched cell is occupied", async () => {
    const harness = await createHarness(roots, {
      data: [1, 1, 1, 1],
    });
    await expect(
      harness.service.planScatter({
        mapPath: MAP_PATH,
        layerId: 1,
        region: { x: 0, y: 0, width: 2, height: 2 },
        seed: 42,
        density: 1,
        choices: [
          {
            tile: {
              tileset: {
                kind: "external",
                assetId: harness.assetId,
              },
              localId: 1,
            },
            weight: 1,
          },
        ],
        skipOccupied: true,
        expectedMapRevision: harness.mapRevision,
        expectedDependencyRevisions:
          harness.dependencyRevisions,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

interface Harness {
  root: string;
  service: MapService;
  assetId: string;
  mapRevision: string;
  dependencyRevisions: Record<string, string>;
}

async function createHarness(
  roots: Set<string>,
  options: { data?: number[] } = {},
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-scatter-test-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeFile(
    join(root, "tiles/decor.png"),
    Buffer.from("placeholder image bytes", "utf8"),
  );
  await writeFile(
    join(root, TILESET_PATH),
    serializeJsonDocument({
      columns: 2,
      image: "decor.png",
      imageheight: 16,
      imagewidth: 32,
      margin: 0,
      name: "Decor",
      spacing: 0,
      tilecount: 2,
      tiledversion: "1.12.2",
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.10",
    }),
  );
  const map: JsonObject = {
    compressionlevel: -1,
    height: 2,
    infinite: false,
    layers: [
      {
        data: options.data ?? [1, 0, 0, 0],
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
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [
      {
        firstgid: 1,
        source: "../tiles/decor.tsj",
      },
    ],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 2,
  };
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument(map),
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
