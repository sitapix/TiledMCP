import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findNodeAtLocation,
  parseTree,
  type JSONPath,
} from "jsonc-parser";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChangeSetRegistry } from "../src/changeSets.js";
import {
  isJsonObject,
  serializeJsonDocument,
  type JsonObject,
  type JsonValue,
} from "../src/formats/json.js";
import {
  GID_DIAGONAL_OR_HEX_60,
  GID_FLIP_HORIZONTAL,
} from "../src/maps/gid.js";
import { MapService } from "../src/maps/mapService.js";
import type { TileFindQuery } from "../src/maps/tileSearch.js";
import { MAX_TILESET_DETAIL_RESULT_BYTES } from "../src/maps/tilesetDetails.js";
import type {
  MapEditOperation,
  MapEditPlan,
  TileRef,
} from "../src/maps/types.js";
import {
  ASSET_REGISTRY_RELATIVE_PATH,
} from "../src/project/assetRegistry.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  DocumentStore,
  type DocumentSnapshot,
} from "../src/storage/documentStore.js";
import { revisionOf } from "../src/storage/revision.js";

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
const LAYER_ID = 7;
const OBJECT_LAYER_ID = 8;
const FLAGGED_LOCAL_ID_TWO =
  (GID_FLIP_HORIZONTAL | GID_DIAGONAL_OR_HEX_60 | 3) >>> 0;

interface Harness {
  root: string;
  service: MapService;
  store: DocumentStore;
}

interface SummaryTileset {
  assetId: string;
  path: string;
  name: string;
  firstGid: number;
  tileCount: number;
  revision: string;
}

