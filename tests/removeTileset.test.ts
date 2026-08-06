import { execFile } from "node:child_process";
import { wireProject } from "./support/project.js";
import {
  TILED_CLI_ENV,
  hasTiledCli,
  TILED_CLI_PATH,
} from "./support/tiledCli.js";
import { createHash } from "node:crypto";
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

import {
  findNodeAtLocation,
  parseTree,
  type JSONPath,
} from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";

import { ChangeSetRegistry } from "../src/changeSets.js";
import {
  serializeJsonDocument,
  stableJson,
  type JsonObject,
  type JsonValue,
} from "../src/formats/json.js";
import {
  GID_DIAGONAL_OR_HEX_60,
  GID_FLIP_HORIZONTAL,
  GID_FLIP_VERTICAL,
  GID_HEX_120,
} from "../src/maps/gid.js";
import { MapService } from "../src/maps/mapService.js";
import type {
  MapEditOperation,
  MapEditPlan,
  RemoveTilesetFromMapOperation,
} from "../src/maps/types.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/level.tmj";
const ROOT_TILE_LAYER_ID = 1;
const GROUP_LAYER_ID = 2;
const NESTED_TILE_LAYER_ID = 3;
const OBJECT_LAYER_ID = 4;

const TILESET_SPECS = [
  {
    path: "tiles/first.tsj",
    imagePath: "tiles/first.svg",
    imageSource: "first.svg",
    name: "First",
    firstGid: 1,
  },
  {
    path: "tiles/middle.tsj",
    imagePath: "tiles/middle.svg",
    imageSource: "middle.svg",
    name: "Middle",
    firstGid: 5,
  },
  {
    path: "tiles/third.tsj",
    imagePath: "tiles/third.svg",
    imageSource: "third.svg",
    name: "Third",
    firstGid: 9,
  },
  {
    path: "tiles/last.tsj",
    imagePath: "tiles/last.svg",
    imageSource: "last.svg",
    name: "Last",
    firstGid: 13,
  },
  {
    path: "tiles/extra.tsj",
    imagePath: "tiles/extra.svg",
    imageSource: "extra.svg",
    name: "Extra",
    firstGid: 17,
  },
] as const;

const REFERENCED_TILESET_PATHS = TILESET_SPECS.slice(0, 4).map(
  ({ path }) => path,
);
const TARGET_TILESET_PATH = TILESET_SPECS[1].path;
const EXTRA_TILESET_PATH = TILESET_SPECS[4].path;

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
  gidSpan: number;
  revision: string;
}

interface MapSnapshot {
  revision: string;
  dependencies: Record<string, string>;
  tilesets: SummaryTileset[];
}

