import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChangeSetRegistry } from "../src/changeSets.js";
import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/terrain.tsj";

interface Harness {
  root: string;
  service: MapService;
  assetId: string;
  mapRevision: string;
  tilesetRevision: string;
}

describe("wang set editing", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("creates a set, appends a color, assigns wangtiles, and round-trips", async () => {
    const harness = await createHarness(roots);
    const plan = await harness.service.planWangsetEdits({
      mapPath: MAP_PATH,
      tilesetAssetId: harness.assetId,
      expectedMapRevision: harness.mapRevision,
      expectedTilesetRevision:
        harness.tilesetRevision,
      operations: [
        {
          type: "addWangSet",
          name: "Terrain",
          wangSetType: "corner",
          colors: [
            { name: "Grass", color: "#00aa00" },
          ],
        },
        {
          type: "addWangColor",
          wangSetIndex: 0,
          color: {
            name: "Sand",
            color: "#eedd88",
            probability: 0.5,
            imageTileId: 1,
          },
        },
        {
          type: "setWangTiles",
          wangSetIndex: 0,
          assignments: [
            {
              tileId: 3,
              wangId: [0, 1, 0, 2, 0, 1, 0, 2],
            },
            {
              tileId: 0,
              wangId: [0, 2, 0, 2, 0, 2, 0, 2],
            },
          ],
        },
      ],
    });
    expect(plan.summary).toMatchObject({
      operationCount: 3,
      addedWangSets: [
        { index: 0, name: "Terrain", colorCount: 1 },
      ],
      addedColors: [
        { wangSetIndex: 0, colorIndex: 2 },
      ],
      assignmentChanges: [
        {
          wangSetIndex: 0,
          upserts: 2,
          removals: 0,
          noOps: 0,
        },
      ],
      wouldChange: true,
    });

    const preview = new ChangeSetRegistry().put(plan);
    expect(preview.operations).toMatchObject([
      {
        type: "addWangSet",
        destructive: false,
        index: 0,
        wangSetType: "corner",
        colorCount: 1,
      },
      {
        type: "addWangColor",
        destructive: false,
        colorIndex: 2,
        color: "#eedd88",
      },
      {
        type: "setWangTiles",
        destructive: false,
        upserts: 2,
      },
    ]);

    await harness.service.applyWangsetEdit(plan);
    const document = JSON.parse(
      (
        await readFile(
          join(harness.root, TILESET_PATH),
        )
      ).toString("utf8"),
    ) as JsonObject;
    expect(document.wangsets).toEqual([
      {
        name: "Terrain",
        type: "corner",
        tile: -1,
        colors: [
          {
            color: "#00aa00",
            name: "Grass",
            probability: 1,
            tile: -1,
          },
          {
            color: "#eedd88",
            name: "Sand",
            probability: 0.5,
            tile: 1,
          },
        ],
        // Canonical ascending-tileId save order.
        wangtiles: [
          {
            tileid: 0,
            wangid: [0, 2, 0, 2, 0, 2, 0, 2],
          },
          {
            tileid: 3,
            wangid: [0, 1, 0, 2, 0, 1, 0, 2],
          },
        ],
      },
    ]);

    // Stale replay fails closed after the commit.
    await expect(
      harness.service.applyWangsetEdit(plan),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
    });
  });

  it("applies setWangId semantics: removal, no-op, and upsert", async () => {
    const harness = await createHarness(roots, {
      wangsets: [
        {
          name: "Ground",
          type: "mixed",
          tile: -1,
          colors: [
            {
              color: "#ff0000",
              name: "Rock",
              probability: 1,
              tile: -1,
            },
          ],
          wangtiles: [
            {
              tileid: 1,
              wangid: [0, 1, 0, 1, 0, 1, 0, 1],
            },
            {
              tileid: 2,
              wangid: [1, 0, 1, 0, 1, 0, 1, 0],
            },
          ],
        },
      ],
    });
    const plan = await harness.service.planWangsetEdits({
      mapPath: MAP_PATH,
      tilesetAssetId: harness.assetId,
      expectedMapRevision: harness.mapRevision,
      expectedTilesetRevision:
        harness.tilesetRevision,
      operations: [
        {
          type: "setWangTiles",
          wangSetIndex: 0,
          assignments: [
            {
              tileId: 1,
              wangId: [0, 0, 0, 0, 0, 0, 0, 0],
            },
            {
              tileId: 2,
              wangId: [1, 0, 1, 0, 1, 0, 1, 0],
            },
            {
              tileId: 3,
              wangId: [0, 1, 0, 0, 0, 0, 0, 0],
            },
          ],
        },
      ],
    });
    expect(plan.summary.assignmentChanges).toEqual([
      {
        wangSetIndex: 0,
        upserts: 1,
        removals: 1,
        noOps: 1,
      },
    ]);
    const preview = new ChangeSetRegistry().put(plan);
    expect(preview.operations[0]).toMatchObject({
      type: "setWangTiles",
      destructive: true,
    });

    await harness.service.applyWangsetEdit(plan);
    const document = JSON.parse(
      (
        await readFile(
          join(harness.root, TILESET_PATH),
        )
      ).toString("utf8"),
    ) as JsonObject;
    const wangSet = (
      document.wangsets as JsonObject[]
    )[0]!;
    expect(wangSet.wangtiles).toEqual([
      {
        tileid: 2,
        wangid: [1, 0, 1, 0, 1, 0, 1, 0],
      },
      {
        tileid: 3,
        wangid: [0, 1, 0, 0, 0, 0, 0, 0],
      },
    ]);
  });

  it("fails closed on invalid references, formats, and profiles", async () => {
    const harness = await createHarness(roots);
    const plan_ = (
      operations: Parameters<
        MapService["planWangsetEdits"]
      >[0]["operations"],
    ) =>
      harness.service.planWangsetEdits({
        mapPath: MAP_PATH,
        tilesetAssetId: harness.assetId,
        expectedMapRevision: harness.mapRevision,
        expectedTilesetRevision:
          harness.tilesetRevision,
        operations,
      });

    // A wangId slot may only reference colors that exist at that point.
    await expect(
      plan_([
        {
          type: "addWangSet",
          name: "W",
          wangSetType: "mixed",
          colors: [
            { name: "A", color: "#ff0000" },
          ],
        },
        {
          type: "setWangTiles",
          wangSetIndex: 0,
          assignments: [
            {
              tileId: 0,
              wangId: [0, 2, 0, 0, 0, 0, 0, 0],
            },
          ],
        },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      plan_([
        {
          type: "addWangColor",
          wangSetIndex: 5,
          color: { name: "A", color: "#ff0000" },
        },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      plan_([
        {
          type: "addWangSet",
          name: "W",
          wangSetType: "mixed",
          colors: [
            { name: "A", color: "red" },
          ],
        },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      plan_([
        {
          type: "addWangSet",
          name: "W",
          wangSetType: "mixed",
          imageTileId: 99,
        },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });

    const legacy = await createHarness(roots, {
      wangsets: [
        {
          name: "Old",
          type: "corner",
          cornercolors: [],
        },
      ],
    });
    await expect(
      legacy.service.planWangsetEdits({
        mapPath: MAP_PATH,
        tilesetAssetId: legacy.assetId,
        expectedMapRevision: legacy.mapRevision,
        expectedTilesetRevision:
          legacy.tilesetRevision,
        operations: [
          {
            type: "addWangColor",
            wangSetIndex: 0,
            color: {
              name: "A",
              color: "#ff0000",
            },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });
});

async function createHarness(
  roots: Set<string>,
  options: { wangsets?: JsonObject[] } = {},
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-wang-edit-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeFile(
    join(root, "tiles/terrain.png"),
    Buffer.from("placeholder image bytes", "utf8"),
  );
  await writeFile(
    join(root, TILESET_PATH),
    serializeJsonDocument({
      columns: 2,
      image: "terrain.png",
      imageheight: 32,
      imagewidth: 32,
      margin: 0,
      name: "Terrain",
      spacing: 0,
      tilecount: 4,
      tiledversion: "1.12.2",
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.10",
      ...(options.wangsets === undefined
        ? {}
        : { wangsets: options.wangsets }),
    }),
  );
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument({
      compressionlevel: -1,
      height: 1,
      infinite: false,
      layers: [
        {
          data: [1],
          height: 1,
          id: 1,
          name: "ground",
          opacity: 1,
          type: "tilelayer",
          visible: true,
          width: 1,
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
          source: "../tiles/terrain.tsj",
        },
      ],
      tilewidth: 16,
      type: "map",
      version: "1.10",
      width: 1,
    }),
  );

  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  const service = new MapService(resolver, store);
  const summary = (await service.getSummary(
    MAP_PATH,
  )) as {
    revision: string;
    tilesets: Array<{ assetId: string }>;
    dependencyRevisions: Record<string, string>;
  };
  const assetId = summary.tilesets[0]!.assetId;
  return {
    root,
    service,
    assetId,
    mapRevision: summary.revision,
    tilesetRevision: summary.dependencyRevisions[
      assetId
    ] as string,
  };
}
