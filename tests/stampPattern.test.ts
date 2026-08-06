import { execFile } from "node:child_process";
import { wireProject } from "./support/project.js";
import {
  TILED_CLI_ENV,
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
  type JsonObject,
} from "../src/formats/json.js";
import { GID_FLIP_HORIZONTAL } from "../src/maps/gid.js";
import {
  MapService,
  MAX_STAMP_PATTERN_CELLS,
  MAX_STAMP_PATTERN_EDGE,
} from "../src/maps/mapService.js";
import type {
  MapEditOperation,
  MapEditPlan,
  StampPatternOperation,
  TileRef,
} from "../src/maps/types.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
const LAYER_ID = 7;

interface Harness {
  root: string;
  service: MapService;
}

interface HarnessOptions {
  width?: number;
  height?: number;
  layerX?: number;
  layerY?: number;
  data?: number[];
}

interface TilesetSummary {
  assetId: string;
}

describe("stampPattern", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("stamps a bounded row-major pattern at absolute offset-layer coordinates", async () => {
    const harness = await createHarness(roots, {
      width: 4,
      height: 3,
      layerX: -2,
      layerY: 5,
      data: Array.from({ length: 12 }, () => 4),
    });
    const assetId = await getAssetId(harness.service);
    const horizontalTwo = tile(assetId, 1, {
      kind: "orthogonal",
      flipH: true,
    });
    const pattern: StampPatternOperation["pattern"] = [
      [tile(assetId, 0), null, horizontalTwo],
      [tile(assetId, 2), tile(assetId, 3), null],
      [null, tile(assetId, 0), tile(assetId, 1)],
    ];
    const edit = await plan(harness.service, [
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: -1,
        y: 5,
        pattern,
      },
    ]);

    expect(edit.summary).toMatchObject({
      operationCount: 1,
      cellWrites: 9,
      affectedLayerIds: [LAYER_ID],
      affectedTileLayerIds: [LAYER_ID],
      tileStamps: [
        {
          operationIndex: 0,
          layerId: LAYER_ID,
          region: { x: -1, y: 5, width: 3, height: 3 },
          cellCount: 9,
          nonEmptyCellCount: 6,
          clearCellCount: 3,
          transformedCellCount: 1,
          changedCellCount: 8,
          wouldChange: true,
        },
      ],
    });

    const preview =
      new ChangeSetRegistry().put(edit).operations[0];
    expect(preview).toMatchObject({
      type: "stampPattern",
      layerId: LAYER_ID,
      destructive: true,
      warning: expect.any(String),
      region: { x: -1, y: 5, width: 3, height: 3 },
      cellCount: 9,
      nonEmptyCellCount: 6,
      clearCellCount: 3,
      transformedCellCount: 1,
      changedCellCount: 8,
      wouldChange: true,
      omittedCellCount: 1,
    });
    if (preview?.type !== "stampPattern") {
      throw new Error("Expected a stampPattern preview.");
    }
    expect(preview.sample).toHaveLength(8);
    expect(preview.sample[0]).toEqual({
      x: -1,
      y: 5,
      tile: pattern[0]?.[0],
    });
    expect(preview.sample[7]).toEqual({
      x: 0,
      y: 7,
      tile: pattern[2]?.[1],
    });

    await harness.service.applyEdits(edit);
    expect(await readLayerData(harness.root)).toEqual([
      4,
      1,
      0,
      (GID_FLIP_HORIZONTAL | 2) >>> 0,
      4,
      3,
      4,
      0,
      4,
      0,
      1,
      2,
    ]);
  });

  it("executes mixed operations in order while replaceTiles remains simultaneous", async () => {
    const harness = await createHarness(roots, {
      width: 4,
      height: 1,
      data: [1, 2, 3, 4],
    });
    const assetId = await getAssetId(harness.service);
    const edit = await plan(harness.service, [
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        pattern: [[tile(assetId, 1), tile(assetId, 0)]],
      },
      {
        type: "replaceTiles",
        layerId: LAYER_ID,
        mappings: [
          { from: tile(assetId, 1), to: tile(assetId, 2) },
          { from: tile(assetId, 2), to: tile(assetId, 3) },
        ],
      },
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        pattern: [[tile(assetId, 3)]],
      },
    ]);

    expect(edit.summary.tileStamps).toEqual([
      expect.objectContaining({
        operationIndex: 0,
        changedCellCount: 2,
      }),
      expect.objectContaining({
        operationIndex: 2,
        changedCellCount: 1,
      }),
    ]);
    expect(edit.summary.tileReplacements).toEqual([
      expect.objectContaining({
        operationIndex: 1,
        scannedCellCount: 4,
        replacedCellCount: 2,
      }),
    ]);

    await harness.service.applyEdits(edit);
    expect(await readLayerData(harness.root)).toEqual([4, 1, 4, 4]);
  });

  it("rejects empty, ragged, sparse, and non-canonical operation shapes", async () => {
    const harness = await createHarness(roots);
    const malformed = [
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        pattern: [],
      },
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        pattern: [[]],
      },
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        pattern: [[null], [null, null]],
      },
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        pattern: [new Array<TileRef | null>(1)],
      },
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        pattern: [[null]],
        ignored: true,
      },
    ] as unknown as MapEditOperation[];

    for (const operation of malformed) {
      await expect(
        plan(harness.service, [operation]),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
  });

  it("enforces the independent pattern edge and cell budgets, including the exact limit", async () => {
    const small = await createHarness(roots);
    await expect(
      plan(small.service, [
        {
          type: "stampPattern",
          layerId: LAYER_ID,
          x: 0,
          y: 0,
          pattern: Array.from(
            { length: MAX_STAMP_PATTERN_EDGE + 1 },
            () => [null],
          ),
        },
      ]),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: expect.objectContaining({
        limit: MAX_STAMP_PATTERN_EDGE,
      }),
    });

    await expect(
      plan(small.service, [
        {
          type: "stampPattern",
          layerId: LAYER_ID,
          x: 0,
          y: 0,
          pattern: Array.from({ length: 129 }, () =>
            Array.from({ length: 128 }, () => null),
          ),
        },
      ]),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: expect.objectContaining({
        limit: MAX_STAMP_PATTERN_CELLS,
      }),
    });

    const exact = await createHarness(roots, {
      width: MAX_STAMP_PATTERN_EDGE,
      height:
        MAX_STAMP_PATTERN_CELLS / MAX_STAMP_PATTERN_EDGE,
      data: Array.from(
        { length: MAX_STAMP_PATTERN_CELLS },
        () => 0,
      ),
    });
    const exactPlan = await plan(exact.service, [
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        pattern: Array.from(
          {
            length:
              MAX_STAMP_PATTERN_CELLS /
              MAX_STAMP_PATTERN_EDGE,
          },
          () =>
            Array.from(
              { length: MAX_STAMP_PATTERN_EDGE },
              () => null,
            ),
        ),
      },
    ]);
    expect(exactPlan.summary).toMatchObject({
      cellWrites: MAX_STAMP_PATTERN_CELLS,
      tileStamps: [
        {
          cellCount: MAX_STAMP_PATTERN_CELLS,
          changedCellCount: 0,
          wouldChange: false,
        },
      ],
    });
  }, 15_000);

  it("rejects unknown, out-of-range, raw, and malformed TileRefs and malformed current GIDs", async () => {
    const harness = await createHarness(roots);
    const assetId = await getAssetId(harness.service);
    const cases: Array<{
      tile: unknown;
      code: string;
    }> = [
      {
        tile: tile("asset_not_in_this_map", 0),
        code: "TILESET_NOT_IN_MAP",
      },
      {
        tile: tile(assetId, 4),
        code: "TILE_ID_OUT_OF_RANGE",
      },
      {
        tile: 1,
        code: "INVALID_ARGUMENT",
      },
      {
        tile: {
          tileset: { kind: "external", assetId },
          localId: 0,
          transform: {
            kind: "orthogonal",
            flipH: "yes",
          },
        },
        code: "INVALID_ARGUMENT",
      },
      {
        tile: {
          ...tile(assetId, 0),
          ignored: true,
        },
        code: "INVALID_ARGUMENT",
      },
      {
        tile: {
          tileset: {
            kind: "external",
            assetId,
            ignored: true,
          },
          localId: 0,
        },
        code: "INVALID_ARGUMENT",
      },
      {
        tile: {
          tileset: { kind: "external", assetId },
          localId: 0,
          transform: {
            kind: "orthogonal",
            flipH: true,
            ignored: true,
          },
        },
        code: "INVALID_ARGUMENT",
      },
      {
        tile: {
          tileset: { kind: "external", assetId },
          localId: 0,
          transform: {
            kind: "orthogonal",
            rawFlags: 1,
          },
        },
        code: "INVALID_TILE_TRANSFORM",
      },
      {
        tile: {
          tileset: { kind: "external", assetId },
          localId: 0,
          transform: {
            kind: "orthogonal",
            flipH: true,
            rawFlags: 0,
          },
        },
        code: "INVALID_TILE_TRANSFORM",
      },
    ];

    for (const testCase of cases) {
      await expect(
        plan(harness.service, [
          {
            type: "stampPattern",
            layerId: LAYER_ID,
            x: 0,
            y: 0,
            pattern: [[testCase.tile]],
          } as unknown as MapEditOperation,
        ]),
      ).rejects.toMatchObject({ code: testCase.code });
    }

    const malformedSource = await createHarness(roots, {
      width: 1,
      height: 1,
      data: [-1],
    });
    const malformedAssetId = await getAssetId(
      malformedSource.service,
    );
    await expect(
      plan(malformedSource.service, [
        {
          type: "stampPattern",
          layerId: LAYER_ID,
          x: 0,
          y: 0,
          pattern: [[tile(malformedAssetId, 0)]],
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_GID" });
  });

  it("uses all-or-nothing bounds with safe endpoints on offset layers", async () => {
    const harness = await createHarness(roots, {
      width: 3,
      height: 2,
      layerX: -2,
      layerY: 4,
      data: [0, 0, 0, 0, 0, 0],
    });
    const assetId = await getAssetId(harness.service);
    const twoCells = [[tile(assetId, 0), tile(assetId, 1)]];

    await expect(
      plan(harness.service, [
        {
          type: "stampPattern",
          layerId: LAYER_ID,
          x: -3,
          y: 4,
          pattern: twoCells,
        },
      ]),
    ).rejects.toMatchObject({ code: "REGION_OUT_OF_BOUNDS" });
    await expect(
      plan(harness.service, [
        {
          type: "stampPattern",
          layerId: LAYER_ID,
          x: 0,
          y: 4,
          pattern: twoCells,
        },
      ]),
    ).rejects.toMatchObject({ code: "REGION_OUT_OF_BOUNDS" });
    await expect(
      plan(harness.service, [
        {
          type: "stampPattern",
          layerId: LAYER_ID,
          x: -2,
          y: 6,
          pattern: [[tile(assetId, 0)]],
        },
      ]),
    ).rejects.toMatchObject({ code: "REGION_OUT_OF_BOUNDS" });
    await expect(
      plan(harness.service, [
        {
          type: "stampPattern",
          layerId: LAYER_ID,
          x: Number.MAX_SAFE_INTEGER,
          y: 4,
          pattern: twoCells,
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const valid = await plan(harness.service, [
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: -1,
        y: 5,
        pattern: twoCells,
      },
    ]);
    await harness.service.applyEdits(valid);
    expect(await readLayerData(harness.root)).toEqual([
      0, 0, 0,
      0, 1, 2,
    ]);
  });

  it("keeps exact source bytes for a semantic no-op stamp", async () => {
    const horizontalTwo =
      (GID_FLIP_HORIZONTAL | 2) >>> 0;
    const harness = await createHarness(roots, {
      width: 3,
      height: 1,
      data: [1, 0, horizontalTwo],
    });
    const map = baseMap({
      width: 3,
      height: 1,
      layerX: 0,
      layerY: 0,
      data: [1, 0, horizontalTwo],
    });
    map.vendorRootExtension = {
      exact: ["preserve", 17],
    };
    const source =
      `\uFEFF${JSON.stringify(map, null, "\t")
        .replace(
          '"compressionlevel": -1',
          '"compressionlevel": -1.000e+0',
        )
        .replace(/\n/gu, "\r\n")}\r\n`;
    const absoluteMapPath = join(harness.root, MAP_PATH);
    await writeFile(absoluteMapPath, source, "utf8");
    const assetId = await getAssetId(harness.service);
    const before = await readFile(absoluteMapPath);
    const edit = await plan(harness.service, [
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        pattern: [
          [
            tile(assetId, 0),
            null,
            tile(assetId, 1, {
              kind: "orthogonal",
              flipH: true,
            }),
          ],
        ],
      },
    ]);

    expect(edit.summary).toMatchObject({
      cellWrites: 3,
      affectedLayerIds: [],
      affectedTileLayerIds: [],
      tileStamps: [
        {
          changedCellCount: 0,
          wouldChange: false,
        },
      ],
    });
    const result = await harness.service.applyEdits(edit);
    expect(result).toMatchObject({
      changed: false,
      checkpointId: null,
      beforeRevision: edit.baseRevision,
      revision: edit.baseRevision,
    });
    expect(await readFile(absoluteMapPath)).toEqual(before);
  });

  it("keeps exact source bytes when ordered stamps change and then restore a cell", async () => {
    const harness = await createHarness(roots, {
      width: 1,
      height: 1,
      data: [1],
    });
    const assetId = await getAssetId(harness.service);
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const before = await readFile(absoluteMapPath);
    const edit = await plan(harness.service, [
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        pattern: [[tile(assetId, 1)]],
      },
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        pattern: [[tile(assetId, 0)]],
      },
    ]);

    expect(edit.summary).toMatchObject({
      cellWrites: 2,
      affectedLayerIds: [LAYER_ID],
      affectedTileLayerIds: [LAYER_ID],
      tileStamps: [
        { changedCellCount: 1, wouldChange: true },
        { changedCellCount: 1, wouldChange: true },
      ],
    });
    const result = await harness.service.applyEdits(edit);
    expect(result).toMatchObject({
      changed: false,
      checkpointId: null,
      beforeRevision: edit.baseRevision,
      revision: edit.baseRevision,
    });
    expect(await readFile(absoluteMapPath)).toEqual(before);
  });

  it("patches only nested tile data in a BOM/CRLF source", async () => {
    const harness = await createHarness(roots, {
      width: 2,
      height: 1,
      data: [1, 2],
    });
    const document = baseMap({
      width: 2,
      height: 1,
      layerX: 0,
      layerY: 0,
      data: [1, 2],
    });
    const tileLayer = (document.layers as JsonObject[])[0];
    if (tileLayer === undefined) {
      throw new Error("Expected the fixture tile layer.");
    }
    tileLayer.vendorLayerExtension = {
      preserve: ["tile-layer", 17],
    };
    document.layers = [
      {
        id: 6,
        name: "Nested",
        opacity: 1,
        type: "group",
        visible: true,
        layers: [tileLayer],
        vendorGroupExtension: { preserve: true },
      },
    ];
    document.vendorRootExtension = {
      preserve: { exact: "outside-data" },
    };
    const source =
      `\uFEFF${JSON.stringify(document, null, "\t")
        .replace(
          '"compressionlevel": -1',
          '"compressionlevel": -1.000e+0',
        )
        .replace(/\n/gu, "\r\n")}\r\n`;
    const absoluteMapPath = join(harness.root, MAP_PATH);
    await writeFile(absoluteMapPath, source, "utf8");
    const assetId = await getAssetId(harness.service);
    const edit = await plan(harness.service, [
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        pattern: [[tile(assetId, 2), null]],
      },
    ]);
    const before = await readFile(absoluteMapPath, "utf8");
    const dataPath: JSONPath = [
      "layers",
      0,
      "layers",
      0,
      "data",
    ];

    await harness.service.applyEdits(edit);
    const after = await readFile(absoluteMapPath, "utf8");
    expect(maskJsonValues(after, [dataPath])).toBe(
      maskJsonValues(before, [dataPath]),
    );
    expect(after.startsWith("\uFEFF")).toBe(true);
    expect(after).toContain('"compressionlevel": -1.000e+0');
    expect(after).toContain("\r\n");
    expect(await readLayerData(harness.root, dataPath)).toEqual([3, 0]);
  });

  it.skipIf(!hasTiledCli)("survives a real Tiled 1.12 JSON export round-trip when the CLI is available", async () => {
    const harness = await createHarness(roots, {
      width: 3,
      height: 2,
      data: [1, 2, 3, 4, 1, 2],
    });
    const assetId = await getAssetId(harness.service);
    const edit = await plan(harness.service, [
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: 1,
        y: 0,
        pattern: [
          [
            null,
            tile(assetId, 1, {
              kind: "orthogonal",
              flipH: true,
            }),
          ],
          [tile(assetId, 2), tile(assetId, 3)],
        ],
      },
    ]);
    await harness.service.applyEdits(edit);

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
    const exportedLayer = (
      exported.layers as JsonObject[]
    )[0];
    expect(exportedLayer?.data).toEqual([
      1,
      0,
      (GID_FLIP_HORIZONTAL | 2) >>> 0,
      4,
      3,
      4,
    ]);
  }, 40_000);

  it("rejects tampered and stale-dependency plans without changing map bytes", async () => {
    const harness = await createHarness(roots, {
      width: 2,
      height: 1,
      data: [1, 2],
    });
    const assetId = await getAssetId(harness.service);
    const edit = await plan(harness.service, [
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        pattern: [[tile(assetId, 2)]],
      },
    ]);
    const mapPath = join(harness.root, MAP_PATH);
    const before = await readFile(mapPath);
    const tampered = structuredClone(edit);
    const operation = tampered.operations[0];
    if (operation?.type !== "stampPattern") {
      throw new Error("Expected a stampPattern operation.");
    }
    operation.pattern[0] = [null];

    await expect(
      harness.service.applyEdits(tampered),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "CHANGE_SET_TAMPERED",
    });
    expect(await readFile(mapPath)).toEqual(before);

    const tilesetPath = join(harness.root, TILESET_PATH);
    const tileset = baseTileset();
    tileset.vendorDependencyEdit = true;
    await writeJson(tilesetPath, tileset);
    await expect(
      harness.service.applyEdits(edit),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DEPENDENCY_REVISION_CONFLICT",
    });
    expect(await readFile(mapPath)).toEqual(before);
  });
});