describe("removeTilesetFromMap", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it.each([
    {
      label: "first",
      targetPath: TILESET_SPECS[0].path,
      expectedFirstGids: [5, 9, 13],
      expectedIndex: 0,
    },
    {
      label: "middle",
      targetPath: TILESET_SPECS[1].path,
      expectedFirstGids: [1, 9, 13],
      expectedIndex: 1,
    },
    {
      label: "last",
      targetPath: TILESET_SPECS[3].path,
      expectedFirstGids: [1, 5, 9],
      expectedIndex: 3,
    },
    {
      label: "only",
      targetPath: TILESET_SPECS[0].path,
      expectedFirstGids: [],
      expectedIndex: 0,
      only: true,
    },
  ])(
    "removes the $label unused reference without renumbering another firstgid",
    async ({
      targetPath,
      expectedFirstGids,
      expectedIndex,
      only,
    }) => {
      const harness = await createHarness(
        roots,
        only === true
          ? baseMap([TILESET_SPECS[0].path])
          : baseMap(),
      );
      const snapshot = await mapSnapshot(harness.service);
      const target = requireSummaryTileset(
        snapshot,
        targetPath,
      );
      const targetSource = referenceSource(targetPath);
      const plan = await planRemoval(
        harness.service,
        targetPath,
        snapshot,
      );

      expect(plan.operations).toEqual([
        {
          type: "removeTilesetFromMap",
          tilesetAssetId: target.assetId,
        },
      ]);
      expect(plan.summary).toMatchObject({
        operationCount: 1,
        cellWrites: 0,
        affectedLayerIds: [],
        affectedTileLayerIds: [],
        affectedObjectLayerIds: [],
        createdObjectIds: [],
        updatedObjectIds: [],
        deletedObjectIds: [],
        removedTilesets: [
          {
            operationIndex: 0,
            assetId: target.assetId,
            tilesetPath: target.path,
            source: targetSource,
            tilesetRevision: target.revision,
            name: target.name,
            nameTruncated: false,
            index: expectedIndex,
            tileCount: 4,
            gidSpan: 4,
            firstGid: target.firstGid,
            lastGid: target.firstGid + 3,
            scannedCellCount: 5,
            scannedObjectCount: 1,
          },
        ],
      });

      const preview = new ChangeSetRegistry().put(plan);
      expect(preview.operations).toEqual([
        expect.objectContaining({
          type: "removeTilesetFromMap",
          destructive: true,
          warning: expect.any(String),
          tileset: expect.objectContaining({
            kind: "external",
            assetId: target.assetId,
            path: target.path,
            revision: target.revision,
            name: target.name,
            tileCount: 4,
            gidSpan: 4,
          }),
          source: targetSource,
          index: expectedIndex,
          gidRange: {
            first: target.firstGid,
            last: target.firstGid + 3,
          },
          scanned: {
            tileCells: 5,
            objects: 1,
          },
        }),
      ]);

      const targetBytes = await readFile(
        join(harness.root, targetPath),
      );
      const result =
        await harness.service.applyEdits(plan);
      const saved = await readMap(harness.root);

      expect(result).toMatchObject({
        path: MAP_PATH,
        changed: true,
        changeSetId: plan.id,
      });
      expect(
        (saved.tilesets as JsonObject[]).map(
          ({ firstgid }) => firstgid,
        ),
      ).toEqual(expectedFirstGids);
      expect(
        (saved.tilesets as JsonObject[]).some(
          ({ source }) => source === targetSource,
        ),
      ).toBe(false);
      expect(await readFile(join(harness.root, targetPath))).toEqual(
        targetBytes,
      );

      const after = await mapSnapshot(harness.service);
      expect(after.tilesets.map(({ path }) => path)).not.toContain(
        targetPath,
      );
      expect(after.dependencies).not.toHaveProperty(
        target.assetId,
      );
    },
  );

  it("accepts exactly 1,000,000 total scans and rejects one additional object", async () => {
    const exactMap = baseMap();
    const rootLayer = requireLayer(
      exactMap,
      ROOT_TILE_LAYER_ID,
    );
    const groupLayer = requireLayer(
      exactMap,
      GROUP_LAYER_ID,
    );
    const objectLayer = requireLayer(
      exactMap,
      OBJECT_LAYER_ID,
    );
    rootLayer.width = 999_998;
    rootLayer.height = 1;
    rootLayer.data = new Array<JsonValue>(
      999_998,
    ).fill(0);
    exactMap.width = 999_998;
    exactMap.height = 1;
    exactMap.layers = [
      objectLayer,
      groupLayer,
      rootLayer,
    ];
    const harness = await createHarness(
      roots,
      exactMap,
      { compactMap: true },
    );

    const exactPlan = await planRemoval(
      harness.service,
      TARGET_TILESET_PATH,
    );
    expect(
      exactPlan.summary.removedTilesets,
    ).toEqual([
      expect.objectContaining({
        scannedCellCount: 999_999,
        scannedObjectCount: 1,
      }),
    ]);

    const overMap = structuredClone(exactMap);
    const overObjectLayer = requireLayer(
      overMap,
      OBJECT_LAYER_ID,
    );
    (overObjectLayer.objects as JsonObject[]).push({
      height: 8,
      id: 2,
      name: "One scan over budget",
      rotation: 0,
      type: "",
      visible: true,
      width: 8,
      x: 3,
      y: 3,
    });
    overMap.nextobjectid = 3;
    await writeFile(
      join(harness.root, MAP_PATH),
      JSON.stringify(overMap),
      "utf8",
    );

    await expect(
      planRemoval(
        harness.service,
        TARGET_TILESET_PATH,
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        limit: 1_000_000,
      },
    });
  }, 20_000);

  it("reports the first target reference before a later layer can exhaust the scan budget", async () => {
    const map = baseMap();
    const rootLayer = requireLayer(
      map,
      ROOT_TILE_LAYER_ID,
    );
    rootLayer.width = 1;
    rootLayer.height = 1;
    rootLayer.data = [
      TILESET_SPECS[1].firstGid,
    ];
    const nestedLayer = requireLayer(
      map,
      NESTED_TILE_LAYER_ID,
    );
    nestedLayer.width = 1_000_001;
    nestedLayer.height = 1;
    nestedLayer.data = new Array<JsonValue>(
      1_000_001,
    ).fill(0);
    const harness = await createHarness(
      roots,
      map,
      { compactMap: true },
    );

    await expect(
      planRemoval(
        harness.service,
        TARGET_TILESET_PATH,
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "TILESET_IN_USE",
      details: {
        scanStoppedAtFirstReference: true,
        scannedCellCount: 1,
        scannedObjectCount: 0,
      },
    });
  }, 20_000);

  it.each([
    {
      label: "plain tile cell",
      mutate: (map: JsonObject, firstGid: number) => {
        requireLayer(map, ROOT_TILE_LAYER_ID).data = [
          firstGid,
          0,
          0,
          0,
        ];
      },
    },
    {
      label: "transformed tile cell",
      mutate: (map: JsonObject, firstGid: number) => {
        requireLayer(map, ROOT_TILE_LAYER_ID).data = [
          (
            GID_FLIP_HORIZONTAL |
            GID_FLIP_VERTICAL |
            GID_DIAGONAL_OR_HEX_60 |
            firstGid
          ) >>> 0,
          0,
          0,
          0,
        ];
      },
    },
    {
      label: "nested hidden locked tile cell",
      mutate: (map: JsonObject, firstGid: number) => {
        requireLayer(map, NESTED_TILE_LAYER_ID).data = [
          firstGid,
        ];
      },
    },
    {
      label: "tile object",
      mutate: (map: JsonObject, firstGid: number) => {
        const layer = requireLayer(map, OBJECT_LAYER_ID);
        const objects = layer.objects as JsonObject[];
        objects.push({
          gid:
            (GID_FLIP_HORIZONTAL | firstGid) >>> 0,
          height: 16,
          id: 2,
          name: "Target tile object",
          rotation: 0,
          type: "",
          visible: true,
          width: 16,
          x: 16,
          y: 16,
        });
        map.nextobjectid = 3;
      },
    },
  ])(
    "rejects removal while the target is referenced by a $label",
    async ({ mutate }) => {
      const map = baseMap();
      mutate(map, TILESET_SPECS[1].firstGid);
      const harness = await createHarness(roots, map);
      const mapPath = join(harness.root, MAP_PATH);
      const before = await readFile(mapPath);

      await expect(
        planRemoval(
          harness.service,
          TARGET_TILESET_PATH,
        ),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "TILESET_IN_USE",
      });
      expect(await readFile(mapPath)).toEqual(before);
    },
  );

  it("allows and preserves a valid non-target GID carrying every raw flag", async () => {
    const map = baseMap();
    const allFlagsNonTargetGid =
      (
        GID_FLIP_HORIZONTAL |
        GID_FLIP_VERTICAL |
        GID_DIAGONAL_OR_HEX_60 |
        GID_HEX_120 |
        TILESET_SPECS[0].firstGid
      ) >>> 0;
    requireLayer(map, ROOT_TILE_LAYER_ID).data = [
      allFlagsNonTargetGid,
      0,
      0,
      0,
    ];
    const harness = await createHarness(roots, map);
    const plan = await planRemoval(
      harness.service,
      TARGET_TILESET_PATH,
    );
    await harness.service.applyEdits(plan);

    const saved = await readMap(harness.root);
    expect(
      (requireLayer(
        saved,
        ROOT_TILE_LAYER_ID,
      ).data as JsonValue[])[0],
    ).toBe(allFlagsNonTargetGid);
  });

  it.each([
    {
      label: "gap base GID",
      expectedCode: "GID_OUT_OF_RANGE",
      targetPath: TILESET_SPECS[3].path,
      mutate: (map: JsonObject) => {
        map.tilesets = (
          map.tilesets as JsonObject[]
        ).filter(
          ({ source }) =>
            source !==
            referenceSource(
              TILESET_SPECS[1].path,
            ),
        );
        requireLayer(
          map,
          ROOT_TILE_LAYER_ID,
        ).data = [5, 0, 0, 0];
      },
    },
    {
      label: "non-integer cell GID",
      expectedCode: "INVALID_TILE_DATA",
      targetPath: TARGET_TILESET_PATH,
      mutate: (map: JsonObject) => {
        requireLayer(
          map,
          ROOT_TILE_LAYER_ID,
        ).data = [1.5, 0, 0, 0];
      },
    },
    {
      label: "negative cell GID",
      expectedCode: "INVALID_TILE_DATA",
      targetPath: TARGET_TILESET_PATH,
      mutate: (map: JsonObject) => {
        requireLayer(
          map,
          ROOT_TILE_LAYER_ID,
        ).data = [-1, 0, 0, 0];
      },
    },
    {
      label: "greater-than-uint32 cell GID",
      expectedCode: "INVALID_TILE_DATA",
      targetPath: TARGET_TILESET_PATH,
      mutate: (map: JsonObject) => {
        requireLayer(
          map,
          ROOT_TILE_LAYER_ID,
        ).data = [
          0x1_0000_0000,
          0,
          0,
          0,
        ];
      },
    },
    {
      label: "flag-only zero cell GID",
      expectedCode: "INVALID_GID",
      targetPath: TARGET_TILESET_PATH,
      mutate: (map: JsonObject) => {
        requireLayer(
          map,
          ROOT_TILE_LAYER_ID,
        ).data = [
          GID_FLIP_HORIZONTAL,
          0,
          0,
          0,
        ];
      },
    },
    {
      label: "non-integer object GID",
      expectedCode: "INVALID_TILE_DATA",
      targetPath: TARGET_TILESET_PATH,
      mutate: (map: JsonObject) => {
        const object = (
          requireLayer(
            map,
            OBJECT_LAYER_ID,
          ).objects as JsonObject[]
        )[0];
        if (object === undefined) {
          throw new Error(
            "Expected the fixture object.",
          );
        }
        object.gid = 1.5;
      },
    },
    {
      label: "template object with a potentially hidden tile GID",
      expectedCode:
        "UNSUPPORTED_TILESET_REMOVAL_TEMPLATE",
      targetPath: TARGET_TILESET_PATH,
      mutate: (map: JsonObject) => {
        const object = (
          requireLayer(
            map,
            OBJECT_LAYER_ID,
          ).objects as JsonObject[]
        )[0];
        if (object === undefined) {
          throw new Error(
            "Expected the fixture object.",
          );
        }
        object.template =
          "../templates/tile.tx";
      },
    },
  ])(
    "fails closed on an observed $label even when it does not resolve to the target",
    async ({
      expectedCode,
      targetPath,
      mutate,
    }) => {
      const map = baseMap();
      mutate(map);
      const harness = await createHarness(roots, map);
      const mapPath = join(harness.root, MAP_PATH);
      const before = await readFile(mapPath);

      await expect(
        planRemoval(
          harness.service,
          targetPath,
        ),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: expectedCode,
      });
      expect(await readFile(mapPath)).toEqual(before);
    },
  );

  it("counts and preserves an object-only scan with no tile cells", async () => {
    const map = baseMap();
    const objectLayer = requireLayer(
      map,
      OBJECT_LAYER_ID,
    );
    const allFlagsNonTargetGid =
      (
        GID_FLIP_HORIZONTAL |
        GID_FLIP_VERTICAL |
        GID_DIAGONAL_OR_HEX_60 |
        GID_HEX_120 |
        TILESET_SPECS[0].firstGid
      ) >>> 0;
    objectLayer.objects = [
      ...(objectLayer.objects as JsonObject[]),
      {
        gid: allFlagsNonTargetGid,
        height: 16,
        id: 2,
        name: "Flagged non-target tile",
        rotation: 0,
        type: "",
        visible: true,
        width: 16,
        x: 16,
        y: 16,
      },
      {
        height: 0,
        id: 3,
        name: "Point",
        point: true,
        rotation: 0,
        type: "",
        visible: true,
        width: 0,
        x: 8,
        y: 8,
      },
    ];
    map.layers = [objectLayer];
    map.nextobjectid = 4;
    const expectedObjects = structuredClone(
      objectLayer.objects,
    );
    const harness = await createHarness(roots, map);

    const plan = await planRemoval(
      harness.service,
      TARGET_TILESET_PATH,
    );
    expect(
      plan.summary.removedTilesets,
    ).toEqual([
      expect.objectContaining({
        scannedCellCount: 0,
        scannedObjectCount: 3,
      }),
    ]);
    await harness.service.applyEdits(plan);

    expect(
      requireLayer(
        await readMap(harness.root),
        OBJECT_LAYER_ID,
      ).objects,
    ).toEqual(expectedObjects);
  });

  it("requires strict keys, a canonical known asset id and an exclusive change set", async () => {
    const harness = await createHarness(roots);
    const snapshot = await mapSnapshot(harness.service);
    const target = requireSummaryTileset(
      snapshot,
      TARGET_TILESET_PATH,
    );

    const malformed: unknown[] = [
      {
        type: "removeTilesetFromMap",
        tilesetAssetId: target.assetId,
        extra: true,
      },
      {
        type: "removeTilesetFromMap",
      },
      {
        type: "removeTilesetFromMap",
        tilesetAssetId: "",
      },
      {
        type: "removeTilesetFromMap",
        tilesetAssetId: "middle.tsj",
      },
      {
        type: "removeTilesetFromMap",
        tilesetAssetId: 17,
      },
    ];
    for (const operation of malformed) {
      await expect(
        harness.service.planEdits(
          MAP_PATH,
          snapshot.revision,
          snapshot.dependencies,
          [operation as MapEditOperation],
        ),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "INVALID_ARGUMENT",
      });
    }

    await expect(
      harness.service.planEdits(
        MAP_PATH,
        snapshot.revision,
        snapshot.dependencies,
        [
          {
            type: "removeTilesetFromMap",
            tilesetAssetId:
              "asset_000000000000000000000000",
          },
        ],
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "TILESET_NOT_FOUND",
    });

    await expect(
      harness.service.planEdits(
        MAP_PATH,
        snapshot.revision,
        snapshot.dependencies,
        [
          {
            type: "removeTilesetFromMap",
            tilesetAssetId: target.assetId,
          },
          {
            type: "updateMap",
            patch: { className: "Mixed operation" },
          },
        ],
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
    });
  });

  it("rejects stale-digest summary tampering plus duplicate or injected removal summaries", async () => {
    const harness = await createHarness(roots);
    const snapshot = await mapSnapshot(harness.service);
    const removalPlan = await planRemoval(
      harness.service,
      TARGET_TILESET_PATH,
      snapshot,
    );
    const staleDigestMutations: Array<{
      label: string;
      mutate: (
        summary: NonNullable<
          MapEditPlan["summary"]["removedTilesets"]
        >[number],
      ) => void;
    }> = [
      {
        label: "path",
        mutate: (summary) => {
          summary.tilesetPath =
            "tiles/forged.tsj";
        },
      },
      {
        label: "index",
        mutate: (summary) => {
          summary.index += 1;
        },
      },
      {
        label: "scan count",
        mutate: (summary) => {
          summary.scannedCellCount += 1;
        },
      },
    ];
    for (const {
      label,
      mutate,
    } of staleDigestMutations) {
      const tampered = structuredClone(removalPlan);
      mutate(requireRemovalSummary(tampered));
      expect(
        () =>
          new ChangeSetRegistry().put(tampered),
        label,
      ).toThrow(/digest/u);
    }

    const duplicate = structuredClone(removalPlan);
    const duplicateSummary =
      requireRemovalSummary(duplicate);
    duplicate.summary.removedTilesets?.push(
      structuredClone(duplicateSummary),
    );
    refreshPlanDigest(duplicate);
    expect(() =>
      new ChangeSetRegistry().put(duplicate),
    ).toThrow(/summaries do not match/u);

    const updatePlan =
      await harness.service.planEdits(
        MAP_PATH,
        snapshot.revision,
        snapshot.dependencies,
        [
          {
            type: "updateMap",
            patch: {
              className:
                "Injected removal summary",
            },
          },
        ],
      );
    updatePlan.summary.removedTilesets = [
      structuredClone(
        requireRemovalSummary(removalPlan),
      ),
    ];
    refreshPlanDigest(updatePlan);
    expect(() =>
      new ChangeSetRegistry().put(updatePlan),
    ).toThrow(/summaries do not match/u);
  });

  it("deletes the original serialized index from unsorted tileset references without renumbering survivors", async () => {
    const map = baseMap();
    const entries = map.tilesets as JsonObject[];
    map.tilesets = [
      entries[2]!,
      entries[0]!,
      entries[3]!,
      entries[1]!,
    ];
    const harness = await createHarness(roots, map);

    const plan = await planRemoval(
      harness.service,
      TARGET_TILESET_PATH,
    );
    expect(plan.summary.removedTilesets).toEqual([
      expect.objectContaining({
        index: 3,
        firstGid: 5,
      }),
    ]);
    await harness.service.applyEdits(plan);

    const saved = await readMap(harness.root);
    const savedEntries =
      saved.tilesets as JsonObject[];
    expect(
      savedEntries.map(({ firstgid }) => firstgid),
    ).toEqual([9, 1, 13]);
    expect(
      savedEntries.map(({ source }) => source),
    ).toEqual([
      referenceSource(TILESET_SPECS[2].path),
      referenceSource(TILESET_SPECS[0].path),
      referenceSource(TILESET_SPECS[3].path),
    ]);
  });

  it("uses one array-element-local deletion and preserves BOM, CRLF and untouched lexemes", async () => {
    const map = baseMap();
    map.vendorRootExtension = {
      futureNumber: 100,
      preserve: ["root", 23],
    };
    const entries = map.tilesets as JsonObject[];
    entries[0]!.vendorReference = {
      escaped: "keep-first",
      futureNumber: 101,
    };
    entries[2]!.vendorReference = {
      escaped: "keep-third",
      futureNumber: 103,
    };
    entries[3]!.vendorReference = {
      escaped: "keep-last",
      futureNumber: 104,
    };
    const harness = await createHarness(roots, map);
    const mapPath = join(harness.root, MAP_PATH);
    const lexicalSource =
      `\uFEFF${serializeJsonDocument(map)
        .toString("utf8")
        .replace(
          '"futureNumber": 100',
          '"futureNumber": 1e+2',
        )
        .replace(
          '"escaped": "keep-first"',
          '"escaped": "\\u006beep-first"',
        )
        .replace(/\n/gu, "\r\n")}`;
    await writeFile(mapPath, lexicalSource, "utf8");

    const before = await readFile(mapPath, "utf8");
    const untouchedFirst = sourceValueAt(before, [
      "tilesets",
      0,
    ]);
    const untouchedThird = sourceValueAt(before, [
      "tilesets",
      2,
    ]);
    const untouchedLast = sourceValueAt(before, [
      "tilesets",
      3,
    ]);
    const untouchedLayers = sourceValueAt(before, [
      "layers",
    ]);
    const untouchedRootExtension = sourceValueAt(before, [
      "vendorRootExtension",
    ]);

    const removalPlan = await planRemoval(
      harness.service,
      TARGET_TILESET_PATH,
    );
    await harness.service.applyEdits(removalPlan);

    const after = await readFile(mapPath, "utf8");
    expect(after.startsWith("\uFEFF")).toBe(true);
    expect(after).toContain("\r\n");
    expect(after).not.toMatch(/(?<!\r)\n/u);
    expect(sourceValueAt(after, ["tilesets", 0])).toBe(
      untouchedFirst,
    );
    expect(sourceValueAt(after, ["tilesets", 1])).toBe(
      untouchedThird,
    );
    expect(sourceValueAt(after, ["tilesets", 2])).toBe(
      untouchedLast,
    );
    expect(sourceValueAt(after, ["layers"])).toBe(
      untouchedLayers,
    );
    expect(
      sourceValueAt(after, ["vendorRootExtension"]),
    ).toBe(untouchedRootExtension);
    expect(after).toContain('"futureNumber": 1e+2');
    expect(after).toContain('"escaped": "\\u006beep-first"');
    expect(after).not.toContain(
      referenceSource(TARGET_TILESET_PATH),
    );
  });

  it("rejects a tampered plan and a stale map without replacing current bytes", async () => {
    const tamperHarness = await createHarness(roots);
    const tampered = structuredClone(
      await planRemoval(
        tamperHarness.service,
        TARGET_TILESET_PATH,
      ),
    );
    const tamperSnapshot = await mapSnapshot(
      tamperHarness.service,
    );
    const other = requireSummaryTileset(
      tamperSnapshot,
      TILESET_SPECS[2].path,
    );
    const operation = tampered.operations[0];
    if (
      operation?.type !== "removeTilesetFromMap"
    ) {
      throw new Error(
        "Expected a removeTilesetFromMap operation.",
      );
    }
    operation.tilesetAssetId = other.assetId;
    const tamperPath = join(
      tamperHarness.root,
      MAP_PATH,
    );
    const beforeTamper = await readFile(tamperPath);

    await expect(
      tamperHarness.service.applyEdits(tampered),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "CHANGE_SET_TAMPERED",
    });
    expect(await readFile(tamperPath)).toEqual(
      beforeTamper,
    );

    const staleHarness = await createHarness(roots);
    const stalePlan = await planRemoval(
      staleHarness.service,
      TARGET_TILESET_PATH,
    );
    const externallyEdited = baseMap();
    externallyEdited.vendorExternalEdit = {
      changedAfterPreview: true,
    };
    const stalePath = join(
      staleHarness.root,
      MAP_PATH,
    );
    await writeJson(stalePath, externallyEdited);
    const externalBytes = await readFile(stalePath);

    await expect(
      staleHarness.service.applyEdits(stalePlan),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "REVISION_CONFLICT",
    });
    expect(await readFile(stalePath)).toEqual(
      externalBytes,
    );
  });

  it.each([
    {
      label: "target",
      changedPath: TARGET_TILESET_PATH,
    },
    {
      label: "another referenced",
      changedPath: TILESET_SPECS[2].path,
    },
  ])(
    "rejects a stale $label TSJ dependency without changing the map",
    async ({ changedPath }) => {
      const harness = await createHarness(roots);
      const removalPlan = await planRemoval(
        harness.service,
        TARGET_TILESET_PATH,
      );
      const mapPath = join(harness.root, MAP_PATH);
      const beforeMap = await readFile(mapPath);
      const changed = tilesetForPath(changedPath);
      const changedDocument = baseTileset(
        changed.name,
        changed.imageSource,
      );
      changedDocument.vendorExternalEdit = {
        changedAfterPreview: true,
      };
      await writeJson(
        join(harness.root, changedPath),
        changedDocument,
      );

      await expect(
        harness.service.applyEdits(removalPlan),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "DEPENDENCY_REVISION_CONFLICT",
      });
      expect(await readFile(mapPath)).toEqual(
        beforeMap,
      );
    },
  );

  it("round-trips add then remove back to the original map semantics without touching unrelated source ranges", async () => {
    const harness = await createHarness(roots);
    const mapPath = join(harness.root, MAP_PATH);
    const beforeMap = await readFile(mapPath);
    const beforeDocument = await readMap(harness.root);
    const beforeSource = beforeMap.toString("utf8");
    const beforeLayers = sourceValueAt(
      beforeSource,
      ["layers"],
    );
    const beforeRootExtension = sourceValueAt(
      beforeSource,
      ["vendorRootExtension"],
    );
    const beforeExtra = await readFile(
      join(harness.root, EXTRA_TILESET_PATH),
    );
    const initial = await mapSnapshot(harness.service);
    const extraRevision =
      await harness.store.readRevision(EXTRA_TILESET_PATH);
    const addPlan =
      await harness.service.planAddTilesetToMap({
        mapPath: MAP_PATH,
        tilesetPath: EXTRA_TILESET_PATH,
        expectedMapRevision: initial.revision,
        expectedDependencyRevisions:
          initial.dependencies,
        expectedTilesetRevision: extraRevision,
      });
    await harness.service.applyEdits(addPlan);

    const afterAdd = await mapSnapshot(
      harness.service,
    );
    const added = requireSummaryTileset(
      afterAdd,
      EXTRA_TILESET_PATH,
    );
    expect(added.firstGid).toBe(17);
    const removePlan =
      await harness.service.planEdits(
        MAP_PATH,
        afterAdd.revision,
        afterAdd.dependencies,
        [
          {
            type: "removeTilesetFromMap",
            tilesetAssetId: added.assetId,
          },
        ],
    );
    await harness.service.applyEdits(removePlan);

    const afterSource = await readFile(
      mapPath,
      "utf8",
    );
    expect(await readMap(harness.root)).toEqual(
      beforeDocument,
    );
    expect(sourceValueAt(afterSource, ["layers"])).toBe(
      beforeLayers,
    );
    expect(
      sourceValueAt(afterSource, [
        "vendorRootExtension",
      ]),
    ).toBe(beforeRootExtension);
    expect(
      await readFile(
        join(harness.root, EXTRA_TILESET_PATH),
      ),
    ).toEqual(beforeExtra);
    const afterRemove = await mapSnapshot(
      harness.service,
    );
    expect(
      afterRemove.tilesets.map(({ path }) => path),
    ).toEqual(initial.tilesets.map(({ path }) => path));
    expect(afterRemove.dependencies).toEqual(
      initial.dependencies,
    );
  });

  it.skipIf(!hasTiledCli)("survives a real Tiled 1.12 JSON export round-trip when the CLI is available", async () => {
    const harness = await createHarness(roots);
    const targetBytes = await readFile(
      join(harness.root, TARGET_TILESET_PATH),
    );
    const removalPlan = await planRemoval(
      harness.service,
      TARGET_TILESET_PATH,
    );
    await harness.service.applyEdits(removalPlan);
    await expect(
      harness.service.validate(MAP_PATH),
    ).resolves.toMatchObject({
      valid: true,
      diagnostics: [],
    });
    const committed = await readMap(harness.root);
    expect(
      (committed.tilesets as JsonObject[]).map(
        ({ firstgid }) => firstgid,
      ),
    ).toEqual([1, 9, 13]);

    const outputPath = join(
      harness.root,
      "maps",
      "roundtrip.tmj",
    );
    await execFileAsync(
      TILED_CLI_PATH,
      [
        "--export-map",
        "json",
        join(harness.root, MAP_PATH),
        outputPath,
      ],
      {
        env: { ...TILED_CLI_ENV },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );

    const exported = JSON.parse(
      await readFile(outputPath, "utf8"),
    ) as JsonObject;
    const exportedReferences =
      exported.tilesets as JsonObject[];
    expect(
      exportedReferences.map(({ firstgid }) => firstgid),
    ).toEqual([1, 5, 9]);
    expect(
      exportedReferences.map(({ source }) => source),
    ).toEqual([
      referenceSource(TILESET_SPECS[0].path),
      referenceSource(TILESET_SPECS[2].path),
      referenceSource(TILESET_SPECS[3].path),
    ]);
    expect(
      await readFile(
        join(harness.root, TARGET_TILESET_PATH),
      ),
    ).toEqual(targetBytes);
  }, 40_000);
});

