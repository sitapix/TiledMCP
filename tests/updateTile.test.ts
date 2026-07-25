import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ChangeSetRegistry } from "../src/changeSets.js";
import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import type {
  TileMetadataUpdate,
  TilesetEditPlan,
} from "../src/maps/tilesetEdits.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/terrain.tsj";

interface Harness {
  root: string;
  service: MapService;
}

interface Snapshot {
  mapRevision: string;
  tilesetRevision: string;
  assetId: string;
}

describe("updateTile", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("patches probability, class and animation member-locally", async () => {
    const harness = await createHarness(roots, {
      tiles: [
        {
          id: 1,
          probability: 0.5,
          vendorTileExtension: { keep: [1, "x"] },
        },
        { id: 3, type: "Rock" },
      ],
      vendorTilesetExtension: { keep: true },
    });
    const before = await readTileset(harness.root);
    const updates: TileMetadataUpdate[] = [
      {
        tileId: 1,
        patch: {
          probability: 0.25,
          className: "Grass",
          animation: [
            { tileId: 1, durationMs: 200 },
            { tileId: 2, durationMs: 300 },
          ],
        },
      },
    ];

    const plan = await plan_(harness, updates);
    expect(plan.summary).toMatchObject({
      updateCount: 1,
      tilesMemberAction: "keep",
      wouldChange: true,
      tileUpdates: [
        {
          updateIndex: 0,
          tileId: 1,
          entryAction: "update",
          requestedFields: [
            "probability",
            "className",
            "animation",
          ],
          changedFields: [
            "probability",
            "className",
            "animation",
          ],
          wouldChange: true,
          previousAnimationFrameCount: 0,
          newAnimationFrameCount: 2,
        },
      ],
    });

    const preview = new ChangeSetRegistry().put(plan);
    expect(preview).toMatchObject({
      kind: "tilesetEdit",
      tilesetPath: TILESET_PATH,
      expectedRevision: plan.baseRevision,
      operations: [
        {
          type: "updateTile",
          destructive: false,
          tileId: 1,
          entryAction: "update",
          wouldChange: true,
        },
      ],
    });

    const tampered = structuredClone(plan);
    tampered.summary.tileUpdates[0]!.changedFields =
      ["probability"];
    expect(() =>
      new ChangeSetRegistry().put(tampered),
    ).toThrow(/digest/u);

    const result =
      await harness.service.applyTilesetEdit(plan);
    expect(result.changed).toBe(true);
    expect(result.path).toBe(TILESET_PATH);

    const written = await readTileset(harness.root);
    const entry = (
      written.tiles as JsonObject[]
    ).find((tile) => tile.id === 1);
    expect(entry).toMatchObject({
      id: 1,
      probability: 0.25,
      type: "Grass",
      vendorTileExtension: { keep: [1, "x"] },
      animation: [
        { tileid: 1, duration: 200 },
        { tileid: 2, duration: 300 },
      ],
    });
    expect(entry).not.toHaveProperty("class");
    expect(
      (written.tiles as JsonObject[]).find(
        (tile) => tile.id === 3,
      ),
    ).toMatchObject({ type: "Rock" });
    expect(written.vendorTilesetExtension).toEqual({
      keep: true,
    });
    expect(written.tiledversion).toBe(
      before.tiledversion,
    );
    // The map itself is never touched by a tileset edit.
    const mapText = await readFile(
      join(harness.root, MAP_PATH),
      "utf8",
    );
    expect(JSON.parse(mapText).nextlayerid).toBe(8);
  });

  it("inserts a missing entry in ascending id order and keeps that update exclusive", async () => {
    const harness = await createHarness(roots, {
      tiles: [
        { id: 0, type: "A" },
        { id: 3, type: "B" },
      ],
    });
    const plan = await plan_(harness, [
      {
        tileId: 2,
        patch: { className: "Sand" },
      },
    ]);
    expect(plan.summary.tileUpdates[0]).toMatchObject({
      entryAction: "insert",
      wouldChange: true,
    });
    await harness.service.applyTilesetEdit(plan);
    const written = await readTileset(harness.root);
    expect(
      (written.tiles as JsonObject[]).map(
        (tile) => tile.id,
      ),
    ).toEqual([0, 2, 3]);
    expect(
      (written.tiles as JsonObject[])[1],
    ).toMatchObject({ id: 2, type: "Sand" });

    await expect(
      plan_(harness, [
        { tileId: 1, patch: { className: "X" } },
        { tileId: 0, patch: { className: "Y" } },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining(
        "must be the only update",
      ),
    });
  });

  it("removes an entry reduced to its id and prunes an empty tiles member", async () => {
    const pruneEntry = await createHarness(roots, {
      tiles: [
        { id: 1, probability: 0.5 },
        { id: 2, type: "Keep" },
      ],
    });
    const removeOne = await plan_(pruneEntry, [
      { tileId: 1, patch: { probability: null } },
    ]);
    expect(
      removeOne.summary.tileUpdates[0],
    ).toMatchObject({ entryAction: "remove" });
    expect(removeOne.summary.tilesMemberAction).toBe(
      "keep",
    );
    await pruneEntry.service.applyTilesetEdit(
      removeOne,
    );
    const written = await readTileset(pruneEntry.root);
    expect(
      (written.tiles as JsonObject[]).map(
        (tile) => tile.id,
      ),
    ).toEqual([2]);

    const pruneMember = await createHarness(roots, {
      tiles: [{ id: 1, probability: 0.5 }],
    });
    const removeLast = await plan_(pruneMember, [
      { tileId: 1, patch: { probability: 1 } },
    ]);
    expect(removeLast.summary.tilesMemberAction).toBe(
      "remove",
    );
    await pruneMember.service.applyTilesetEdit(
      removeLast,
    );
    const prunedText = await readFile(
      join(pruneMember.root, TILESET_PATH),
      "utf8",
    );
    expect(prunedText).not.toContain('"tiles"');
  });

  it("creates the tiles member when it is absent", async () => {
    const harness = await createHarness(roots, {});
    const plan = await plan_(harness, [
      { tileId: 0, patch: { probability: 0.75 } },
    ]);
    expect(plan.summary.tilesMemberAction).toBe(
      "insert",
    );
    await harness.service.applyTilesetEdit(plan);
    const written = await readTileset(harness.root);
    expect(written.tiles).toEqual([
      { id: 0, probability: 0.75 },
    ]);
  });

  it("treats default probability as a no-op that preserves exact bytes", async () => {
    const harness = await createHarness(roots, {
      tiles: [{ id: 1, type: "Grass" }],
    });
    const before = await readFile(
      join(harness.root, TILESET_PATH),
    );
    const plan = await plan_(harness, [
      { tileId: 1, patch: { probability: 1 } },
    ]);
    expect(plan.summary).toMatchObject({
      wouldChange: false,
      tilesMemberAction: "none",
      tileUpdates: [
        {
          entryAction: "update",
          changedFields: [],
          wouldChange: false,
        },
      ],
    });
    const result =
      await harness.service.applyTilesetEdit(plan);
    expect(result.changed).toBe(false);
    expect(
      await readFile(
        join(harness.root, TILESET_PATH),
      ),
    ).toEqual(before);
  });

  it("updates an existing class member and fails closed on ambiguity", async () => {
    const legacy = await createHarness(roots, {
      tiles: [{ class: "Old", id: 1 }],
    });
    const plan = await plan_(legacy, [
      { tileId: 1, patch: { className: "New" } },
    ]);
    await legacy.service.applyTilesetEdit(plan);
    const written = await readTileset(legacy.root);
    expect(
      (written.tiles as JsonObject[])[0],
    ).toMatchObject({ class: "New" });
    expect(
      (written.tiles as JsonObject[])[0],
    ).not.toHaveProperty("type");

    const ambiguous = await createHarness(roots, {
      tiles: [{ class: "A", id: 1, type: "B" }],
    });
    await expect(
      plan_(ambiguous, [
        { tileId: 1, patch: { className: "C" } },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
  });

  it.each([
    {
      name: "out-of-range tile id",
      updates: [
        { tileId: 4, patch: { probability: 0.5 } },
      ],
      code: "TILE_ID_OUT_OF_RANGE",
    },
    {
      name: "out-of-range animation frame",
      updates: [
        {
          tileId: 0,
          patch: {
            animation: [
              { tileId: 4, durationMs: 100 },
            ],
          },
        },
      ],
      code: "TILE_ID_OUT_OF_RANGE",
    },
    {
      name: "duplicate tile ids",
      updates: [
        { tileId: 0, patch: { probability: 0.5 } },
        { tileId: 0, patch: { className: "X" } },
      ],
      code: "INVALID_ARGUMENT",
    },
    {
      name: "empty patch",
      updates: [{ tileId: 0, patch: {} }],
      code: "INVALID_ARGUMENT",
    },
    {
      name: "negative probability",
      updates: [
        { tileId: 0, patch: { probability: -1 } },
      ],
      code: "INVALID_ARGUMENT",
    },
    {
      name: "empty class name",
      updates: [
        { tileId: 0, patch: { className: "" } },
      ],
      code: "INVALID_ARGUMENT",
    },
    {
      name: "zero-duration frame",
      updates: [
        {
          tileId: 0,
          patch: {
            animation: [
              { tileId: 0, durationMs: 0 },
            ],
          },
        },
      ],
      code: "INVALID_ARGUMENT",
    },
  ])(
    "fails closed on a $name",
    async ({ updates, code }) => {
      const harness = await createHarness(roots, {});
      await expect(
        plan_(
          harness,
          updates as TileMetadataUpdate[],
        ),
      ).rejects.toMatchObject({ code });
    },
  );

  it("fails closed when inserting into unsorted tiles", async () => {
    const harness = await createHarness(roots, {
      tiles: [
        { id: 3, type: "B" },
        { id: 0, type: "A" },
      ],
    });
    await expect(
      plan_(harness, [
        { tileId: 1, patch: { className: "X" } },
      ]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_TILESET",
    });
    // Editing an existing entry of the unsorted file still works.
    const plan = await plan_(harness, [
      { tileId: 0, patch: { className: "A2" } },
    ]);
    await harness.service.applyTilesetEdit(plan);
    const written = await readTileset(harness.root);
    expect(
      (written.tiles as JsonObject[]).map(
        (tile) => tile.id,
      ),
    ).toEqual([3, 0]);
  });

  it("pins the map, the tileset and the plan digest", async () => {
    const harness = await createHarness(roots, {});
    const snapshot = await snapshotOf(harness);

    await expect(
      harness.service.planUpdateTile({
        mapPath: MAP_PATH,
        tilesetAssetId: snapshot.assetId,
        expectedMapRevision: snapshot.mapRevision,
        expectedTilesetRevision:
          `sha256:${"9".repeat(64)}`,
        updates: [
          { tileId: 0, patch: { className: "X" } },
        ],
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
    });
    await expect(
      harness.service.planUpdateTile({
        mapPath: MAP_PATH,
        tilesetAssetId: "asset_" + "0".repeat(24),
        expectedMapRevision: snapshot.mapRevision,
        expectedTilesetRevision:
          snapshot.tilesetRevision,
        updates: [
          { tileId: 0, patch: { className: "X" } },
        ],
      }),
    ).rejects.toMatchObject({
      code: "TILESET_NOT_FOUND",
    });

    const plan = await plan_(harness, [
      { tileId: 0, patch: { className: "X" } },
    ]);
    const tampered = structuredClone(plan);
    tampered.updates[0]!.patch.className = "Evil";
    await expect(
      harness.service.applyTilesetEdit(tampered),
    ).rejects.toMatchObject({
      code: "CHANGE_SET_TAMPERED",
    });

    const conflicting = await plan_(harness, [
      { tileId: 0, patch: { className: "Y" } },
    ]);
    await harness.service.applyTilesetEdit(plan);
    await expect(
      harness.service.applyTilesetEdit(conflicting),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
    });
  });

  it("survives a real Tiled 1.12 tileset export round-trip when the CLI is available", async () => {
    const harness = await createHarness(roots, {});
    const plan = await plan_(harness, [
      {
        tileId: 2,
        patch: {
          probability: 0.25,
          className: "Grass",
          animation: [
            { tileId: 2, durationMs: 150 },
            { tileId: 3, durationMs: 250 },
          ],
        },
      },
    ]);
    await harness.service.applyTilesetEdit(plan);

    const exported = join(
      harness.root,
      "tiles",
      "exported.tsj",
    );
    try {
      await execFileAsync(
        process.env.TILED_CLI_PATH ?? "tiled",
        [
          "--export-tileset",
          "json",
          join(harness.root, TILESET_PATH),
          exported,
        ],
        {
          env: {
            ...process.env,
            LANG: "C",
            LC_ALL: "C",
            QT_QPA_PLATFORM: "offscreen",
          },
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code ===
        "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    const roundTripped = JSON.parse(
      await readFile(exported, "utf8"),
    ) as JsonObject;
    const entry = (
      roundTripped.tiles as JsonObject[]
    ).find((tile) => tile.id === 2);
    expect(entry).toMatchObject({
      probability: 0.25,
      type: "Grass",
      animation: [
        { tileid: 2, duration: 150 },
        { tileid: 3, duration: 250 },
      ],
    });
  }, 40_000);
});

async function createHarness(
  roots: Set<string>,
  tilesetExtra: JsonObject,
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-update-tile-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeJson(join(root, MAP_PATH), baseMap());
  await writeJson(join(root, TILESET_PATH), {
    ...baseTileset(),
    ...tilesetExtra,
  });
  await writeFile(
    join(root, "tiles", "terrain.svg"),
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">',
      '<rect width="32" height="32" fill="#55aa55"/>',
      "</svg>",
    ].join(""),
    "utf8",
  );
  const resolver =
    await ProjectPathResolver.create(root);
  return {
    root,
    service: new MapService(
      resolver,
      new DocumentStore(resolver),
    ),
  };
}

function baseMap(): JsonObject {
  return {
    compressionlevel: -1,
    height: 1,
    infinite: false,
    layers: [
      {
        data: [1, 0],
        height: 1,
        id: 7,
        name: "Ground",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 2,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 8,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [
      { firstgid: 1, source: "../tiles/terrain.tsj" },
    ],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 2,
  };
}

function baseTileset(): JsonObject {
  return {
    columns: 2,
    image: "terrain.svg",
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
  };
}

async function snapshotOf(
  harness: Harness,
): Promise<Snapshot> {
  const summary =
    await harness.service.getSummary(MAP_PATH);
  const tileset = (
    summary.tilesets as Array<{ assetId: string }>
  )[0];
  if (tileset === undefined) {
    throw new Error("Expected the fixture tileset.");
  }
  const dependencies =
    summary.dependencyRevisions as Record<
      string,
      string
    >;
  const tilesetRevision =
    dependencies[tileset.assetId];
  if (tilesetRevision === undefined) {
    throw new Error(
      "Expected the fixture tileset revision.",
    );
  }
  return {
    mapRevision: summary.revision as string,
    tilesetRevision,
    assetId: tileset.assetId,
  };
}

async function plan_(
  harness: Harness,
  updates: TileMetadataUpdate[],
): Promise<TilesetEditPlan> {
  const snapshot = await snapshotOf(harness);
  return harness.service.planUpdateTile({
    mapPath: MAP_PATH,
    tilesetAssetId: snapshot.assetId,
    expectedMapRevision: snapshot.mapRevision,
    expectedTilesetRevision:
      snapshot.tilesetRevision,
    updates,
  });
}

async function readTileset(
  root: string,
): Promise<JsonObject> {
  return JSON.parse(
    await readFile(
      join(root, TILESET_PATH),
      "utf8",
    ),
  ) as JsonObject;
}

async function writeJson(
  path: string,
  document: JsonObject,
): Promise<void> {
  await writeFile(
    path,
    serializeJsonDocument(document),
  );
}