async function createHarness(
  roots: Set<string>,
  options: HarnessOptions = {},
): Promise<Harness> {
  const width = options.width ?? 4;
  const height = options.height ?? 1;
  const data =
    options.data ??
    Array.from({ length: width * height }, (_, index) =>
      index % 2 === 0 ? 1 : 2,
    );
  if (data.length !== width * height) {
    throw new Error("Fixture data length must equal width × height.");
  }

  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-stamp-pattern-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeJson(
    join(root, MAP_PATH),
    baseMap({
      width,
      height,
      layerX: options.layerX ?? 0,
      layerY: options.layerY ?? 0,
      data,
    }),
  );
  await writeJson(join(root, TILESET_PATH), baseTileset());
  await writeFile(
    join(root, "tiles", "terrain.png"),
    Buffer.from("placeholder image bytes", "utf8"),
  );

  const { service } =
    await wireProject(root);
  return {
    root,
    service: service,
  };
}

function baseMap(options: Required<HarnessOptions>): JsonObject {
  return {
    compressionlevel: -1,
    height: options.height,
    infinite: false,
    layers: [
      {
        data: options.data,
        height: options.height,
        id: LAYER_ID,
        name: "Ground",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: options.width,
        x: options.layerX,
        y: options.layerY,
      },
    ],
    nextlayerid: LAYER_ID + 1,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [{ firstgid: 1, source: "../tiles/terrain.tsj" }],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: options.width,
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
  };
}