async function createHarness(
  roots: Set<string>,
  map: JsonObject = baseMap(),
  options: {
    compactMap?: boolean;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-remove-tileset-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  if (options.compactMap === true) {
    await writeFile(
      join(root, MAP_PATH),
      JSON.stringify(map),
      "utf8",
    );
  } else {
    await writeJson(join(root, MAP_PATH), map);
  }

  for (const spec of TILESET_SPECS) {
    await writeJson(
      join(root, spec.path),
      baseTileset(spec.name, spec.imageSource),
    );
    await writeFile(
      join(root, spec.imagePath),
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">',
        `<rect width="32" height="32" fill="${colorForName(spec.name)}"/>`,
        "</svg>",
      ].join(""),
      "utf8",
    );
  }

  const { store, service } =
    await wireProject(root);
  return {
    root,
    store,
    service: service,
  };
}

function baseMap(
  tilesetPaths: readonly string[] =
    REFERENCED_TILESET_PATHS,
): JsonObject {
  return {
    compressionlevel: -1,
    height: 2,
    infinite: false,
    layers: [
      {
        data: [0, 0, 0, 0],
        height: 2,
        id: ROOT_TILE_LAYER_ID,
        name: "Ground",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 2,
        x: 0,
        y: 0,
      },
      {
        id: GROUP_LAYER_ID,
        layers: [
          {
            data: [0],
            height: 1,
            id: NESTED_TILE_LAYER_ID,
            locked: true,
            name: "Hidden Locked Detail",
            opacity: 1,
            type: "tilelayer",
            visible: false,
            width: 1,
            x: 0,
            y: 0,
          },
        ],
        name: "Nested",
        opacity: 1,
        type: "group",
        visible: true,
        x: 0,
        y: 0,
      },
      {
        draworder: "topdown",
        id: OBJECT_LAYER_ID,
        name: "Objects",
        objects: [
          {
            height: 8,
            id: 1,
            name: "Marker",
            rotation: 0,
            type: "",
            visible: true,
            width: 8,
            x: 2,
            y: 2,
          },
        ],
        opacity: 1,
        type: "objectgroup",
        visible: true,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 5,
    nextobjectid: 2,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: tilesetPaths.map((path) => {
      const spec = tilesetForPath(path);
      return {
        firstgid: spec.firstGid,
        source: referenceSource(path),
      };
    }),
    tilewidth: 16,
    type: "map",
    vendorRootExtension: {
      preserve: ["root", 23],
    },
    version: "1.10",
    width: 2,
  };
}

function baseTileset(
  name: string,
  imageSource: string,
): JsonObject {
  return {
    columns: 2,
    image: imageSource,
    imageheight: 32,
    imagewidth: 32,
    margin: 0,
    name,
    spacing: 0,
    tilecount: 4,
    tileheight: 16,
    tilewidth: 16,
    tiledversion: "1.12.2",
    type: "tileset",
    version: "1.10",
  };
}

async function planRemoval(
  service: MapService,
  tilesetPath: string,
  suppliedSnapshot?: MapSnapshot,
): Promise<MapEditPlan> {
  const snapshot =
    suppliedSnapshot ?? (await mapSnapshot(service));
  const target = requireSummaryTileset(
    snapshot,
    tilesetPath,
  );
  const operation: RemoveTilesetFromMapOperation = {
    type: "removeTilesetFromMap",
    tilesetAssetId: target.assetId,
  };
  return service.planEdits(
    MAP_PATH,
    snapshot.revision,
    snapshot.dependencies,
    [operation],
  );
}

function requireRemovalSummary(
  plan: MapEditPlan,
): NonNullable<
  MapEditPlan["summary"]["removedTilesets"]
>[number] {
  const summary =
    plan.summary.removedTilesets?.[0];
  if (summary === undefined) {
    throw new Error(
      "Expected a removed-tileset summary.",
    );
  }
  return summary;
}

function refreshPlanDigest(plan: MapEditPlan): void {
  const unsignedPlan =
    structuredClone(plan) as Partial<MapEditPlan>;
  delete unsignedPlan.id;
  plan.id =
    `changeset:${createHash("sha256")
      .update(
        stableJson(
          unsignedPlan as unknown as JsonValue,
        ),
      )
      .digest("hex")}`;
}

async function mapSnapshot(
  service: MapService,
): Promise<MapSnapshot> {
  const summary = await service.getSummary(MAP_PATH);
  return {
    revision: summary.revision as string,
    dependencies:
      summary.dependencyRevisions as Record<
        string,
        string
      >,
    tilesets: summary.tilesets as SummaryTileset[],
  };
}

function requireSummaryTileset(
  snapshot: MapSnapshot,
  path: string,
): SummaryTileset {
  const tileset = snapshot.tilesets.find(
    (candidate) => candidate.path === path,
  );
  if (tileset === undefined) {
    throw new Error(
      `Expected fixture tileset ${path}.`,
    );
  }
  return tileset;
}

function tilesetForPath(
  path: string,
): (typeof TILESET_SPECS)[number] {
  const spec = TILESET_SPECS.find(
    (candidate) => candidate.path === path,
  );
  if (spec === undefined) {
    throw new Error(`Unknown fixture tileset ${path}.`);
  }
  return spec;
}

function referenceSource(path: string): string {
  const fileName = path.split("/").at(-1);
  if (fileName === undefined) {
    throw new Error(`Invalid fixture path ${path}.`);
  }
  return `../tiles/${fileName}`;
}

function findLayer(
  map: JsonObject,
  layerId: number,
): JsonObject | undefined {
  const pending = [...(map.layers as JsonObject[])];
  while (pending.length > 0) {
    const layer = pending.shift();
    if (layer === undefined) {
      continue;
    }
    if (layer.id === layerId) {
      return layer;
    }
    if (Array.isArray(layer.layers)) {
      pending.push(...(layer.layers as JsonObject[]));
    }
  }
  return undefined;
}

function requireLayer(
  map: JsonObject,
  layerId: number,
): JsonObject {
  const layer = findLayer(map, layerId);
  if (layer === undefined) {
    throw new Error(`Missing fixture layer ${layerId}.`);
  }
  return layer;
}

async function readMap(root: string): Promise<JsonObject> {
  const source = await readFile(
    join(root, MAP_PATH),
    "utf8",
  );
  return JSON.parse(
    source.replace(/^\uFEFF/u, ""),
  ) as JsonObject;
}

async function writeJson(
  path: string,
  document: JsonObject,
): Promise<void> {
  await writeFile(path, serializeJsonDocument(document));
}

function sourceValueAt(
  source: string,
  path: JSONPath,
): string {
  const body =
    source.charCodeAt(0) === 0xfeff
      ? source.slice(1)
      : source;
  const tree = parseTree(body, [], {
    allowTrailingComma: false,
    disallowComments: true,
    allowEmptyContent: false,
  });
  if (tree === undefined) {
    throw new Error("Expected valid JSON source.");
  }
  const node = findNodeAtLocation(tree, path);
  if (node === undefined) {
    throw new Error(
      `Missing JSON source path ${JSON.stringify(path)}.`,
    );
  }
  return body.slice(node.offset, node.offset + node.length);
}

function colorForName(name: string): string {
  const colors: Record<string, string> = {
    First: "#336699",
    Middle: "#669933",
    Third: "#993366",
    Last: "#996633",
    Extra: "#663399",
  };
  return colors[name] ?? "#777777";
}