describe("MapService", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await rm(harness.root, { recursive: true, force: true });
  });

  it("summarizes the map and exposes a stable project-scoped tileset assetId", async () => {
    const first = await harness.service.getSummary(MAP_PATH);
    const second = await harness.service.getSummary(MAP_PATH);
    const tilesets = first.tilesets as SummaryTileset[];

    expect(first).toMatchObject({
      path: MAP_PATH,
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      format: "tmj",
      orientation: "orthogonal",
      infinite: false,
      width: 4,
      height: 3,
      tileWidth: 16,
      tileHeight: 16,
      editableProfile: "finite-orthogonal-tmj-external-atlas-tsj",
      layers: [
        {
          id: LAYER_ID,
          name: "Ground",
          type: "tilelayer",
          width: 4,
          height: 3,
        },
        {
          id: OBJECT_LAYER_ID,
          name: "Gameplay Objects",
          type: "objectgroup",
        },
      ],
    });
    expect(tilesets).toHaveLength(1);
    expect(tilesets[0]).toMatchObject({
      assetId: expect.stringMatching(/^asset_[0-9a-f]{24}$/),
      path: TILESET_PATH,
      name: "Terrain",
      firstGid: 1,
      tileCount: 4,
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect((second.tilesets as SummaryTileset[])[0]?.assetId).toBe(
      tilesets[0]?.assetId,
    );
  });

  it("keeps a tileset assetId across a filesystem rename and service restart", async () => {
    const before = await harness.service.getSummary(
      MAP_PATH,
    );
    const beforeTileset = (
      before.tilesets as SummaryTileset[]
    )[0];
    expect(beforeTileset).toBeDefined();
    const oldPlan =
      await harness.service.planEdits(
        MAP_PATH,
        before.revision as string,
        before.dependencyRevisions as Record<
          string,
          string
        >,
        [
          {
            type: "setTiles",
            layerId: LAYER_ID,
            cells: [
              {
                x: 0,
                y: 0,
                tile: {
                  tileset: {
                    kind: "external",
                    assetId:
                      beforeTileset?.assetId ?? "",
                  },
                  localId: 1,
                },
              },
            ],
          },
        ],
      );

    await persistAssetIdentities(
      harness.service,
      before,
    );

    const renamedPath = "tiles/ground.tsj";
    await rename(
      join(harness.root, TILESET_PATH),
      join(harness.root, renamedPath),
    );
    const renamedMap = baseMap();
    renamedMap.tilesets = [
      {
        firstgid: 1,
        source: "../tiles/ground.tsj",
      },
    ];
    await writeJson(
      join(harness.root, MAP_PATH),
      renamedMap,
    );

    const resolver =
      await ProjectPathResolver.create(harness.root);
    const restarted = new MapService(
      resolver,
      new DocumentStore(resolver),
    );
    await restarted.initializeAssetRegistry();
    const after = await restarted.getSummary(MAP_PATH);
    const afterTileset = (
      after.tilesets as SummaryTileset[]
    )[0];

    expect(afterTileset).toMatchObject({
      assetId: beforeTileset?.assetId,
      path: renamedPath,
    });
    await expect(
      restarted.getTileset({
        mapPath: MAP_PATH,
        tilesetAssetId:
          beforeTileset?.assetId ?? "",
        startTileId: 0,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      source: {
        assetId: beforeTileset?.assetId,
      },
      tileset: { path: renamedPath },
    });
    await expect(
      restarted.applyEdits(oldPlan),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
  });

  it("never combines one TSJ snapshot with another file identity when the path is replaced", async () => {
    const before =
      await harness.service.getSummary(MAP_PATH);
    const beforeTileset = (
      before.tilesets as SummaryTileset[]
    )[0];
    expect(beforeTileset).toBeDefined();
    await persistAssetIdentities(
      harness.service,
      before,
    );

    const originalPath =
      "tiles/original-after-snapshot.tsj";
    const replacement = baseTileset();
    replacement.name = "Replacement";
    let replacements = 0;
    const racedService =
      await createServiceWithReadHook(
        harness.root,
        async ({ path, readCount }) => {
          if (
            path === TILESET_PATH &&
            readCount === 1
          ) {
            replacements += 1;
            await rename(
              join(harness.root, TILESET_PATH),
              join(harness.root, originalPath),
            );
            await writeFile(
              join(harness.root, TILESET_PATH),
              serializeJsonDocument(replacement),
            );
          }
        },
      );

    await expect(
      racedService.getSummary(MAP_PATH),
    ).rejects.toMatchObject({
      code: "DOCUMENT_CHANGED_DURING_READ",
      details: {
        path: TILESET_PATH,
      },
    });
    expect(replacements).toBe(1);

    const registryBeforeRetry = JSON.parse(
      await readFile(
        join(
          harness.root,
          ASSET_REGISTRY_RELATIVE_PATH,
        ),
        "utf8",
      ),
    ) as {
      entries: Array<{
        assetId: string;
        path: string;
        identity: { inode: string };
      }>;
    };
    const originalStat = await stat(
      join(harness.root, originalPath),
      { bigint: true },
    );
    expect(registryBeforeRetry.entries).toEqual([
      expect.objectContaining({
        assetId: beforeTileset?.assetId,
        path: TILESET_PATH,
        identity: expect.objectContaining({
          inode: originalStat.ino.toString(),
        }),
      }),
    ]);

    const resolver =
      await ProjectPathResolver.create(harness.root);
    const retried = new MapService(
      resolver,
      new DocumentStore(resolver),
    );
    const after = await retried.getSummary(MAP_PATH);
    expect(
      (after.tilesets as SummaryTileset[])[0],
    ).toMatchObject({
      assetId: beforeTileset?.assetId,
      path: TILESET_PATH,
      name: "Replacement",
    });
    const replacementStat = await stat(
      join(harness.root, TILESET_PATH),
      { bigint: true },
    );
    // The successful retry is a read and must not refresh the persisted
    // identity; only the following write-path apply does.
    const registryAfterRead = JSON.parse(
      await readFile(
        join(
          harness.root,
          ASSET_REGISTRY_RELATIVE_PATH,
        ),
        "utf8",
      ),
    ) as {
      entries: Array<{
        identity: { inode: string };
      }>;
    };
    expect(
      registryAfterRead.entries[0]?.identity.inode,
    ).toBe(originalStat.ino.toString());
    await persistAssetIdentities(retried, after);
    const registryAfterWrite = JSON.parse(
      await readFile(
        join(
          harness.root,
          ASSET_REGISTRY_RELATIVE_PATH,
        ),
        "utf8",
      ),
    ) as {
      entries: Array<{
        identity: { inode: string };
      }>;
    };
    expect(
      registryAfterWrite.entries[0]?.identity.inode,
    ).toBe(replacementStat.ino.toString());
  });

  it("rejects an exact duplicate tileset path before reading it twice or updating the registry", async () => {
    const map = baseMap();
    map.tilesets = [
      {
        firstgid: 1,
        source: "../tiles/terrain.tsj",
      },
      {
        firstgid: 10,
        source: "../tiles/terrain.tsj",
      },
    ];
    await writeJson(
      join(harness.root, MAP_PATH),
      map,
    );
    let tilesetReads = 0;
    const service =
      await createServiceWithReadHook(
        harness.root,
        ({ path }) => {
          if (path === TILESET_PATH) {
            tilesetReads += 1;
          }
        },
      );

    await expect(
      service.getSummary(MAP_PATH),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      details: {
        path: TILESET_PATH,
      },
    });
    expect(tilesetReads).toBe(1);
    await expect(
      readFile(
        join(
          harness.root,
          ASSET_REGISTRY_RELATIVE_PATH,
        ),
      ),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not persist candidate identities after an unguarded TSJ validation failure", async () => {
    const otherPath = "tiles/other.tsj";
    const other = baseTileset();
    other.name = "Other";
    await writeJson(
      join(harness.root, otherPath),
      other,
    );
    const map = baseMap();
    map.tilesets = [
      {
        firstgid: 1,
        source: "../tiles/terrain.tsj",
      },
      {
        firstgid: 10,
        source: "../tiles/other.tsj",
      },
    ];
    await writeJson(
      join(harness.root, MAP_PATH),
      map,
    );
    await writeFile(
      join(harness.root, TILESET_PATH),
      '{"type":',
      "utf8",
    );
    const reads = new Map<string, number>();
    const service =
      await createServiceWithReadHook(
        harness.root,
        ({ path }) => {
          reads.set(
            path,
            (reads.get(path) ?? 0) + 1,
          );
        },
      );

    await expect(
      service.getSummary(MAP_PATH),
    ).rejects.toMatchObject({
      code: "INVALID_JSON",
    });
    expect(reads.get(TILESET_PATH)).toBe(1);
    expect(reads.get(otherPath)).toBeUndefined();
    await expect(
      readFile(
        join(
          harness.root,
          ASSET_REGISTRY_RELATIVE_PATH,
        ),
      ),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("checks every dependency revision before surfacing a different dependency profile error", async () => {
    const otherPath = "tiles/other.tsj";
    const other = baseTileset();
    other.name = "Other";
    await writeJson(
      join(harness.root, otherPath),
      other,
    );
    const map = baseMap();
    map.tilesets = [
      {
        firstgid: 1,
        source: "../tiles/terrain.tsj",
      },
      {
        firstgid: 10,
        source: "../tiles/other.tsj",
      },
    ];
    await writeJson(
      join(harness.root, MAP_PATH),
      map,
    );
    const before =
      await harness.service.getSummary(MAP_PATH);
    const otherBinding = (
      before.tilesets as SummaryTileset[]
    ).find(({ path }) => path === otherPath);
    expect(otherBinding).toBeDefined();
    await expect(
      readFile(
        join(
          harness.root,
          ASSET_REGISTRY_RELATIVE_PATH,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await rm(
      join(
        harness.root,
        "tiles",
        "terrain.png",
      ),
    );
    other.vendorExtension = {
      changedAfterSnapshot: true,
    };
    const replacementPath = join(
      harness.root,
      "tiles",
      ".other-replacement.tmp",
    );
    await writeJson(
      replacementPath,
      other,
    );
    await rename(
      replacementPath,
      join(harness.root, otherPath),
    );

    await expect(
      harness.service.planEdits(
        MAP_PATH,
        before.revision as string,
        before.dependencyRevisions as Record<
          string,
          string
        >,
        [
          {
            type: "setTiles",
            layerId: LAYER_ID,
            cells: [
              {
                x: 0,
                y: 0,
                tile: null,
              },
            ],
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        assetId: otherBinding?.assetId,
        expectedRevision:
          otherBinding?.revision,
        actualRevision:
          expect.stringMatching(/^sha256:/),
      },
    });
    await expect(
      readFile(
        join(
          harness.root,
          ASSET_REGISTRY_RELATIVE_PATH,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports the aggregate dependency limit before diffing an unread suffix", async () => {
    const otherPath = "tiles/other.tsj";
    const finalPath = "tiles/final.tsj";
    const other = baseTileset();
    other.name = "Other";
    const final = baseTileset();
    final.name = "Final";
    await writeJson(
      join(harness.root, otherPath),
      other,
    );
    await writeJson(
      join(harness.root, finalPath),
      final,
    );
    const map = baseMap();
    map.tilesets = [
      {
        firstgid: 1,
        source: "../tiles/terrain.tsj",
      },
      {
        firstgid: 10,
        source: "../tiles/other.tsj",
      },
      {
        firstgid: 20,
        source: "../tiles/final.tsj",
      },
    ];
    await writeJson(
      join(harness.root, MAP_PATH),
      map,
    );
    const before =
      await harness.service.getSummary(MAP_PATH);
    await expect(
      readFile(
        join(
          harness.root,
          ASSET_REGISTRY_RELATIVE_PATH,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const resolver =
      await ProjectPathResolver.create(
        harness.root,
      );
    const inflatedStore =
      new InflatedDependencySizeStore(
        resolver,
      );
    const service = new MapService(
      resolver,
      inflatedStore,
    );

    await expect(
      service.planEdits(
        MAP_PATH,
        before.revision as string,
        before.dependencyRevisions as Record<
          string,
          string
        >,
        [
          {
            type: "setTiles",
            layerId: LAYER_ID,
            cells: [
              {
                x: 0,
                y: 0,
                tile: null,
              },
            ],
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        limit: 64 * 1024 * 1024,
        actual: 68 * 1024 * 1024,
      },
    });
    expect(
      inflatedStore.readPaths.filter(
        (path) => path.endsWith(".tsj"),
      ),
    ).toEqual([
      TILESET_PATH,
      otherPath,
    ]);
    await expect(
      readFile(
        join(
          harness.root,
          ASSET_REGISTRY_RELATIVE_PATH,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a captured stale dependency before the aggregate dependency limit", async () => {
    const otherPath = "tiles/other.tsj";
    const other = baseTileset();
    other.name = "Other";
    await writeJson(
      join(harness.root, otherPath),
      other,
    );
    const map = baseMap();
    map.tilesets = [
      {
        firstgid: 1,
        source: "../tiles/terrain.tsj",
      },
      {
        firstgid: 10,
        source: "../tiles/other.tsj",
      },
    ];
    await writeJson(
      join(harness.root, MAP_PATH),
      map,
    );
    const before =
      await harness.service.getSummary(MAP_PATH);
    const otherBinding = (
      before.tilesets as SummaryTileset[]
    ).find(({ path }) => path === otherPath);
    expect(otherBinding).toBeDefined();
    await expect(
      readFile(
        join(
          harness.root,
          ASSET_REGISTRY_RELATIVE_PATH,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    other.vendorExtension = {
      changedAfterSnapshot: true,
    };
    const replacementPath = join(
      harness.root,
      "tiles",
      ".other-limit-replacement.tmp",
    );
    await writeJson(
      replacementPath,
      other,
    );
    await rename(
      replacementPath,
      join(harness.root, otherPath),
    );
    const resolver =
      await ProjectPathResolver.create(
        harness.root,
      );
    const service = new MapService(
      resolver,
      new InflatedDependencySizeStore(
        resolver,
      ),
    );

    await expect(
      service.planEdits(
        MAP_PATH,
        before.revision as string,
        before.dependencyRevisions as Record<
          string,
          string
        >,
        [
          {
            type: "setTiles",
            layerId: LAYER_ID,
            cells: [
              {
                x: 0,
                y: 0,
                tile: null,
              },
            ],
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        assetId: otherBinding?.assetId,
        expectedRevision:
          otherBinding?.revision,
        actualRevision:
          expect.stringMatching(/^sha256:/),
      },
    });
    await expect(
      readFile(
        join(
          harness.root,
          ASSET_REGISTRY_RELATIVE_PATH,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back identity allocation when validated tileset GID ranges overlap", async () => {
    const otherPath = "tiles/other.tsj";
    const other = baseTileset();
    other.name = "Other";
    await writeJson(
      join(harness.root, otherPath),
      other,
    );
    const map = baseMap();
    map.tilesets = [
      {
        firstgid: 1,
        source: "../tiles/terrain.tsj",
      },
      {
        firstgid: 3,
        source: "../tiles/other.tsj",
      },
    ];
    await writeJson(
      join(harness.root, MAP_PATH),
      map,
    );

    await expect(
      harness.service.getSummary(MAP_PATH),
    ).rejects.toMatchObject({
      code: "TILESET_GID_RANGE_OVERLAP",
    });
    await expect(
      readFile(
        join(
          harness.root,
          ASSET_REGISTRY_RELATIVE_PATH,
        ),
      ),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("returns bounded sparse tileset metadata ordered by local ID", async () => {
    const tileset = baseTileset();
    tileset.name = `${"🧩".repeat(128)}extra`;
    tileset.class = `${"🌲".repeat(128)}extra`;
    tileset.properties = [
      { name: "rootZero", type: "int", value: 0 },
      { name: "rootFalse", type: "bool", value: false },
    ];
    tileset.tiles = [
      {
        id: 3,
        type: "CurrentAnimated",
        class: "CompatibilityClassIgnoredBecauseTypeWins",
        probability: 0,
        properties: [{ name: "empty", type: "string", value: "" }],
        animation: Array.from({ length: 18 }, (_, index) => ({
          tileid: index % 4,
          duration: index + 1,
        })),
        objectgroup: {
          type: "objectgroup",
          objects: [{ id: 1 }, { id: 2 }],
        },
        vendorTileExtension: { ignored: true },
      },
      {
        id: 1,
        class: "CompatibilityFallback",
        properties: [{ name: "nil", type: "string", value: null }],
      },
    ];
    tileset.wangsets = [
      {
        name: "Ground",
        type: "mixed",
        class: "TerrainRules",
        colors: [{ name: "Grass" }, { name: "Dirt" }],
        wangtiles: [{ tileid: 1, wangid: [1, 0, 2, 0, 1, 0, 2, 0] }],
        properties: [{ name: "weight", type: "float", value: 0 }],
      },
    ];
    const source = serializeJsonDocument(tileset);
    await writeFile(join(harness.root, TILESET_PATH), source);
    const assetId = await getAssetId(harness.service);

    const first = await harness.service.getTileset({
      mapPath: MAP_PATH,
      tilesetAssetId: assetId,
      startTileId: 0,
      limit: 1,
    });
    expect(first).toMatchObject({
      projection: {
        kind: "bounded-semantic-summary",
        classResolution: "name-only",
        tileClassField: "type-with-class-compatibility-fallback",
        properties: "counts-only",
        collision: "object-counts-only",
        wangSets: "overview-only",
        sourceImage: "declared-metadata-only",
      },
      map: {
        path: MAP_PATH,
        revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
      source: {
        assetId,
        revision: revisionOf(source),
      },
      binding: { firstGid: 1, lastGid: 4 },
      tileset: {
        path: TILESET_PATH,
        name: "🧩".repeat(128),
        nameTruncated: true,
        className: "🌲".repeat(128),
        classNameTruncated: true,
        tileSize: { width: 16, height: 16 },
        tileCount: 4,
        atlas: { columns: 2, rows: 2, margin: 0, spacing: 0 },
        image: {
          path: "tiles/terrain.png",
          declaredPixelSize: { width: 32, height: 32 },
        },
        propertyCount: 2,
        featureCounts: {
          metadataTiles: 2,
          animatedTiles: 1,
          animationFrames: 18,
          collisionTiles: 1,
          collisionObjects: 2,
          propertyTiles: 2,
          tileProperties: 2,
          wangSets: 1,
        },
      },
      tileMetadata: {
        order: "local-id",
        startTileId: 0,
        limit: 1,
        total: 2,
        returned: 1,
        hasEarlier: false,
        hasMore: true,
        truncated: true,
        nextStartTileId: 3,
        items: [
          {
            localId: 1,
            sourceIndex: 1,
            className: "CompatibilityFallback",
            classNameSource: "class",
            propertyCount: 1,
          },
        ],
      },
      wangSets: {
        total: 1,
        returned: 1,
        truncated: false,
        items: [
          {
            sourceIndex: 0,
            name: "Ground",
            type: "mixed",
            className: "TerrainRules",
            colorCount: 2,
            wangTileCount: 1,
            propertyCount: 1,
          },
        ],
      },
      snapshotConsistency: "non-atomic-read-set",
      truncated: true,
    });
    expect(
      Buffer.byteLength(JSON.stringify({ result: first }), "utf8"),
    ).toBeLessThanOrEqual(MAX_TILESET_DETAIL_RESULT_BYTES);

    const second = await harness.service.getTileset({
      mapPath: MAP_PATH,
      tilesetAssetId: assetId,
      startTileId: 3,
      limit: 1,
    });
    const secondTileMetadata = second.tileMetadata as {
      hasEarlier: boolean;
      hasMore: boolean;
      items: Array<{
        localId: number;
        sourceIndex: number;
        className: string;
        classNameSource: string;
        probability: number;
        propertyCount: number;
        collision: { objectCount: number };
        animation: {
          frameCount: number;
          totalDurationMs: number;
          frames: Array<{ tileId: number; durationMs: number }>;
          framesTruncated: boolean;
        };
      }>;
    };
    expect(secondTileMetadata).toMatchObject({
      hasEarlier: true,
      hasMore: false,
      items: [
        {
          localId: 3,
          sourceIndex: 0,
          className: "CurrentAnimated",
          classNameSource: "type",
          probability: 0,
          propertyCount: 1,
          collision: { objectCount: 2 },
          animation: {
            frameCount: 18,
            totalDurationMs: 171,
            framesTruncated: true,
          },
        },
      ],
    });
    expect(secondTileMetadata.items[0]?.animation.frames).toHaveLength(16);
    expect(secondTileMetadata.items[0]?.animation.frames[0]).toEqual({
      tileId: 0,
      durationMs: 1,
    });
    expect(await readFile(join(harness.root, TILESET_PATH))).toEqual(source);
  });

  it.each([
    {
      name: "duplicate tile metadata IDs",
      mutate: (tileset: JsonObject) => {
        tileset.tiles = [{ id: 1 }, { id: 1 }];
      },
      code: "INVALID_DOCUMENT",
    },
    {
      name: "an out-of-range animation frame",
      mutate: (tileset: JsonObject) => {
        tileset.tiles = [
          { id: 1, animation: [{ tileid: 4, duration: 100 }] },
        ];
      },
      code: "INVALID_DOCUMENT",
    },
    {
      name: "a per-tile image",
      mutate: (tileset: JsonObject) => {
        tileset.tiles = [{ id: 1, image: "individual.png" }];
      },
      code: "UNSUPPORTED_TILESET",
    },
    {
      name: "inconsistent atlas columns",
      mutate: (tileset: JsonObject) => {
        tileset.columns = 1;
      },
      code: "INVALID_TILESET_ATLAS",
    },
    {
      name: "a missing tileset name",
      mutate: (tileset: JsonObject) => {
        delete tileset.name;
      },
      code: "INVALID_DOCUMENT",
    },
  ])("rejects tileset details with $name", async ({ mutate, code }) => {
    const assetId = await getAssetId(harness.service);
    const tileset = baseTileset();
    mutate(tileset);
    await writeJson(join(harness.root, TILESET_PATH), tileset);

    await expect(
      harness.service.getTileset({
        mapPath: MAP_PATH,
        tilesetAssetId: assetId,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code,
    });
  });

  it("rejects tileset detail cursors outside the declared local ID range", async () => {
    const assetId = await getAssetId(harness.service);
    await expect(
      harness.service.getTileset({
        mapPath: MAP_PATH,
        tilesetAssetId: assetId,
        startTileId: 4,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
      details: { startTileId: 4, tileCount: 4 },
    });
  });

  it("rejects tileset details when the selected TSJ changes after its second read", async () => {
    const assetId = await getAssetId(harness.service);
    const mapBefore = await readFile(join(harness.root, MAP_PATH));
    const tilesetBefore = await readFile(join(harness.root, TILESET_PATH));
    const externallyChangedTileset = baseTileset();
    externallyChangedTileset.vendorTilesetExtension = {
      preserved: true,
      changedByExternalWriter: true,
    };
    const externallyChangedBytes =
      serializeJsonDocument(externallyChangedTileset);
    let injectedWrites = 0;
    const service = await createServiceWithReadHook(
      harness.root,
      async ({ path, readCount }) => {
        if (path === TILESET_PATH && readCount === 2) {
          injectedWrites += 1;
          await writeFile(
            join(harness.root, TILESET_PATH),
            externallyChangedBytes,
          );
        }
      },
    );

    await expect(
      service.getTileset({
        mapPath: MAP_PATH,
        tilesetAssetId: assetId,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        assetId,
        expectedRevision: revisionOf(tilesetBefore),
        actualRevision: revisionOf(externallyChangedBytes),
      },
    });
    expect(injectedWrites).toBe(1);
    expect(await readFile(join(harness.root, MAP_PATH))).toEqual(mapBefore);
    expect(await readFile(join(harness.root, TILESET_PATH))).toEqual(
      externallyChangedBytes,
    );
  });

  it("rejects tileset details when the map changes after its first read", async () => {
    const assetId = await getAssetId(harness.service);
    const mapBefore = await readFile(join(harness.root, MAP_PATH));
    const tilesetBefore = await readFile(join(harness.root, TILESET_PATH));
    const externallyChangedMap = baseMap();
    externallyChangedMap.vendorExtension = {
      preserve: true,
      changedByExternalWriter: true,
    };
    const externallyChangedBytes = serializeJsonDocument(externallyChangedMap);
    let injectedWrites = 0;
    const service = await createServiceWithReadHook(
      harness.root,
      async ({ path, readCount }) => {
        if (path === MAP_PATH && readCount === 1) {
          injectedWrites += 1;
          await writeFile(join(harness.root, MAP_PATH), externallyChangedBytes);
        }
      },
    );

    await expect(
      service.getTileset({
        mapPath: MAP_PATH,
        tilesetAssetId: assetId,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "REVISION_CONFLICT",
      details: {
        path: MAP_PATH,
        expectedRevision: revisionOf(mapBefore),
        actualRevision: revisionOf(externallyChangedBytes),
      },
    });
    expect(injectedWrites).toBe(1);
    expect(await readFile(join(harness.root, MAP_PATH))).toEqual(
      externallyChangedBytes,
    );
    expect(await readFile(join(harness.root, TILESET_PATH))).toEqual(
      tilesetBefore,
    );
  });

  it("finds exact tile semantics with all/any queries, stable ordering and revision-bound pagination", async () => {
    const tileset = baseTileset();
    tileset.tiles = [
      {
        id: 3,
        type: "Enemy",
        class: "CompatibilityClassIgnoredBecauseTypeWins",
        properties: [
          { name: "active", type: "bool", value: true },
          { name: "loot", type: "string", value: "gem" },
        ],
      },
      {
        id: 1,
        class: "Enemy",
        properties: [
          { name: "active", type: "bool", value: true },
        ],
      },
      {
        id: 2,
        type: "Enemy",
        properties: [
          { name: "active", type: "bool", value: false },
          { name: "loot", type: "string", value: "gem" },
        ],
      },
      {
        id: 0,
        type: "Ground",
        properties: [
          { name: "active", type: "bool", value: true },
        ],
      },
    ];
    const tilesetBytes = serializeJsonDocument(tileset);
    await writeFile(join(harness.root, TILESET_PATH), tilesetBytes);
    const mapBytes = await readFile(join(harness.root, MAP_PATH));
    const assetId = await getAssetId(harness.service);
    const allQuery: TileFindQuery = {
      mode: "all",
      clauses: [
        { kind: "class", equals: "Enemy" },
        {
          kind: "propertyEquals",
          name: "active",
          type: "bool",
          value: true,
        },
      ],
    };

    const first = await harness.service.findTiles({
      mapPath: MAP_PATH,
      tilesetAssetId: assetId,
      query: allQuery,
      startTileId: 0,
      limit: 1,
    });
    const mapRevision = revisionOf(mapBytes);
    const tilesetRevision = revisionOf(tilesetBytes);
    expect(first).toMatchObject({
      map: { path: MAP_PATH, revision: mapRevision },
      source: { assetId, revision: tilesetRevision },
      projection: {
        kind: "explicit-tile-semantics-search",
        classResolution: "name-only",
        tileClassField: "type-with-class-compatibility-fallback",
        comparison: "case-sensitive-exact",
      },
      query: allQuery,
      page: {
        order: "local-id",
        startTileId: 0,
        limit: 1,
        totalMatches: 2,
        returned: 1,
        hasEarlier: false,
        hasMore: true,
        nextStartTileId: 3,
        truncated: true,
      },
      items: [
        {
          tile: {
            tileset: { kind: "external", assetId },
            localId: 1,
          },
          sourceIndex: 1,
          matchedClauseIndexes: [0, 1],
          class: { name: "Enemy", source: "class" },
        },
      ],
      nextPage: {
        startTileId: 3,
        expectedMapRevision: mapRevision,
        expectedTilesetRevision: tilesetRevision,
      },
      snapshotConsistency: "non-atomic-read-set",
      truncated: true,
    });

    const nextPage = first.nextPage as
      | {
          startTileId: number;
          expectedMapRevision: string;
          expectedTilesetRevision: string;
        }
      | undefined;
    expect(nextPage).toBeDefined();
    if (nextPage === undefined) {
      throw new Error("Expected a revision-bound next tile-search page.");
    }
    const second = await harness.service.findTiles({
      mapPath: MAP_PATH,
      tilesetAssetId: assetId,
      query: allQuery,
      limit: 1,
      ...nextPage,
    });
    expect(second).toMatchObject({
      map: { path: MAP_PATH, revision: mapRevision },
      source: { assetId, revision: tilesetRevision },
      page: {
        order: "local-id",
        startTileId: 3,
        limit: 1,
        totalMatches: 2,
        returned: 1,
        hasEarlier: true,
        hasMore: false,
        truncated: true,
      },
      items: [
        {
          tile: {
            tileset: { kind: "external", assetId },
            localId: 3,
          },
          sourceIndex: 0,
          matchedClauseIndexes: [0, 1],
          class: { name: "Enemy", source: "type" },
        },
      ],
      snapshotConsistency: "non-atomic-read-set",
      truncated: true,
    });
    expect(second).not.toHaveProperty("nextPage");

    const any = await harness.service.findTiles({
      mapPath: MAP_PATH,
      tilesetAssetId: assetId,
      query: {
        mode: "any",
        clauses: [
          { kind: "class", equals: "enemy" },
          { kind: "propertyExists", name: "loot" },
        ],
      },
    });
    expect(any).toMatchObject({
      page: {
        order: "local-id",
        totalMatches: 2,
        returned: 2,
        hasEarlier: false,
        hasMore: false,
        truncated: false,
      },
      items: [
        {
          tile: {
            tileset: { kind: "external", assetId },
            localId: 2,
          },
          sourceIndex: 2,
          matchedClauseIndexes: [1],
          class: { name: "Enemy", source: "type" },
        },
        {
          tile: {
            tileset: { kind: "external", assetId },
            localId: 3,
          },
          sourceIndex: 0,
          matchedClauseIndexes: [1],
          class: { name: "Enemy", source: "type" },
        },
      ],
      truncated: false,
    });
  });

  it("prioritizes a stale map revision over the current unsupported profile", async () => {
    const assetId = await getAssetId(harness.service);
    const staleMapBytes = await readFile(join(harness.root, MAP_PATH));
    const changedMap = baseMap();
    changedMap.orientation = "isometric";
    const changedMapBytes = serializeJsonDocument(changedMap);
    await writeFile(join(harness.root, MAP_PATH), changedMapBytes);

    await expect(
      harness.service.findTiles({
        mapPath: MAP_PATH,
        tilesetAssetId: assetId,
        query: {
          mode: "all",
          clauses: [{ kind: "class", equals: "Enemy" }],
        },
        expectedMapRevision: revisionOf(staleMapBytes),
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "REVISION_CONFLICT",
      details: {
        path: MAP_PATH,
        expectedRevision: revisionOf(staleMapBytes),
        actualRevision: revisionOf(changedMapBytes),
      },
    });
    expect(await readFile(join(harness.root, MAP_PATH))).toEqual(
      changedMapBytes,
    );
  });

  it("prioritizes a stale tileset revision over current malformed JSON", async () => {
    const assetId = await getAssetId(harness.service);
    const staleTilesetBytes = await readFile(
      join(harness.root, TILESET_PATH),
    );
    const changedTilesetBytes = Buffer.from('{"type":', "utf8");
    await writeFile(join(harness.root, TILESET_PATH), changedTilesetBytes);

    await expect(
      harness.service.findTiles({
        mapPath: MAP_PATH,
        tilesetAssetId: assetId,
        query: {
          mode: "all",
          clauses: [{ kind: "class", equals: "Enemy" }],
        },
        expectedTilesetRevision: revisionOf(staleTilesetBytes),
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        assetId,
        expectedRevision: revisionOf(staleTilesetBytes),
        actualRevision: revisionOf(changedTilesetBytes),
      },
    });
    expect(await readFile(join(harness.root, TILESET_PATH))).toEqual(
      changedTilesetBytes,
    );
  });

  it("rejects a tile search when the selected TSJ changes after binding", async () => {
    const assetId = await getAssetId(harness.service);
    const mapBefore = await readFile(join(harness.root, MAP_PATH));
    const tilesetBefore = await readFile(join(harness.root, TILESET_PATH));
    const externallyChangedTileset = baseTileset();
    externallyChangedTileset.vendorTilesetExtension = {
      preserved: true,
      changedByExternalWriterDuringSearch: true,
    };
    const externallyChangedBytes =
      serializeJsonDocument(externallyChangedTileset);
    let injectedWrites = 0;
    const service = await createServiceWithReadHook(
      harness.root,
      async ({ path, readCount }) => {
        if (path === TILESET_PATH && readCount === 1) {
          injectedWrites += 1;
          await writeFile(
            join(harness.root, TILESET_PATH),
            externallyChangedBytes,
          );
        }
      },
    );

    await expect(
      service.findTiles({
        mapPath: MAP_PATH,
        tilesetAssetId: assetId,
        query: {
          mode: "all",
          clauses: [{ kind: "class", equals: "Enemy" }],
        },
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        assetId,
        expectedRevision: revisionOf(tilesetBefore),
        actualRevision: revisionOf(externallyChangedBytes),
      },
    });
    expect(injectedWrites).toBe(1);
    expect(await readFile(join(harness.root, MAP_PATH))).toEqual(mapBefore);
    expect(await readFile(join(harness.root, TILESET_PATH))).toEqual(
      externallyChangedBytes,
    );
  });

  it("rejects a tile search when an unselected tileset in the read set changes", async () => {
    const otherTilesetPath = "tiles/other.tsj";
    const otherImagePath = "tiles/other.png";
    const map = baseMap();
    map.tilesets = [
      { firstgid: 1, source: "../tiles/terrain.tsj" },
      { firstgid: 10, source: "../tiles/other.tsj" },
    ];
    const otherTileset = baseTileset();
    otherTileset.name = "Other";
    otherTileset.image = "other.png";
    const otherBefore = serializeJsonDocument(otherTileset);
    await writeJson(join(harness.root, MAP_PATH), map);
    await writeFile(join(harness.root, otherTilesetPath), otherBefore);
    await writeFile(
      join(harness.root, otherImagePath),
      Buffer.from("other placeholder image bytes", "utf8"),
    );

    const summary = await harness.service.getSummary(MAP_PATH);
    const bindings = summary.tilesets as SummaryTileset[];
    const selected = bindings.find(({ path }) => path === TILESET_PATH);
    const other = bindings.find(({ path }) => path === otherTilesetPath);
    expect(selected).toBeDefined();
    expect(other).toBeDefined();
    if (selected === undefined || other === undefined) {
      throw new Error("Expected both fixture tilesets to be bound.");
    }

    otherTileset.vendorTilesetExtension = {
      preserved: true,
      changedByExternalWriterDuringSearch: true,
    };
    const otherAfter = serializeJsonDocument(otherTileset);
    let injectedWrites = 0;
    const service = await createServiceWithReadHook(
      harness.root,
      async ({ path, readCount }) => {
        if (path === otherTilesetPath && readCount === 1) {
          injectedWrites += 1;
          await writeFile(
            join(harness.root, otherTilesetPath),
            otherAfter,
          );
        }
      },
    );

    await expect(
      service.findTiles({
        mapPath: MAP_PATH,
        tilesetAssetId: selected.assetId,
        query: {
          mode: "all",
          clauses: [{ kind: "class", equals: "Enemy" }],
        },
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        assetId: other.assetId,
        expectedRevision: revisionOf(otherBefore),
        actualRevision: revisionOf(otherAfter),
      },
    });
    expect(injectedWrites).toBe(1);
    expect(await readFile(join(harness.root, otherTilesetPath))).toEqual(
      otherAfter,
    );
  });

  it("rejects a tile search when the map changes after its first read", async () => {
    const assetId = await getAssetId(harness.service);
    const mapBefore = await readFile(join(harness.root, MAP_PATH));
    const tilesetBefore = await readFile(join(harness.root, TILESET_PATH));
    const externallyChangedMap = baseMap();
    externallyChangedMap.vendorExtension = {
      preserve: true,
      changedByExternalWriterDuringSearch: true,
    };
    const externallyChangedBytes =
      serializeJsonDocument(externallyChangedMap);
    let injectedWrites = 0;
    const service = await createServiceWithReadHook(
      harness.root,
      async ({ path, readCount }) => {
        if (path === MAP_PATH && readCount === 1) {
          injectedWrites += 1;
          await writeFile(
            join(harness.root, MAP_PATH),
            externallyChangedBytes,
          );
        }
      },
    );

    await expect(
      service.findTiles({
        mapPath: MAP_PATH,
        tilesetAssetId: assetId,
        query: {
          mode: "all",
          clauses: [{ kind: "class", equals: "Enemy" }],
        },
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "REVISION_CONFLICT",
      details: {
        path: MAP_PATH,
        expectedRevision: revisionOf(mapBefore),
        actualRevision: revisionOf(externallyChangedBytes),
      },
    });
    expect(injectedWrites).toBe(1);
    expect(await readFile(join(harness.root, MAP_PATH))).toEqual(
      externallyChangedBytes,
    );
    expect(await readFile(join(harness.root, TILESET_PATH))).toEqual(
      tilesetBefore,
    );
  });

  it("rejects a tile search for a tileset asset not referenced by the map", async () => {
    await expect(
      harness.service.findTiles({
        mapPath: MAP_PATH,
        tilesetAssetId: "asset_missing",
        query: {
          mode: "all",
          clauses: [{ kind: "class", equals: "Enemy" }],
        },
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "TILESET_NOT_FOUND",
      details: {
        mapPath: MAP_PATH,
        tilesetAssetId: "asset_missing",
      },
    });
  });

  it("renders a tileset sheet and revisions the source image independently from the TSJ", async () => {
    const imagePath = join(harness.root, "tiles", "terrain.png");
    await writeFile(imagePath, await terrainPng("#4f8f4f"));
    const summary = await harness.service.getSummary(MAP_PATH);
    const tileset = (summary.tilesets as SummaryTileset[])[0];
    expect(tileset).toBeDefined();

    const first = await harness.service.renderTilesetSheet({
      mapPath: MAP_PATH,
      tilesetAssetId: tileset?.assetId ?? "",
    });
    const firstResult = first.result as {
      sha256: string;
      source: { revision: string };
      map: { path: string; revision: string };
      image: { path: string; revision: string; format: string };
      page: { localIdRange: { first: number; last: number } };
    };
    expect(first.png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(firstResult).toMatchObject({
      sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      source: { revision: tileset?.revision },
      map: { path: MAP_PATH, revision: summary.revision },
      image: {
        path: "tiles/terrain.png",
        revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        format: "png",
      },
      page: { localIdRange: { first: 0, last: 3 } },
    });

    await writeFile(imagePath, await terrainPng("#ff0000"));
    const second = await harness.service.renderTilesetSheet({
      mapPath: MAP_PATH,
      tilesetAssetId: tileset?.assetId ?? "",
    });
    const secondResult = second.result as {
      sha256: string;
      source: { revision: string };
      image: { revision: string };
    };
    expect(secondResult.source.revision).toBe(firstResult.source.revision);
    expect(secondResult.image.revision).not.toBe(firstResult.image.revision);
    expect(secondResult.sha256).not.toBe(firstResult.sha256);
  });

  it("renders sparse local IDs in input order as static atlas cells and revisions changed image bytes", async () => {
    const tilesetDocument = baseTileset();
    tilesetDocument.tiles = [
      {
        id: 3,
        animation: [
          { tileid: 0, duration: 100 },
          { tileid: 1, duration: 100 },
        ],
      },
    ];
    await writeJson(
      join(harness.root, TILESET_PATH),
      tilesetDocument,
    );
    const imagePath = join(
      harness.root,
      "tiles",
      "terrain.png",
    );
    const firstImage = await terrainPng("#4f8f4f");
    await writeFile(imagePath, firstImage);
    const summary =
      await harness.service.getSummary(MAP_PATH);
    const tileset = (
      summary.tilesets as SummaryTileset[]
    )[0];
    expect(tileset).toBeDefined();

    const localIds = [3, 0, 2];
    const first =
      await harness.service.renderTiles({
        mapPath: MAP_PATH,
        tilesetAssetId:
          tileset?.assetId ?? "",
        localIds,
        columns: 2,
        scale: 2,
        expectedMapRevision:
          summary.revision as string,
        expectedTilesetRevision:
          tileset?.revision ?? "",
      });
    const firstResult = first.result as {
      mimeType: string;
      pixelSize: {
        width: number;
        height: number;
      };
      byteLength: number;
      sha256: string;
      map: {
        path: string;
        revision: string;
      };
      source: {
        assetId: string;
        revision: string;
      };
      image: {
        path: string;
        revision: string;
        format: string;
      };
      renderProfile: string;
      selection: {
        localIds: number[];
        count: number;
        order: string;
        labels: string;
        layout: {
          kind: string;
          requestedColumns: number;
          columns: number;
          rows: number;
          adjusted: boolean;
        };
      };
      scale: number;
      snapshotConsistency: string;
      truncated: boolean;
    };
    expect(first.png.subarray(0, 8)).toEqual(
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a,
        0x1a, 0x0a,
      ]),
    );
    expect(firstResult).toMatchObject({
      mimeType: "image/png",
      byteLength: first.png.byteLength,
      sha256: revisionOf(first.png),
      map: {
        path: MAP_PATH,
        revision: summary.revision,
      },
      source: {
        assetId: tileset?.assetId,
        revision: tileset?.revision,
      },
      image: {
        path: "tiles/terrain.png",
        revision: revisionOf(firstImage),
        format: "png",
      },
      renderProfile:
        "explicit-local-id-atlas-selection-v1",
      selection: {
        localIds,
        count: 3,
        order: "input",
        labels: "local-id",
        layout: {
          kind: "row-major",
          requestedColumns: 2,
          columns: 2,
          rows: 2,
          adjusted: false,
        },
      },
      scale: 2,
      snapshotConsistency:
        "non-atomic-read-set",
      truncated: false,
    });
    expect(firstResult).not.toHaveProperty("page");

    const secondImage =
      await terrainPng("#ff0000");
    await writeFile(imagePath, secondImage);
    const second =
      await harness.service.renderTiles({
        mapPath: MAP_PATH,
        tilesetAssetId:
          tileset?.assetId ?? "",
        localIds,
        columns: 2,
        scale: 2,
      });
    const secondResult = second.result as {
      sha256: string;
      source: { revision: string };
      image: { revision: string };
      selection: { localIds: number[] };
    };
    expect(secondResult.source.revision).toBe(
      firstResult.source.revision,
    );
    expect(secondResult.image.revision).toBe(
      revisionOf(secondImage),
    );
    expect(secondResult.image.revision).not.toBe(
      firstResult.image.revision,
    );
    expect(secondResult.sha256).not.toBe(
      firstResult.sha256,
    );
    expect(secondResult.selection.localIds).toEqual(
      localIds,
    );
  });

  it("prioritizes independent stale render pins over malformed replacement bytes", async () => {
    const assetId =
      await getAssetId(harness.service);
    const mapBefore = await readFile(
      join(harness.root, MAP_PATH),
    );
    const tilesetBefore = await readFile(
      join(harness.root, TILESET_PATH),
    );

    const malformedMap = Buffer.from(
      '{"type":',
      "utf8",
    );
    await writeFile(
      join(harness.root, MAP_PATH),
      malformedMap,
    );
    await expect(
      harness.service.renderTiles({
        mapPath: MAP_PATH,
        tilesetAssetId: assetId,
        localIds: [0],
        expectedMapRevision:
          revisionOf(mapBefore),
      }),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      details: {
        path: MAP_PATH,
        expectedRevision: revisionOf(mapBefore),
        actualRevision: revisionOf(malformedMap),
      },
    });

    await writeFile(
      join(harness.root, MAP_PATH),
      mapBefore,
    );
    const malformedTileset = Buffer.from(
      '{"type":',
      "utf8",
    );
    await writeFile(
      join(harness.root, TILESET_PATH),
      malformedTileset,
    );
    await expect(
      harness.service.renderTiles({
        mapPath: MAP_PATH,
        tilesetAssetId: assetId,
        localIds: [0],
        expectedTilesetRevision:
          revisionOf(tilesetBefore),
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        assetId,
        expectedRevision:
          revisionOf(tilesetBefore),
        actualRevision:
          revisionOf(malformedTileset),
      },
    });
  });

  it("compares the selected TSJ raw revision before parsing a malformed post-binding replacement", async () => {
    const assetId =
      await getAssetId(harness.service);
    const tilesetBefore = await readFile(
      join(harness.root, TILESET_PATH),
    );
    const malformedTileset = Buffer.from(
      '{"type":',
      "utf8",
    );
    let injectedWrites = 0;
    const service = await createServiceWithReadHook(
      harness.root,
      async ({ path, readCount }) => {
        if (
          path === TILESET_PATH &&
          readCount === 1
        ) {
          injectedWrites += 1;
          await writeFile(
            join(harness.root, TILESET_PATH),
            malformedTileset,
          );
        }
      },
    );

    await expect(
      service.renderTiles({
        mapPath: MAP_PATH,
        tilesetAssetId: assetId,
        localIds: [0],
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        assetId,
        expectedRevision:
          revisionOf(tilesetBefore),
        actualRevision:
          revisionOf(malformedTileset),
      },
    });
    expect(injectedWrites).toBe(1);
  });

  it("rejects a selected TSJ change after its render snapshot", async () => {
    await writeFile(
      join(harness.root, "tiles", "terrain.png"),
      await terrainPng("#4f8f4f"),
    );
    const assetId =
      await getAssetId(harness.service);
    const tilesetBefore = await readFile(
      join(harness.root, TILESET_PATH),
    );
    const changedTileset = baseTileset();
    changedTileset.vendorTilesetExtension = {
      changedDuringExplicitTileRender: true,
    };
    const changedBytes =
      serializeJsonDocument(changedTileset);
    let injectedWrites = 0;
    const service = await createServiceWithReadHook(
      harness.root,
      async ({ path, readCount }) => {
        if (
          path === TILESET_PATH &&
          readCount === 2
        ) {
          injectedWrites += 1;
          await writeFile(
            join(harness.root, TILESET_PATH),
            changedBytes,
          );
        }
      },
    );

    await expect(
      service.renderTiles({
        mapPath: MAP_PATH,
        tilesetAssetId: assetId,
        localIds: [3, 0, 2],
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        assetId,
        expectedRevision:
          revisionOf(tilesetBefore),
        actualRevision:
          revisionOf(changedBytes),
      },
    });
    expect(injectedWrites).toBe(1);
  });

  it("rejects a map change after its explicit tile render snapshot", async () => {
    await writeFile(
      join(harness.root, "tiles", "terrain.png"),
      await terrainPng("#4f8f4f"),
    );
    const assetId =
      await getAssetId(harness.service);
    const mapBefore = await readFile(
      join(harness.root, MAP_PATH),
    );
    const changedMap = baseMap();
    changedMap.vendorExtension = {
      changedDuringExplicitTileRender: true,
    };
    const changedBytes =
      serializeJsonDocument(changedMap);
    let injectedWrites = 0;
    const service = await createServiceWithReadHook(
      harness.root,
      async ({ path, readCount }) => {
        if (
          path === MAP_PATH &&
          readCount === 1
        ) {
          injectedWrites += 1;
          await writeFile(
            join(harness.root, MAP_PATH),
            changedBytes,
          );
        }
      },
    );

    await expect(
      service.renderTiles({
        mapPath: MAP_PATH,
        tilesetAssetId: assetId,
        localIds: [3, 0, 2],
      }),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      details: {
        path: MAP_PATH,
        expectedRevision: revisionOf(mapBefore),
        actualRevision:
          revisionOf(changedBytes),
      },
    });
    expect(injectedWrites).toBe(1);
  });

  it.each([
    "image",
    "imagewidth",
    "imageheight",
    "x",
    "y",
    "width",
    "height",
  ])(
    "rejects per-tile %s overrides in both atlas render tools",
    async (field) => {
      const tilesetDocument = baseTileset();
      tilesetDocument.tiles = [
        {
          id: 0,
          [field]:
            field === "image"
              ? "override.png"
              : 1,
        },
      ];
      await writeJson(
        join(harness.root, TILESET_PATH),
        tilesetDocument,
      );
      const assetId =
        await getAssetId(harness.service);

      await expect(
        harness.service.renderTiles({
          mapPath: MAP_PATH,
          tilesetAssetId: assetId,
          localIds: [0],
        }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_TILESET",
        details: {
          path: TILESET_PATH,
          localId: 0,
          field,
        },
      });
      await expect(
        harness.service.renderTilesetSheet({
          mapPath: MAP_PATH,
          tilesetAssetId: assetId,
        }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_TILESET",
        details: {
          path: TILESET_PATH,
          localId: 0,
          field,
        },
      });
    },
  );

  it("renders a native map region from exact map, TSJ and image snapshots", async () => {
    const imagePath = join(harness.root, "tiles", "terrain.png");
    await writeFile(imagePath, await terrainPng("#4f8f4f"));
    const summary = await harness.service.getSummary(MAP_PATH);
    const rendered = await harness.service.renderPreview({
      mapPath: MAP_PATH,
      region: { x: 1, y: 0, width: 2, height: 2 },
      layerIds: [LAYER_ID],
      scale: 1,
    });
    const result = rendered.result as {
      mimeType: string;
      pixelSize: { width: number; height: number };
      byteLength: number;
      sha256: string;
      map: { path: string; revision: string };
      dependencyRevisions: Record<string, string>;
      sources: Array<{
        assetId: string;
        tileset: { path: string; revision: string };
        image: { path: string; revision: string; format: string };
      }>;
      tileRegion: { x: number; y: number; width: number; height: number };
      coordinateTransform: {
        tileOrigin: { x: number; y: number };
        pixelOrigin: { x: number; y: number };
        pixelsPerTile: { x: number; y: number };
      };
      layerIds: number[];
      layerSelection: string;
      omittedLayers: unknown[];
      omittedLayerCount: number;
      omittedLayersTruncated: boolean;
      partial: boolean;
      snapshotConsistency: string;
      truncated: boolean;
    };
    expect(result).toMatchObject({
      mimeType: "image/png",
      pixelSize: { width: 32, height: 32 },
      byteLength: rendered.png.byteLength,
      sha256: revisionOf(rendered.png),
      map: { path: MAP_PATH, revision: summary.revision },
      dependencyRevisions: summary.dependencyRevisions,
      sources: [
        {
          assetId: expect.stringMatching(/^asset_[0-9a-f]{24}$/u),
          tileset: {
            path: TILESET_PATH,
            revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          },
          image: {
            path: "tiles/terrain.png",
            revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            format: "png",
          },
        },
      ],
      tileRegion: { x: 1, y: 0, width: 2, height: 2 },
      coordinateTransform: {
        tileOrigin: { x: 1, y: 0 },
        pixelOrigin: { x: 0, y: 0 },
        pixelsPerTile: { x: 16, y: 16 },
      },
      layerIds: [LAYER_ID],
      layerSelection: "explicit",
      omittedLayers: [],
      omittedLayerCount: 0,
      omittedLayersTruncated: false,
      partial: false,
      snapshotConsistency: "non-atomic-read-set",
      overlays: {
        grid: false,
        coordinates: false,
        highlights: {
          style: "selection-amber-v1",
          entries: [],
          highlightedTileCount: 0,
          color: { r: 250, g: 204, b: 21, a: 96 },
          blendMode: "source-over",
          overlapMode: "tile-union",
        },
      },
      truncated: false,
    });

    const decoded = await sharp(rendered.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({
      width: 32,
      height: 32,
      channels: 4,
    });
    expect([...decoded.data.subarray(0, 4)]).toEqual([79, 143, 79, 255]);
    expect([...decoded.data.subarray(16 * 4, 16 * 4 + 4)]).toEqual([
      70, 122, 163, 255,
    ]);
  });

  it("rejects a disjoint native highlight before loading atlas images", async () => {
    await expect(
      harness.service.renderPreview({
        mapPath: MAP_PATH,
        region: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
        overlays: {
          highlights: [
            {
              x: 1,
              y: 1,
              width: 1,
              height: 1,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: {
        sourceIndex: 0,
        tileRegion: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      },
    });
  });

  it("does not load atlas images for opacity-zero tile layers", async () => {
    const map = baseMap();
    const layers = map.layers;
    if (!Array.isArray(layers) || !isJsonObject(layers[0])) {
      throw new Error("Expected the fixture tile layer.");
    }
    layers[0].opacity = 0;
    await writeJson(join(harness.root, MAP_PATH), map);

    const rendered = await harness.service.renderPreview({
      mapPath: MAP_PATH,
      layerIds: [LAYER_ID],
      scale: 1,
    });
    expect(rendered.result).toMatchObject({
      sources: [],
      layerIds: [LAYER_ID],
      partial: false,
    });
  });

  it("fails closed on per-tile atlas subrect overrides", async () => {
    await writeFile(
      join(harness.root, "tiles", "terrain.png"),
      await terrainPng("#4f8f4f"),
    );
    const tileset = baseTileset();
    tileset.tiles = [
      {
        id: 0,
        x: 0,
        y: 0,
        width: 16,
        height: 16,
      },
    ];
    await writeJson(join(harness.root, TILESET_PATH), tileset);

    await expect(
      harness.service.renderPreview({
        mapPath: MAP_PATH,
        layerIds: [LAYER_ID],
        scale: 1,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_RENDER_FEATURE",
      details: expect.objectContaining({
        feature: "tile-image-subrect",
        path: TILESET_PATH,
      }),
    });
  });

  it("reads a rectangular region as stable tile refs with decoded transforms", async () => {
    const assetId = await getAssetId(harness.service);
    const region = await harness.service.getRegion({
      mapPath: MAP_PATH,
      layerId: LAYER_ID,
      x: 1,
      y: 0,
      width: 2,
      height: 2,
    });

    expect(region).toMatchObject({
      mapPath: MAP_PATH,
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      layer: { id: LAYER_ID, name: "Ground" },
      region: { x: 1, y: 0, width: 2, height: 2 },
      rows: [
        [
          {
            tileset: { kind: "external", assetId },
            localId: 0,
            transform: {
              kind: "orthogonal",
              flipH: false,
              flipV: false,
              flipD: false,
              rawFlags: 0,
            },
          },
          {
            tileset: { kind: "external", assetId },
            localId: 2,
            transform: {
              kind: "orthogonal",
              flipH: true,
              flipV: false,
              flipD: true,
              rawFlags:
                (GID_FLIP_HORIZONTAL | GID_DIAGONAL_OR_HEX_60) >>> 0,
            },
          },
        ],
        [null, null],
      ],
    });
  });

  it("plans without writing and applies both closed edit operations while preserving unknown fields", async () => {
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const before = await readFile(absoluteMapPath);
    const assetId = await getAssetId(harness.service);
    const operations = [
      {
        type: "setTiles" as const,
        layerId: LAYER_ID,
        cells: [
          {
            x: 0,
            y: 0,
            tile: {
              tileset: { kind: "external" as const, assetId },
              localId: 3,
              transform: {
                kind: "orthogonal" as const,
                flipH: true,
                flipV: false,
                flipD: false,
              },
            },
          },
        ],
      },
      {
        type: "fillRegion" as const,
        layerId: LAYER_ID,
        x: 1,
        y: 1,
        width: 2,
        height: 2,
        tile: { tileset: { kind: "external" as const, assetId }, localId: 1 },
      },
    ];

    const plan = await harness.service.planEdits(
      MAP_PATH,
      await getMapRevision(harness.service),
      await getDependencyRevisions(harness.service),
      operations,
    );

    expect(plan).toMatchObject({
      version: 1,
      id: expect.stringMatching(/^changeset:[0-9a-f]{64}$/),
      mapPath: MAP_PATH,
      baseRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      dependencyRevisions: {
        [assetId]: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
      operations,
      summary: {
        operationCount: 2,
        cellWrites: 5,
        affectedLayerIds: [LAYER_ID],
      },
    });
    expect(await readFile(absoluteMapPath)).toEqual(before);

    const result = await harness.service.applyEdits(plan);
    const saved = JSON.parse(
      await readFile(absoluteMapPath, "utf8"),
    ) as JsonObject;
    const layer = (saved.layers as JsonObject[])[0];

    expect(result).toMatchObject({
      path: MAP_PATH,
      beforeRevision: plan.baseRevision,
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      checkpointId: expect.any(String),
      changed: true,
      changeSetId: plan.id,
    });
    expect(result.revision).not.toBe(plan.baseRevision);
    expect(saved.vendorExtension).toEqual({
      preserve: true,
      nested: { future: "root-field" },
    });
    expect(layer?.vendorLayerExtension).toEqual({
      preserve: ["layer", 17],
    });
    expect(layer?.data).toEqual([
      (GID_FLIP_HORIZONTAL | 4) >>> 0,
      1,
      FLAGGED_LOCAL_ID_TWO,
      0,
      4,
      2,
      2,
      0,
      0,
      2,
      2,
      4,
    ]);
  });

  it("plans and applies one canonical external tileset reference through the existing single-map commit path", async () => {
    const tilesetPath = "tiles/decor.tsj";
    const prospectiveTileset = baseTileset();
    prospectiveTileset.name = "Decor";
    prospectiveTileset.vendorProspectiveExtension = {
      preserve: ["target", 17],
    };
    await writeJson(join(harness.root, tilesetPath), prospectiveTileset);

    const absoluteMapPath = join(harness.root, MAP_PATH);
    const beforeMap = await readFile(absoluteMapPath, "utf8");
    const beforeTileset = await readFile(
      join(harness.root, tilesetPath),
    );
    const summary = await harness.service.getSummary(MAP_PATH);
    const targetRevision = await harness.store.readRevision(tilesetPath);
    const plan = await harness.service.planAddTilesetToMap({
      mapPath: MAP_PATH,
      tilesetPath,
      expectedMapRevision: summary.revision as string,
      expectedDependencyRevisions:
        summary.dependencyRevisions as Record<string, string>,
      expectedTilesetRevision: targetRevision,
    });
    const operation = plan.operations[0];
    if (operation?.type !== "addTilesetToMap") {
      throw new Error("Expected a resolved add-tileset operation.");
    }

    expect(plan).toMatchObject({
      version: 1,
      mapPath: MAP_PATH,
      baseRevision: summary.revision,
      dependencyRevisions: summary.dependencyRevisions,
      operations: [
        {
          type: "addTilesetToMap",
          tilesetPath,
          source: "../tiles/decor.tsj",
          assetId: expect.stringMatching(/^asset_[0-9a-f]{24}$/),
          tilesetRevision: targetRevision,
          tileCount: 4,
          firstGid: 5,
        },
      ],
      summary: {
        operationCount: 1,
        cellWrites: 0,
        affectedLayerIds: [],
        affectedTileLayerIds: [],
        affectedObjectLayerIds: [],
        createdObjectIds: [],
        updatedObjectIds: [],
        deletedObjectIds: [],
        addedTilesets: [
          {
            tilesetPath,
            source: "../tiles/decor.tsj",
            assetId: expect.stringMatching(/^asset_/),
            tilesetRevision: targetRevision,
            tileCount: 4,
            firstGid: 5,
          },
        ],
      },
    });
    expect(plan.prospectiveDependencyRevisions).toEqual({
      [operation.assetId]: targetRevision,
    });
    expect(await readFile(absoluteMapPath, "utf8")).toBe(beforeMap);

    const preview = new ChangeSetRegistry().put(plan);
    expect(preview).toMatchObject({
      expectedRevision: summary.revision,
      dependencyRevisions: summary.dependencyRevisions,
      prospectiveDependencyRevisions: plan.prospectiveDependencyRevisions,
      snapshotConsistency: "non-atomic-read-set",
      operations: [
        {
          type: "addTilesetToMap",
          destructive: false,
          tileset: {
            kind: "external",
            path: tilesetPath,
            revision: targetRevision,
            tileCount: 4,
          },
          source: "../tiles/decor.tsj",
          assignedFirstGid: 5,
          gidRange: { first: 5, last: 8 },
        },
      ],
    });

    const result = await harness.service.applyEdits(plan);
    const afterMap = await readFile(absoluteMapPath, "utf8");
    const saved = JSON.parse(afterMap) as JsonObject;
    expect(result).toMatchObject({
      path: MAP_PATH,
      beforeRevision: summary.revision,
      changed: true,
      checkpointId: expect.any(String),
    });
    expect(saved.tilesets).toEqual([
      { firstgid: 1, source: "../tiles/terrain.tsj" },
      { firstgid: 5, source: "../tiles/decor.tsj" },
    ]);
    expect(maskJsonValues(beforeMap, [["tilesets"]])).toBe(
      maskJsonValues(afterMap, [["tilesets"]]),
    );
    expect(await readFile(join(harness.root, tilesetPath))).toEqual(
      beforeTileset,
    );
  });

  it("allocates firstgid after the highest occupied range without filling gaps or changing existing references", async () => {
    const otherPath = "tiles/other.tsj";
    const prospectivePath = "tiles/decor.tsj";
    const other = baseTileset();
    other.name = "Other";
    const prospective = baseTileset();
    prospective.name = "Decor";
    await writeJson(join(harness.root, otherPath), other);
    await writeJson(join(harness.root, prospectivePath), prospective);
    const map = baseMap();
    map.tilesets = [
      { firstgid: 1, source: "../tiles/terrain.tsj" },
      { firstgid: 10, source: "../tiles/other.tsj" },
    ];
    await writeJson(join(harness.root, MAP_PATH), map);

    const summary = await harness.service.getSummary(MAP_PATH);
    const plan = await harness.service.planAddTilesetToMap({
      mapPath: MAP_PATH,
      tilesetPath: prospectivePath,
      expectedMapRevision: summary.revision as string,
      expectedDependencyRevisions:
        summary.dependencyRevisions as Record<string, string>,
    });

    expect(plan.operations).toEqual([
      expect.objectContaining({
        type: "addTilesetToMap",
        source: "../tiles/decor.tsj",
        tileCount: 4,
        firstGid: 14,
      }),
    ]);
    await harness.service.applyEdits(plan);
    const saved = JSON.parse(
      await readFile(join(harness.root, MAP_PATH), "utf8"),
    ) as JsonObject;
    expect(saved.tilesets).toEqual([
      { firstgid: 1, source: "../tiles/terrain.tsj" },
      { firstgid: 10, source: "../tiles/other.tsj" },
      { firstgid: 14, source: "../tiles/decor.tsj" },
    ]);
  });

  it("reserves the high-water local ID of sparse existing tile definitions", async () => {
    const current = baseTileset();
    current.tiles = [{ id: 99, type: "Reserved metadata tile" }];
    await writeJson(join(harness.root, TILESET_PATH), current);
    const prospectivePath = "tiles/decor.tsj";
    const prospective = baseTileset();
    prospective.name = "Decor";
    await writeJson(join(harness.root, prospectivePath), prospective);
    const summary = await harness.service.getSummary(MAP_PATH);

    const plan = await harness.service.planAddTilesetToMap({
      mapPath: MAP_PATH,
      tilesetPath: prospectivePath,
      expectedMapRevision: summary.revision as string,
      expectedDependencyRevisions:
        summary.dependencyRevisions as Record<string, string>,
    });

    expect(plan.operations).toEqual([
      expect.objectContaining({
        type: "addTilesetToMap",
        firstGid: 101,
      }),
    ]);
  });

  it("carries a prospective nexttileid high-water mark into the planned GID range", async () => {
    const prospectivePath = "tiles/decor.tsj";
    const prospective = baseTileset();
    prospective.name = "Decor";
    prospective.nexttileid = 100;
    await writeJson(join(harness.root, prospectivePath), prospective);
    const summary = await harness.service.getSummary(MAP_PATH);

    const plan = await harness.service.planAddTilesetToMap({
      mapPath: MAP_PATH,
      tilesetPath: prospectivePath,
      expectedMapRevision: summary.revision as string,
      expectedDependencyRevisions:
        summary.dependencyRevisions as Record<string, string>,
    });
    const preview = new ChangeSetRegistry().put(plan);

    expect(plan.operations).toEqual([
      expect.objectContaining({
        type: "addTilesetToMap",
        firstGid: 5,
        tileCount: 4,
        gidSpan: 100,
      }),
    ]);
    expect(preview.operations).toEqual([
      expect.objectContaining({
        type: "addTilesetToMap",
        assignedFirstGid: 5,
        gidRange: { first: 5, last: 104 },
        tileset: expect.objectContaining({
          tileCount: 4,
          gidSpan: 100,
        }),
      }),
    ]);

    await harness.service.applyEdits(plan);
    const afterFirstAdd = await harness.service.getSummary(MAP_PATH);
    expect(afterFirstAdd.tilesets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: prospectivePath,
          tileCount: 4,
          gidSpan: 100,
          firstGid: 5,
          lastPotentialGid: 104,
        }),
      ]),
    );

    const secondProspectivePath = "tiles/props.tsj";
    const secondProspective = baseTileset();
    secondProspective.name = "Props";
    await writeJson(
      join(harness.root, secondProspectivePath),
      secondProspective,
    );
    const secondPlan = await harness.service.planAddTilesetToMap({
      mapPath: MAP_PATH,
      tilesetPath: secondProspectivePath,
      expectedMapRevision: afterFirstAdd.revision as string,
      expectedDependencyRevisions:
        afterFirstAdd.dependencyRevisions as Record<string, string>,
    });
    expect(secondPlan.operations).toEqual([
      expect.objectContaining({
        type: "addTilesetToMap",
        firstGid: 105,
        tileCount: 4,
        gidSpan: 4,
      }),
    ]);
  });

  it("rejects duplicate, unsorted and currently unresolved GID inputs before issuing an add-tileset plan", async () => {
    const initial = await harness.service.getSummary(MAP_PATH);
    await expect(
      harness.service.planAddTilesetToMap({
        mapPath: MAP_PATH,
        tilesetPath: TILESET_PATH,
        expectedMapRevision: initial.revision as string,
        expectedDependencyRevisions:
          initial.dependencyRevisions as Record<string, string>,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "TILESET_ALREADY_REFERENCED",
    });

    const prospectivePath = "tiles/decor.tsj";
    const prospective = baseTileset();
    prospective.name = "Decor";
    await writeJson(join(harness.root, prospectivePath), prospective);
    const otherPath = "tiles/other.tsj";
    const other = baseTileset();
    other.name = "Other";
    await writeJson(join(harness.root, otherPath), other);
    const unsortedMap = baseMap();
    unsortedMap.tilesets = [
      { firstgid: 10, source: "../tiles/other.tsj" },
      { firstgid: 1, source: "../tiles/terrain.tsj" },
    ];
    await writeJson(join(harness.root, MAP_PATH), unsortedMap);
    const unsortedSummary = await harness.service.getSummary(MAP_PATH);
    await expect(
      harness.service.planAddTilesetToMap({
        mapPath: MAP_PATH,
        tilesetPath: prospectivePath,
        expectedMapRevision: unsortedSummary.revision as string,
        expectedDependencyRevisions:
          unsortedSummary.dependencyRevisions as Record<string, string>,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "UNSORTED_TILESET_REFERENCES",
    });

    const unresolvedMap = baseMap();
    ((unresolvedMap.layers as JsonObject[])[0]?.data as JsonValue[])[0] = 5;
    await writeJson(join(harness.root, MAP_PATH), unresolvedMap);
    const unresolvedSummary = await harness.service.getSummary(MAP_PATH);
    await expect(
      harness.service.planAddTilesetToMap({
        mapPath: MAP_PATH,
        tilesetPath: prospectivePath,
        expectedMapRevision: unresolvedSummary.revision as string,
        expectedDependencyRevisions:
          unresolvedSummary.dependencyRevisions as Record<string, string>,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "GID_OUT_OF_RANGE",
    });
  });

  it("rejects prospective tilesets outside the root-atlas write profile", async () => {
    const prospectivePath = "tiles/collection.tsj";
    const prospective = baseTileset();
    prospective.name = "Collection-shaped override";
    prospective.tiles = [
      {
        id: 0,
        image: "terrain.png",
        imagewidth: 16,
        imageheight: 16,
      },
    ];
    await writeJson(join(harness.root, prospectivePath), prospective);
    const summary = await harness.service.getSummary(MAP_PATH);

    await expect(
      harness.service.planAddTilesetToMap({
        mapPath: MAP_PATH,
        tilesetPath: prospectivePath,
        expectedMapRevision: summary.revision as string,
        expectedDependencyRevisions:
          summary.dependencyRevisions as Record<string, string>,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "UNSUPPORTED_TILESET",
      details: {
        path: prospectivePath,
        localId: 0,
        field: "image",
      },
    });
  });

  it("fails closed when the next tileset range would exceed Tiled's base-GID space", async () => {
    const map = baseMap();
    map.tilesets = [
      {
        firstgid: 0x0fffffff,
        source: "../tiles/terrain.tsj",
      },
    ];
    const tileLayer = (map.layers as JsonObject[])[0];
    if (tileLayer === undefined) {
      throw new Error("Expected the fixture tile layer.");
    }
    tileLayer.data = Array.from({ length: 12 }, () => 0);
    const current = baseTileset();
    current.tilecount = 1;
    await writeJson(join(harness.root, MAP_PATH), map);
    await writeJson(join(harness.root, TILESET_PATH), current);
    const prospectivePath = "tiles/decor.tsj";
    const prospective = baseTileset();
    prospective.name = "Decor";
    await writeJson(join(harness.root, prospectivePath), prospective);
    const summary = await harness.service.getSummary(MAP_PATH);

    await expect(
      harness.service.planAddTilesetToMap({
        mapPath: MAP_PATH,
        tilesetPath: prospectivePath,
        expectedMapRevision: summary.revision as string,
        expectedDependencyRevisions:
          summary.dependencyRevisions as Record<string, string>,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "GID_RANGE_EXHAUSTED",
      details: {
        maximumBaseGid: 0x0fffffff,
      },
    });
  });

  it("reports a prospective revision conflict before parsing malformed replacement bytes", async () => {
    const prospectivePath = "tiles/decor.tsj";
    const prospective = baseTileset();
    prospective.name = "Decor";
    await writeJson(join(harness.root, prospectivePath), prospective);
    const summary = await harness.service.getSummary(MAP_PATH);
    const plan = await harness.service.planAddTilesetToMap({
      mapPath: MAP_PATH,
      tilesetPath: prospectivePath,
      expectedMapRevision: summary.revision as string,
      expectedDependencyRevisions:
        summary.dependencyRevisions as Record<string, string>,
    });
    const beforeMap = await readFile(join(harness.root, MAP_PATH));
    await writeFile(
      join(harness.root, prospectivePath),
      '{"type":"tileset", malformed',
      "utf8",
    );

    await expect(harness.service.applyEdits(plan)).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        path: prospectivePath,
        expectedRevision:
          plan.prospectiveDependencyRevisions?.[
            (plan.operations[0] as { assetId?: string }).assetId ?? ""
          ],
        actualRevision: expect.stringMatching(/^sha256:/),
      },
    });
    expect(await readFile(join(harness.root, MAP_PATH))).toEqual(beforeMap);
  });

  it("pins existing dependency bytes before parsing during both add-tileset planning and apply", async () => {
    const prospectivePath = "tiles/decor.tsj";
    const prospective = baseTileset();
    prospective.name = "Decor";
    await writeJson(join(harness.root, prospectivePath), prospective);
    const initial = await harness.service.getSummary(MAP_PATH);
    const originalDependency = await readFile(
      join(harness.root, TILESET_PATH),
    );
    await writeFile(
      join(harness.root, TILESET_PATH),
      '{"type":"tileset", malformed',
      "utf8",
    );

    await expect(
      harness.service.planAddTilesetToMap({
        mapPath: MAP_PATH,
        tilesetPath: prospectivePath,
        expectedMapRevision: initial.revision as string,
        expectedDependencyRevisions:
          initial.dependencyRevisions as Record<string, string>,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        expectedRevision: expect.stringMatching(/^sha256:/),
        actualRevision: expect.stringMatching(/^sha256:/),
      },
    });

    await writeFile(join(harness.root, TILESET_PATH), originalDependency);
    const plan = await harness.service.planAddTilesetToMap({
      mapPath: MAP_PATH,
      tilesetPath: prospectivePath,
      expectedMapRevision: initial.revision as string,
      expectedDependencyRevisions:
        initial.dependencyRevisions as Record<string, string>,
    });
    const beforeMap = await readFile(join(harness.root, MAP_PATH));
    await writeFile(
      join(harness.root, TILESET_PATH),
      '{"type":"tileset", malformed-again',
      "utf8",
    );

    await expect(harness.service.applyEdits(plan)).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        expectedRevision: expect.stringMatching(/^sha256:/),
        actualRevision: expect.stringMatching(/^sha256:/),
      },
    });
    expect(await readFile(join(harness.root, MAP_PATH))).toEqual(beforeMap);
  });

  it("keeps the resolved add operation out of the generic map-edit planner", async () => {
    const prospectivePath = "tiles/decor.tsj";
    const prospective = baseTileset();
    prospective.name = "Decor";
    await writeJson(join(harness.root, prospectivePath), prospective);
    const summary = await harness.service.getSummary(MAP_PATH);
    const addPlan = await harness.service.planAddTilesetToMap({
      mapPath: MAP_PATH,
      tilesetPath: prospectivePath,
      expectedMapRevision: summary.revision as string,
      expectedDependencyRevisions:
        summary.dependencyRevisions as Record<string, string>,
    });

    await expect(
      harness.service.planEdits(
        MAP_PATH,
        summary.revision as string,
        summary.dependencyRevisions as Record<string, string>,
        addPlan.operations as unknown as MapEditOperation[],
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
    });
  });

  it("lists basic objects as flat summaries with map and dependency revisions", async () => {
    const assetId = await getAssetId(harness.service);
    const result = await harness.service.listObjects({ mapPath: MAP_PATH });

    expect(result).toMatchObject({
      mapPath: MAP_PATH,
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      dependencyRevisions: {
        [assetId]: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
      total: 2,
      truncated: false,
      objects: [
        {
          id: 1,
          layerId: OBJECT_LAYER_ID,
          layerName: "Gameplay Objects",
          name: "Crate",
          className: "Collision",
          shape: "rectangle",
          x: 4,
          y: 5,
          width: 8,
          height: 9,
          rotation: 15,
          visible: true,
          opacity: 0.75,
        },
        {
          id: 2,
          layerId: OBJECT_LAYER_ID,
          layerName: "Gameplay Objects",
          name: "Spawn",
          className: "Marker",
          shape: "point",
          x: 30,
          y: 31,
          width: 0,
          height: 0,
          rotation: 0,
          visible: false,
          opacity: 1,
        },
      ],
    });
  });

  it("bounds repeated display strings in object-list results", async () => {
    const map = baseMap();
    const objectLayer = (map.layers as JsonObject[])[1] as JsonObject;
    const objects = objectLayer.objects as JsonObject[];
    objectLayer.name = "L".repeat(1_000);
    (objects[0] as JsonObject).name = "N".repeat(1_000);
    (objects[0] as JsonObject).type = "C".repeat(1_000);
    await writeJson(join(harness.root, MAP_PATH), map);

    const result = await harness.service.listObjects({
      mapPath: MAP_PATH,
      limit: 1,
    });
    const object = (result.objects as Array<Record<string, unknown>>)[0];

    expect(object).toMatchObject({
      layerNameTruncated: true,
      nameTruncated: true,
      classNameTruncated: true,
    });
    expect((object?.layerName as string).length).toBe(128);
    expect((object?.name as string).length).toBe(128);
    expect((object?.className as string).length).toBe(128);
  });

  it("previews and applies ordered basic object edits while preserving unknown fields", async () => {
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const before = await readFile(absoluteMapPath);
    const operations: MapEditOperation[] = [
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "rectangle",
          x: 48.5,
          y: 32,
          width: 16,
          height: 8,
          name: "Chest",
          className: "Loot",
          opacity: 0.5,
        },
      },
      {
        type: "updateObject",
        objectId: 1,
        patch: {
          x: 6,
          name: "Moved crate",
          visible: false,
        },
      },
      {
        type: "deleteObjects",
        objectIds: [2],
      },
    ];

    const plan = await harness.service.planEdits(
      MAP_PATH,
      await getMapRevision(harness.service),
      await getDependencyRevisions(harness.service),
      operations,
    );

    expect(plan).toMatchObject({
      mapPath: MAP_PATH,
      operations,
      summary: {
        operationCount: 3,
        cellWrites: 0,
        affectedLayerIds: [OBJECT_LAYER_ID],
        affectedTileLayerIds: [],
        affectedObjectLayerIds: [OBJECT_LAYER_ID],
        createdObjectIds: [3],
        updatedObjectIds: [1],
        deletedObjectIds: [2],
      },
    });
    expect(await readFile(absoluteMapPath)).toEqual(before);

    await harness.service.applyEdits(plan);
    const saved = JSON.parse(
      await readFile(absoluteMapPath, "utf8"),
    ) as JsonObject;
    const layers = saved.layers as JsonObject[];
    const tileLayer = layers[0];
    const objectLayer = layers[1];
    const objects = objectLayer?.objects as JsonObject[];

    expect(saved.nextobjectid).toBe(4);
    expect(saved.vendorExtension).toEqual({
      preserve: true,
      nested: { future: "root-field" },
    });
    expect(tileLayer?.vendorLayerExtension).toEqual({
      preserve: ["layer", 17],
    });
    expect(objectLayer?.vendorObjectLayerExtension).toEqual({
      preserve: "object-layer-field",
    });
    expect(objects.map(({ id }) => id)).toEqual([1, 3]);
    expect(objects[0]).toMatchObject({
      id: 1,
      name: "Moved crate",
      type: "Collision",
      x: 6,
      y: 5,
      width: 8,
      height: 9,
      visible: false,
      vendorObjectExtension: {
        preserve: ["object", 1],
      },
    });
    expect(objects[1]).toMatchObject({
      id: 3,
      name: "Chest",
      type: "Loot",
      x: 48.5,
      y: 32,
      width: 16,
      height: 8,
      rotation: 0,
      visible: true,
      opacity: 0.5,
    });
  });

  it("rewrites only the object array and nextobjectid value in a BOM/CRLF source", async () => {
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const unusualSource =
      `\uFEFF${JSON.stringify(baseMap(), null, "\t")
        .replace(
          '"compressionlevel": -1',
          '"compressionlevel": -1.000e+0',
        )
        .replace(/\n/gu, "\r\n")}\r\n`;
    await writeFile(absoluteMapPath, unusualSource, "utf8");
    const before = await readFile(absoluteMapPath, "utf8");
    const plan = await harness.service.planEdits(
      MAP_PATH,
      await getMapRevision(harness.service),
      await getDependencyRevisions(harness.service),
      [
        {
          type: "createObject",
          layerId: OBJECT_LAYER_ID,
          object: {
            shape: "point",
            x: 12,
            y: 13,
            name: "Second spawn",
          },
        },
      ],
    );

    await harness.service.applyEdits(plan);
    const after = await readFile(absoluteMapPath, "utf8");
    const mutablePaths: JSONPath[] = [
      ["layers", 1, "objects"],
      ["nextobjectid"],
    ];

    expect(maskJsonValues(before, mutablePaths)).toBe(
      maskJsonValues(after, mutablePaths),
    );
    expect(after.startsWith("\uFEFF")).toBe(true);
    expect(after).toContain('"compressionlevel": -1.000e+0');
    expect(after).toContain("\r\n");
  });

  it("rejects object planning against a stale map revision", async () => {
    const staleRevision = await getMapRevision(harness.service);
    const dependencyRevisions = await getDependencyRevisions(harness.service);
    const externallyEdited = baseMap();
    externallyEdited.externalOwnerField = "changed before object planning";
    await writeJson(join(harness.root, MAP_PATH), externallyEdited);

    await expect(
      harness.service.planEdits(
        MAP_PATH,
        staleRevision,
        dependencyRevisions,
        [
          {
            type: "updateObject",
            objectId: 1,
            patch: { x: 10 },
          },
        ],
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "REVISION_CONFLICT",
      details: {
        path: MAP_PATH,
        expectedRevision: staleRevision,
        actualRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
  });

  it("fails editing closed when layer ids are duplicated", async () => {
    const dependencies = await getDependencyRevisions(harness.service);
    const map = baseMap();
    const layers = map.layers as JsonObject[];
    (layers[1] as JsonObject).id = LAYER_ID;
    await writeJson(join(harness.root, MAP_PATH), map);
    const loaded = await harness.store.read(MAP_PATH);

    await expect(
      harness.service.planEdits(
        MAP_PATH,
        loaded.revision,
        dependencies,
        [
          {
            type: "updateObject",
            objectId: 1,
            patch: { x: 10 },
          },
        ],
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_DOCUMENT",
      details: { path: MAP_PATH, layerId: LAYER_ID },
    });
  });

  it("rejects duplicate delete ids, empty updates, and point dimensions", async () => {
    const revision = await getMapRevision(harness.service);
    const dependencies = await getDependencyRevisions(harness.service);

    await expect(
      harness.service.planEdits(MAP_PATH, revision, dependencies, [
        { type: "deleteObjects", objectIds: [1, 1] },
      ]),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
    });
    await expect(
      harness.service.planEdits(MAP_PATH, revision, dependencies, [
        { type: "updateObject", objectId: 1, patch: {} },
      ]),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
    });
    await expect(
      harness.service.planEdits(MAP_PATH, revision, dependencies, [
        { type: "updateObject", objectId: 2, patch: { width: 16 } },
      ]),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "OBJECT_SHAPE_MISMATCH",
      details: { path: MAP_PATH, objectId: 2 },
    });
  });

  it("bounds the number of distinct JSON subtrees rewritten by one change set", async () => {
    const map = baseMap();
    const tileLayer = (map.layers as JsonObject[])[0] as JsonObject;
    const objectLayers: JsonObject[] = [];
    for (let index = 0; index < 129; index += 1) {
      objectLayers.push({
        id: 8 + index,
        name: `Objects ${index}`,
        type: "objectgroup",
        objects: [
          {
            id: index + 1,
            name: "",
            type: "",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            rotation: 0,
            visible: true,
          },
        ],
      });
    }
    map.layers = [tileLayer, ...objectLayers];
    map.nextlayerid = 137;
    map.nextobjectid = 130;
    await writeJson(join(harness.root, MAP_PATH), map);

    await expect(
      harness.service.planEdits(
        MAP_PATH,
        await getMapRevision(harness.service),
        await getDependencyRevisions(harness.service),
        [
          {
            type: "deleteObjects",
            objectIds: Array.from({ length: 129 }, (_, index) => index + 1),
          },
        ],
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "RESULT_LIMIT_EXCEEDED",
      details: { limit: 128, actual: 129 },
    });
  });

  it("refuses to leave a dangling object property reference", async () => {
    const map = baseMap();
    const objectLayer = (map.layers as JsonObject[])[1] as JsonObject;
    const objects = objectLayer.objects as JsonObject[];
    (objects[0] as JsonObject).properties = [
      { name: "target", type: "object", value: 2 },
    ];
    await writeJson(join(harness.root, MAP_PATH), map);
    const revision = await getMapRevision(harness.service);
    const dependencies = await getDependencyRevisions(harness.service);

    await expect(
      harness.service.planEdits(MAP_PATH, revision, dependencies, [
        { type: "deleteObjects", objectIds: [2] },
      ]),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "OBJECT_IN_USE",
      details: {
        objectId: 2,
        propertyName: "target",
        jsonPointer: "/layers/1/objects/0/properties/0",
      },
    });

    const plan = await harness.service.planEdits(
      MAP_PATH,
      revision,
      dependencies,
      [{ type: "deleteObjects", objectIds: [1, 2] }],
    );
    expect(plan.summary.deletedObjectIds).toEqual([1, 2]);
  });

  it("detects object references nested in Tiled 1.12 list properties", async () => {
    const map = baseMap();
    const objectLayer = (map.layers as JsonObject[])[1] as JsonObject;
    const objects = objectLayer.objects as JsonObject[];
    (objects[0] as JsonObject).properties = [
      {
        name: "targets",
        type: "list",
        value: [{ type: "object", value: 2 }],
      },
    ];
    await writeJson(join(harness.root, MAP_PATH), map);

    await expect(
      harness.service.planEdits(
        MAP_PATH,
        await getMapRevision(harness.service),
        await getDependencyRevisions(harness.service),
        [{ type: "deleteObjects", objectIds: [2] }],
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "OBJECT_IN_USE",
      details: {
        objectId: 2,
        jsonPointer: "/layers/1/objects/0/properties/0/value/0",
      },
    });
  });

  it("fails object deletion closed when a class property may hide typed references", async () => {
    const map = baseMap();
    const objectLayer = (map.layers as JsonObject[])[1] as JsonObject;
    const objects = objectLayer.objects as JsonObject[];
    (objects[0] as JsonObject).properties = [
      {
        name: "configuration",
        type: "class",
        propertytype: "GameplayConfig",
        value: { target: 2 },
      },
    ];
    await writeJson(join(harness.root, MAP_PATH), map);

    await expect(
      harness.service.planEdits(
        MAP_PATH,
        await getMapRevision(harness.service),
        await getDependencyRevisions(harness.service),
        [{ type: "deleteObjects", objectIds: [2] }],
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "UNSUPPORTED_OBJECT_REFERENCE_ANALYSIS",
      details: {
        propertyName: "configuration",
        jsonPointer: "/layers/1/objects/0/properties/0",
      },
    });
  });

  it.each([
    ["template", "template", "../templates/enemy.tx"],
    ["tile", "gid", 1],
  ] as const)(
    "rejects semantic updates to a complex %s object",
    async (_label, feature, value) => {
      const map = baseMap();
      const objectLayer = (map.layers as JsonObject[])[1];
      const objects = objectLayer?.objects as JsonObject[];
      const complexObject: JsonObject = {
        id: 3,
        name: "Complex object",
        type: "",
        x: 0,
        y: 0,
        width: 8,
        height: 8,
        rotation: 0,
        visible: true,
      };
      complexObject[feature] = value as JsonValue;
      objects.push(complexObject);
      map.nextobjectid = 4;
      await writeJson(join(harness.root, MAP_PATH), map);

      await expect(
        harness.service.planEdits(
          MAP_PATH,
          await getMapRevision(harness.service),
          await getDependencyRevisions(harness.service),
          [
            {
              type: "updateObject",
              objectId: 3,
              patch: { x: 1 },
            },
          ],
        ),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "UNSUPPORTED_OBJECT_PROFILE",
        details: {
          path: MAP_PATH,
          objectId: 3,
          feature,
        },
      });
    },
  );

  it("rejects a tampered change set before writing", async () => {
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const before = await readFile(absoluteMapPath);
    const plan = await planSingleTile(harness.service, 0);
    const tampered = structuredClone(plan);
    const operation = tampered.operations[0];
    if (operation?.type !== "setTiles") {
      throw new Error("Expected a setTiles fixture operation.");
    }
    operation.cells[0] = { x: 1, y: 0, tile: null };

    await expect(harness.service.applyEdits(tampered)).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "CHANGE_SET_TAMPERED",
    });
    expect(await readFile(absoluteMapPath)).toEqual(before);
  });

  it("rejects applying a plan after the map revision changes", async () => {
    const plan = await planSingleTile(harness.service, 0);
    const externallyEdited = baseMap();
    externallyEdited.externalOwnerField = "changed after planning";
    await writeJson(join(harness.root, MAP_PATH), externallyEdited);

    await expect(harness.service.applyEdits(plan)).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "REVISION_CONFLICT",
      details: {
        path: MAP_PATH,
        expectedRevision: plan.baseRevision,
        actualRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
    const saved = JSON.parse(
      await readFile(join(harness.root, MAP_PATH), "utf8"),
    ) as JsonObject;
    expect(saved.externalOwnerField).toBe("changed after planning");
  });

  it("rejects applying a plan after its external tileset dependency changes", async () => {
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const before = await readFile(absoluteMapPath);
    const plan = await planSingleTile(harness.service, 0);
    const changedTileset = baseTileset();
    changedTileset.vendorTilesetExtension = {
      preserved: true,
      externallyChanged: true,
    };
    await writeJson(join(harness.root, TILESET_PATH), changedTileset);

    await expect(harness.service.applyEdits(plan)).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        expectedCount: 1,
        actualCount: 1,
        differences: [
          {
            assetId: expect.stringMatching(/^asset_/),
            expectedRevision: expect.stringMatching(/^sha256:/),
            actualRevision: expect.stringMatching(/^sha256:/),
          },
        ],
      },
    });
    expect(await readFile(absoluteMapPath)).toEqual(before);
  });

  it.each([-1, 4])(
    "rejects local tile id %i outside the atlas bounds",
    async (localId) => {
      const assetId = await getAssetId(harness.service);
      await expect(
        harness.service.planEdits(
          MAP_PATH,
          await getMapRevision(harness.service),
          await getDependencyRevisions(harness.service),
          [
            {
              type: "setTiles",
              layerId: LAYER_ID,
              cells: [
                {
                  x: 0,
                  y: 0,
                  tile: {
                    tileset: { kind: "external", assetId },
                    localId,
                  },
                },
              ],
            },
          ],
        ),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "TILE_ID_OUT_OF_RANGE",
        details: { tilesetAssetId: assetId, localId, tileCount: 4 },
      });
    },
  );

  it("refuses to overwrite an existing map during creation", async () => {
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const before = await readFile(absoluteMapPath);

    await expect(
      harness.service.createMap({
        mapPath: MAP_PATH,
        width: 10,
        height: 8,
        tileWidth: 32,
        tileHeight: 32,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "FILE_ALREADY_EXISTS",
    });
    expect(await readFile(absoluteMapPath)).toEqual(before);
  });

  it.each([
    {
      field: "width",
      value: 100_001,
      limit: 100_000,
    },
    {
      field: "height",
      value: 100_001,
      limit: 100_000,
    },
    {
      field: "tileWidth",
      value: 16_385,
      limit: 16_384,
    },
    {
      field: "tileHeight",
      value: 16_385,
      limit: 16_384,
    },
  ] as const)(
    "enforces the create-map $field domain limit below the MCP schema",
    async ({ field, value, limit }) => {
      const mapPath =
        `maps/invalid-${field}.tmj`;
      await expect(
        harness.service.createMap({
          mapPath,
          width: 2,
          height: 2,
          tileWidth: 16,
          tileHeight: 16,
          [field]: value,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        details: {
          option: field,
          limit,
          actual: value,
        },
      });
      await expect(
        readFile(
          join(harness.root, mapPath),
        ),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("accepts the exact create-map dimension and tile-size limits", async () => {
    const mapPath =
      "maps/create-limits.tmj";
    const result =
      await harness.service.createMap({
        mapPath,
        width: 100_000,
        height: 100_000,
        tileWidth: 16_384,
        tileHeight: 16_384,
      });

    expect(result).toMatchObject({
      path: mapPath,
      beforeRevision: null,
      changed: true,
    });
    expect(
      JSON.parse(
        await readFile(
          join(harness.root, mapPath),
          "utf8",
        ),
      ),
    ).toMatchObject({
      width: 100_000,
      height: 100_000,
      tilewidth: 16_384,
      tileheight: 16_384,
      layers: [],
      tilesets: [],
    });
  });

  it("validates the supported fixture and reports actionable diagnostics for an invalid map", async () => {
    const valid = await harness.service.validate(MAP_PATH);
    expect(valid).toMatchObject({
      path: MAP_PATH,
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      valid: true,
      diagnostics: [],
    });

    const invalidPath = "maps/invalid.tmj";
    await writeJson(join(harness.root, invalidPath), {
      type: "not-a-map",
      orientation: "hexagonal",
      infinite: true,
      width: 2,
      height: 2,
      layers: [
        {
          id: 3,
          type: "tilelayer",
          width: 2,
          height: 2,
          data: [1, 2, 3],
        },
        { id: 3, type: "objectgroup", objects: [] },
      ],
      tilesets: [],
    });

    const invalid = await harness.service.validate(invalidPath);
    expect(invalid.valid).toBe(false);
    expect(invalid.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "MAP_TYPE_INVALID",
        "ORIENTATION_UNSUPPORTED",
        "INFINITE_MAP_UNSUPPORTED",
        "TILE_DATA_LENGTH_INVALID",
        "LAYER_ID_DUPLICATE",
      ]),
    );
    expect(invalid.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TILE_DATA_LENGTH_INVALID",
          severity: "error",
          jsonPointer: "/layers/0/data",
        }),
      ]),
    );
  });

  it("accepts a resolvable transformed GID on a nested tile object", async () => {
    const map = baseMap();
    map.layers = [
      {
        id: 10,
        type: "group",
        layers: [
          {
            id: 11,
            type: "objectgroup",
            objects: [
              {
                id: 3,
                gid:
                  FLAGGED_LOCAL_ID_TWO,
              },
            ],
          },
        ],
      },
    ];
    map.nextlayerid = 12;
    map.nextobjectid = 4;
    await writeJson(
      join(harness.root, MAP_PATH),
      map,
    );

    await expect(
      harness.service.validate(MAP_PATH),
    ).resolves.toMatchObject({
      path: MAP_PATH,
      valid: true,
      diagnostics: [],
    });
  });

  it("validates tile-object GID syntax, flags and referenced tileset range", async () => {
    const map = baseMap();
    map.layers = [
      {
        id: 10,
        type: "group",
        layers: [
          {
            id: 11,
            type: "objectgroup",
            objects: [
              {
                id: 3,
                gid: "1",
              },
              {
                id: 4,
                gid:
                  GID_FLIP_HORIZONTAL,
              },
              {
                id: 5,
                gid: 5,
              },
            ],
          },
        ],
      },
    ];
    map.nextlayerid = 12;
    map.nextobjectid = 6;
    await writeJson(
      join(harness.root, MAP_PATH),
      map,
    );

    const result =
      await harness.service.validate(MAP_PATH);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "GID_INVALID",
          severity: "error",
          jsonPointer:
            "/layers/0/layers/0/objects/0/gid",
        }),
        expect.objectContaining({
          code: "INVALID_GID",
          severity: "error",
          jsonPointer:
            "/layers/0/layers/0/objects/1/gid",
        }),
        expect.objectContaining({
          code: "GID_OUT_OF_RANGE",
          severity: "error",
          jsonPointer:
            "/layers/0/layers/0/objects/2/gid",
        }),
      ]),
    );
  });

  it("rejects render dependencies that escape the project sandbox", async () => {
    const unsafe = baseMap();
    const layers = unsafe.layers as JsonObject[];
    layers.push({
      id: 9,
      name: "Outside image",
      type: "imagelayer",
      image: "../../outside.png",
    });
    unsafe.nextlayerid = 10;
    await writeJson(join(harness.root, MAP_PATH), unsafe);

    await expect(harness.service.assertRenderSafe(MAP_PATH)).rejects.toMatchObject({
      code: "EXTERNAL_REFERENCE_NOT_ALLOWED",
    });
  });

  it("validates field types and malformed group layers instead of treating them as finite", async () => {
    const invalidPath = "maps/invalid-fields.tmj";
    const invalid = baseMap();
    invalid.infinite = "yes";
    delete invalid.tileheight;
    invalid.layers = [{ id: 1, type: "group", layers: "not-an-array" }];
    invalid.nextlayerid = 1;
    await writeJson(join(harness.root, invalidPath), invalid);

    const result = await harness.service.validate(invalidPath);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INFINITE_FLAG_INVALID",
          jsonPointer: "/infinite",
        }),
        expect.objectContaining({
          code: "POSITIVE_INTEGER_REQUIRED",
          jsonPointer: "/tileheight",
        }),
        expect.objectContaining({
          code: "GROUP_LAYERS_INVALID",
          jsonPointer: "/layers/0/layers",
        }),
        expect.objectContaining({
          code: "NEXT_LAYER_ID_INVALID",
          jsonPointer: "/nextlayerid",
        }),
      ]),
    );
  });
});

interface DocumentReadHookContext {
  path: string;
  readCount: number;
  snapshot: DocumentSnapshot;
}

type DocumentReadHook = (
  context: DocumentReadHookContext,
) => void | Promise<void>;

class HookedDocumentStore extends DocumentStore {
  private readonly readCounts = new Map<string, number>();

  constructor(
    resolver: ProjectPathResolver,
    private readonly afterRead: DocumentReadHook,
  ) {
    super(resolver);
  }

  override async readSnapshot(
    projectPath: string,
  ): Promise<DocumentSnapshot> {
    const snapshot =
      await super.readSnapshot(projectPath);
    const readCount =
      (this.readCounts.get(snapshot.path) ?? 0) + 1;
    this.readCounts.set(snapshot.path, readCount);
    await this.afterRead({
      path: snapshot.path,
      readCount,
      snapshot,
    });
    return snapshot;
  }
}

class InflatedDependencySizeStore extends DocumentStore {
  readonly readPaths: string[] = [];

  override async readSnapshot(
    projectPath: string,
  ): Promise<DocumentSnapshot> {
    const snapshot =
      await super.readSnapshot(projectPath);
    this.readPaths.push(snapshot.path);
    return snapshot.path.endsWith(".tsj")
      ? {
          ...snapshot,
          size: 34 * 1024 * 1024,
        }
      : snapshot;
  }
}

async function createServiceWithReadHook(
  root: string,
  afterRead: DocumentReadHook,
): Promise<MapService> {
  const resolver = await ProjectPathResolver.create(root);
  return new MapService(
    resolver,
    new HookedDocumentStore(resolver, afterRead),
  );
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "tiledmcp-map-service-"));
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeJson(join(root, MAP_PATH), baseMap());
  await writeJson(join(root, TILESET_PATH), baseTileset());
  await writeFile(
    join(root, "tiles", "terrain.png"),
    Buffer.from("placeholder image bytes", "utf8"),
  );
  const resolver = await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  return { root, store, service: new MapService(resolver, store) };
}

async function persistAssetIdentities(
  service: MapService,
  summary: Record<string, unknown>,
): Promise<void> {
  // Identity evidence persists only on write-tool paths; a no-op apply
  // records the currently observed identities without changing any bytes.
  const plan = await service.planEdits(
    MAP_PATH,
    summary.revision as string,
    summary.dependencyRevisions as Record<
      string,
      string
    >,
    [
      {
        type: "updateMap",
        patch: { renderOrder: "right-down" },
      },
    ],
  );
  await service.applyEdits(plan);
}

function baseMap(): JsonObject {
  return {
    compressionlevel: -1,
    height: 3,
    infinite: false,
    layers: [
      {
        data: [
          0,
          1,
          FLAGGED_LOCAL_ID_TWO,
          0,
          4,
          0,
          0,
          0,
          0,
          0,
          0,
          4,
        ],
        height: 3,
        id: LAYER_ID,
        name: "Ground",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 4,
        x: 0,
        y: 0,
        vendorLayerExtension: {
          preserve: ["layer", 17],
        },
      },
      {
        id: OBJECT_LAYER_ID,
        name: "Gameplay Objects",
        type: "objectgroup",
        visible: true,
        opacity: 1,
        objects: [
          {
            height: 9,
            id: 1,
            name: "Crate",
            rotation: 15,
            type: "Collision",
            visible: true,
            width: 8,
            x: 4,
            y: 5,
            opacity: 0.75,
            vendorObjectExtension: {
              preserve: ["object", 1],
            },
          },
          {
            height: 0,
            id: 2,
            name: "Spawn",
            point: true,
            rotation: 0,
            type: "Marker",
            visible: false,
            width: 0,
            x: 30,
            y: 31,
            vendorPointExtension: {
              preserve: true,
            },
          },
        ],
        vendorObjectLayerExtension: {
          preserve: "object-layer-field",
        },
      },
    ],
    nextlayerid: 9,
    nextobjectid: 3,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [{ firstgid: 1, source: "../tiles/terrain.tsj" }],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 4,
    vendorExtension: {
      preserve: true,
      nested: { future: "root-field" },
    },
  };
}

function baseTileset(): JsonObject {
  return {
    columns: 2,
    image: "terrain.png",
    imageheight: 32,
    imagewidth: 32,
    margin: 0,
    name: "Terrain",
    spacing: 0,
    tilecount: 4,
    tileheight: 16,
    tilewidth: 16,
    tiledversion: "1.12.2",
    type: "tileset",
    version: "1.10",
    vendorTilesetExtension: { preserved: true },
  };
}

async function writeJson(path: string, document: JsonObject): Promise<void> {
  await writeFile(path, serializeJsonDocument(document));
}

async function terrainPng(firstTileColor: string): Promise<Buffer> {
  return sharp(
    Buffer.from(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">',
        `<rect width="16" height="16" x="0" y="0" fill="${firstTileColor}"/>`,
        '<rect width="16" height="16" x="16" y="0" fill="#8f6b3f"/>',
        '<rect width="16" height="16" x="0" y="16" fill="#467aa3"/>',
        '<rect width="16" height="16" x="16" y="16" fill="#d2bf72"/>',
        "</svg>",
      ].join(""),
      "utf8",
    ),
  )
    .png()
    .toBuffer();
}

async function getAssetId(service: MapService): Promise<string> {
  const summary = await service.getSummary(MAP_PATH);
  const tilesets = summary.tilesets as SummaryTileset[];
  const assetId = tilesets[0]?.assetId;
  if (!assetId) {
    throw new Error("Expected the fixture map to expose one tileset.");
  }
  return assetId;
}

async function getMapRevision(service: MapService): Promise<string> {
  const summary = await service.getSummary(MAP_PATH);
  return summary.revision as string;
}

async function getDependencyRevisions(
  service: MapService,
): Promise<Record<string, string>> {
  const summary = await service.getSummary(MAP_PATH);
  return summary.dependencyRevisions as Record<string, string>;
}

async function planSingleTile(
  service: MapService,
  localId: number,
): Promise<MapEditPlan> {
  const assetId = await getAssetId(service);
  const tile: TileRef = {
    tileset: { kind: "external", assetId },
    localId,
  };
  return service.planEdits(
    MAP_PATH,
    await getMapRevision(service),
    await getDependencyRevisions(service),
    [
      {
        type: "setTiles",
        layerId: LAYER_ID,
        cells: [{ x: 0, y: 0, tile }],
      },
    ],
  );
}

function maskJsonValues(source: string, paths: readonly JSONPath[]): string {
  const hasBom = source.charCodeAt(0) === 0xfeff;
  let body = hasBom ? source.slice(1) : source;
  const tree = parseTree(body, [], {
    allowTrailingComma: false,
    disallowComments: true,
    allowEmptyContent: false,
  });
  if (tree === undefined) {
    throw new Error("Expected a valid JSON fixture.");
  }

  const ranges = paths.map((path) => {
    const node = findNodeAtLocation(tree, path);
    if (node === undefined) {
      throw new Error(`Missing JSON fixture path ${JSON.stringify(path)}.`);
    }
    return {
      offset: node.offset,
      length: node.length,
      marker: `<masked:${JSON.stringify(path)}>`,
    };
  });
  ranges.sort((left, right) => right.offset - left.offset);
  for (const range of ranges) {
    body =
      body.slice(0, range.offset) +
      range.marker +
      body.slice(range.offset + range.length);
  }
  return `${hasBom ? "\uFEFF" : ""}${body}`;
}