function tile(
  assetId: string,
  localId: number,
  transform?: TileRef["transform"],
): TileRef {
  return {
    tileset: { kind: "external", assetId },
    localId,
    ...(transform === undefined ? {} : { transform }),
  };
}

async function plan(
  service: MapService,
  operations: MapEditOperation[],
): Promise<MapEditPlan> {
  const summary = await service.getSummary(MAP_PATH);
  return service.planEdits(
    MAP_PATH,
    summary.revision as string,
    summary.dependencyRevisions as Record<string, string>,
    operations,
  );
}

async function getAssetId(service: MapService): Promise<string> {
  const summary = await service.getSummary(MAP_PATH);
  const assetId = (summary.tilesets as TilesetSummary[])[0]
    ?.assetId;
  if (assetId === undefined) {
    throw new Error("Expected one external tileset.");
  }
  return assetId;
}

async function readLayerData(
  root: string,
  path: JSONPath = ["layers", 0, "data"],
): Promise<number[]> {
  const document = JSON.parse(
    (await readFile(join(root, MAP_PATH), "utf8")).replace(
      /^\uFEFF/u,
      "",
    ),
  ) as unknown;
  let value = document;
  for (const segment of path) {
    if (
      value === null ||
      typeof value !== "object" ||
      !(segment in value)
    ) {
      throw new Error(
        `Missing tile data path ${JSON.stringify(path)}.`,
      );
    }
    value = (value as Record<string | number, unknown>)[segment];
  }
  if (!Array.isArray(value)) {
    throw new Error("Expected tile data array.");
  }
  return value as number[];
}

async function writeJson(
  path: string,
  document: JsonObject,
): Promise<void> {
  await writeFile(path, serializeJsonDocument(document));
}

function maskJsonValues(
  source: string,
  paths: readonly JSONPath[],
): string {
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
      throw new Error(
        `Missing JSON fixture path ${JSON.stringify(path)}.`,
      );
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
