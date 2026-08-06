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
import {
  GID_FLIP_HORIZONTAL,
  GID_HEX_120,
} from "../src/maps/gid.js";
import {
  MapService,
  MAX_REPLACE_TILE_SCANS,
} from "../src/maps/mapService.js";
import type {
  FloodFillOperation,
  MapEditOperation,
  MapEditPlan,
  TileRef,
} from "../src/maps/types.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
const LAYER_ID = 7;
const MAX_CELL_WRITES = 100_000;

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

describe("floodFill", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("fills only the four-way connected exact-GID region on an offset layer", async () => {
    const harness = await createHarness(roots, {
      width: 4,
      height: 4,
      layerX: -2,
      layerY: 5,
      data: [
        1, 1, 0, 1,
        0, 1, 0, 1,
        0, 1, 1, 0,
        1, 0, 0, 1,
      ],
    });
    const assetId = await getAssetId(harness.service);
    const edit = await plan(harness.service, [
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: -2,
        y: 5,
        tile: tile(assetId, 1),
      },
    ]);
    const flood = edit.summary.tileFloodFills?.[0];

    expect(edit.summary).toMatchObject({
      operationCount: 1,
      cellWrites: 5,
      affectedLayerIds: [LAYER_ID],
      affectedTileLayerIds: [LAYER_ID],
      tileFloodFills: [
        {
          operationIndex: 0,
          layerId: LAYER_ID,
          seed: { x: -2, y: 5 },
          connectivity: "four-way",
          sourceTile: {
            tileset: {
              kind: "external",
              assetId,
            },
            localId: 0,
          },
          targetTile: {
            tileset: {
              kind: "external",
              assetId,
            },
            localId: 1,
          },
          changedCellCount: 5,
          affectedBounds: {
            x: -2,
            y: 5,
            width: 3,
            height: 3,
          },
          wouldChange: true,
        },
      ],
    });
    expect(flood?.scannedCellCount).toBe(18);

    const preview =
      new ChangeSetRegistry().put(edit).operations[0];
    expect(preview).toMatchObject({
      type: "floodFill",
      layerId: LAYER_ID,
      destructive: true,
      warning: expect.any(String),
      seed: { x: -2, y: 5 },
      connectivity: "four-way",
      sourceTile: {
        tileset: { kind: "external", assetId },
        localId: 0,
      },
      targetTile: {
        tileset: { kind: "external", assetId },
        localId: 1,
      },
      changedCellCount: 5,
      affectedBounds: {
        x: -2,
        y: 5,
        width: 3,
        height: 3,
      },
      wouldChange: true,
    });

    await harness.service.applyEdits(edit);
    expect(await readLayerData(harness.root)).toEqual([
      2, 2, 0, 1,
      0, 2, 0, 1,
      0, 2, 2, 0,
      1, 0, 0, 1,
    ]);
  });

  it("matches source transforms and preserves target raw flags exactly", async () => {
    const sourceGid =
      (GID_FLIP_HORIZONTAL | 1) >>> 0;
    const targetGid = (GID_HEX_120 | 2) >>> 0;
    const harness = await createHarness(roots, {
      width: 3,
      height: 1,
      data: [sourceGid, sourceGid, 1],
    });
    const assetId = await getAssetId(harness.service);
    const target = tile(assetId, 1, {
      kind: "orthogonal",
      flipH: false,
      flipV: false,
      flipD: false,
      rawFlags: GID_HEX_120,
    });
    const edit = await plan(harness.service, [
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        tile: target,
      },
    ]);

    expect(edit.summary.tileFloodFills).toEqual([
      expect.objectContaining({
        sourceTile: expect.objectContaining({
          localId: 0,
          transform: expect.objectContaining({
            flipH: true,
            rawFlags: GID_FLIP_HORIZONTAL,
          }),
        }),
        targetTile: target,
        changedCellCount: 2,
        affectedBounds: {
          x: 0,
          y: 0,
          width: 2,
          height: 1,
        },
      }),
    ]);
    expect(
      new ChangeSetRegistry().put(edit).operations[0],
    ).toMatchObject({
      type: "floodFill",
      sourceTile: expect.objectContaining({
        localId: 0,
        transform: expect.objectContaining({
          flipH: true,
          rawFlags: GID_FLIP_HORIZONTAL,
        }),
      }),
      targetTile: target,
      changedCellCount: 2,
    });

    await harness.service.applyEdits(edit);
    expect(await readLayerData(harness.root)).toEqual([
      targetGid,
      targetGid,
      1,
    ]);
  });

  it("supports tile-to-null and null-to-tile fills in operation order", async () => {
    const harness = await createHarness(roots, {
      width: 5,
      height: 1,
      data: [1, 1, 0, 0, 2],
    });
    const assetId = await getAssetId(harness.service);
    const edit = await plan(harness.service, [
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        tile: null,
      },
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: 2,
        y: 0,
        tile: tile(assetId, 2),
      },
    ]);

    expect(edit.summary).toMatchObject({
      operationCount: 2,
      cellWrites: 6,
      tileFloodFills: [
        {
          operationIndex: 0,
          sourceTile: {
            tileset: { kind: "external", assetId },
            localId: 0,
          },
          targetTile: null,
          changedCellCount: 2,
          affectedBounds: {
            x: 0,
            y: 0,
            width: 2,
            height: 1,
          },
          wouldChange: true,
        },
        {
          operationIndex: 1,
          sourceTile: null,
          targetTile: {
            tileset: { kind: "external", assetId },
            localId: 2,
          },
          changedCellCount: 4,
          affectedBounds: {
            x: 0,
            y: 0,
            width: 4,
            height: 1,
          },
          wouldChange: true,
        },
      ],
    });

    await harness.service.applyEdits(edit);
    expect(await readLayerData(harness.root)).toEqual([
      3, 3, 3, 3, 2,
    ]);
  });

  it("observes prior generic writes and can be followed by later writes", async () => {
    const harness = await createHarness(roots, {
      width: 3,
      height: 1,
      data: [1, 0, 1],
    });
    const assetId = await getAssetId(harness.service);
    const edit = await plan(harness.service, [
      {
        type: "setTiles",
        layerId: LAYER_ID,
        cells: [
          { x: 1, y: 0, tile: tile(assetId, 0) },
        ],
      },
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        tile: tile(assetId, 1),
      },
      {
        type: "fillRegion",
        layerId: LAYER_ID,
        x: 1,
        y: 0,
        width: 1,
        height: 1,
        tile: tile(assetId, 2),
      },
    ]);

    expect(edit.summary).toMatchObject({
      operationCount: 3,
      cellWrites: 5,
      tileFloodFills: [
        {
          operationIndex: 1,
          sourceTile: {
            tileset: { kind: "external", assetId },
            localId: 0,
          },
          changedCellCount: 3,
        },
      ],
    });
    await harness.service.applyEdits(edit);
    expect(await readLayerData(harness.root)).toEqual([
      2, 3, 2,
    ]);
  });

  it("rejects non-canonical operation and TileRef shapes, invalid targets, and seeds outside the layer", async () => {
    const harness = await createHarness(roots, {
      width: 2,
      height: 1,
      layerX: -1,
      layerY: 4,
      data: [1, 2],
    });
    const assetId = await getAssetId(harness.service);
    const malformed: unknown[] = [
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: -1,
        y: 4,
        tile: null,
        ignored: true,
      },
      {
        type: "floodFill",
        layerId: 0,
        x: -1,
        y: 4,
        tile: null,
      },
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: Number.MAX_SAFE_INTEGER + 1,
        y: 4,
        tile: null,
      },
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: -1,
        y: 4,
      },
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: -1,
        y: 4,
        tile: {
          ...tile(assetId, 0),
          ignored: true,
        },
      },
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: -1,
        y: 4,
        tile: {
          tileset: {
            kind: "external",
            assetId,
            ignored: true,
          },
          localId: 0,
        },
      },
    ];
    for (const operation of malformed) {
      await expect(
        plan(harness.service, [
          operation as MapEditOperation,
        ]),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }

    await expect(
      plan(harness.service, [
        {
          type: "floodFill",
          layerId: LAYER_ID,
          x: -1,
          y: 4,
          tile: tile(assetId, 0, {
            kind: "orthogonal",
            flipH: true,
            rawFlags: 0,
          }),
        },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_TILE_TRANSFORM",
    });

    await expect(
      plan(harness.service, [
        {
          type: "floodFill",
          layerId: LAYER_ID,
          x: -2,
          y: 4,
          tile: null,
        },
      ]),
    ).rejects.toMatchObject({
      code: "REGION_OUT_OF_BOUNDS",
    });
    await expect(
      plan(harness.service, [
        {
          type: "floodFill",
          layerId: LAYER_ID,
          x: 1,
          y: 4,
          tile: null,
        },
      ]),
    ).rejects.toMatchObject({
      code: "REGION_OUT_OF_BOUNDS",
    });
    await expect(
      plan(harness.service, [
        {
          type: "floodFill",
          layerId: LAYER_ID,
          x: -1,
          y: 3,
          tile: null,
        },
      ]),
    ).rejects.toMatchObject({
      code: "REGION_OUT_OF_BOUNDS",
    });

    await expect(
      plan(harness.service, [
        {
          type: "floodFill",
          layerId: LAYER_ID,
          x: -1,
          y: 4,
          tile: tile("asset_not_in_this_map", 0),
        },
      ]),
    ).rejects.toMatchObject({
      code: "TILESET_NOT_IN_MAP",
    });
    await expect(
      plan(harness.service, [
        {
          type: "floodFill",
          layerId: LAYER_ID,
          x: -1,
          y: 4,
          tile: tile(assetId, 4),
        },
      ]),
    ).rejects.toMatchObject({
      code: "TILE_ID_OUT_OF_RANGE",
    });
  });

  it("fails closed when a scanned boundary cell contains a malformed GID", async () => {
    const malformed = await createHarness(roots, {
      width: 2,
      height: 1,
      data: [1, -1],
    });
    const assetId = await getAssetId(malformed.service);

    await expect(
      plan(malformed.service, [
        {
          type: "floodFill",
          layerId: LAYER_ID,
          x: 0,
          y: 0,
          tile: tile(assetId, 1),
        },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_GID",
    });
  });

  it("enforces exact and over-limit actual-write budgets", async () => {
    const exact = await createHarness(roots, {
      width: MAX_CELL_WRITES,
      height: 1,
      data: Array.from(
        { length: MAX_CELL_WRITES },
        () => 1,
      ),
    });
    const exactAssetId = await getAssetId(exact.service);
    const exactPlan = await plan(exact.service, [
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        tile: tile(exactAssetId, 1),
      },
    ]);
    expect(exactPlan.summary).toMatchObject({
      cellWrites: MAX_CELL_WRITES,
      tileFloodFills: [
        {
          changedCellCount: MAX_CELL_WRITES,
          affectedBounds: {
            x: 0,
            y: 0,
            width: MAX_CELL_WRITES,
            height: 1,
          },
          wouldChange: true,
        },
      ],
    });

    const cumulativeExact = await createHarness(roots, {
      width: MAX_CELL_WRITES,
      height: 1,
      data: Array.from(
        { length: MAX_CELL_WRITES },
        () => 1,
      ),
    });
    const cumulativeAssetId = await getAssetId(
      cumulativeExact.service,
    );
    const cumulativePlan = await plan(
      cumulativeExact.service,
      [
        {
          type: "setTiles",
          layerId: LAYER_ID,
          cells: [
            {
              x: MAX_CELL_WRITES - 1,
              y: 0,
              tile: tile(cumulativeAssetId, 2),
            },
          ],
        },
        {
          type: "floodFill",
          layerId: LAYER_ID,
          x: 0,
          y: 0,
          tile: tile(cumulativeAssetId, 1),
        },
      ],
    );
    expect(cumulativePlan.summary).toMatchObject({
      cellWrites: MAX_CELL_WRITES,
      tileFloodFills: [
        {
          operationIndex: 1,
          changedCellCount: MAX_CELL_WRITES - 1,
        },
      ],
    });

    const over = await createHarness(roots, {
      width: MAX_CELL_WRITES + 1,
      height: 1,
      data: Array.from(
        { length: MAX_CELL_WRITES + 1 },
        () => 1,
      ),
    });
    const overAssetId = await getAssetId(over.service);
    await expect(
      plan(over.service, [
        {
          type: "floodFill",
          layerId: LAYER_ID,
          x: 0,
          y: 0,
          tile: tile(overAssetId, 1),
        },
      ]),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: expect.objectContaining({
        limit: MAX_CELL_WRITES,
      }),
    });
  }, 20_000);

  it("shares the one-million scan budget with replaceTiles", async () => {
    const harness = await createHarness(roots, {
      width: MAX_REPLACE_TILE_SCANS,
      height: 1,
      data: [
        1,
        ...Array.from(
          { length: MAX_REPLACE_TILE_SCANS - 1 },
          () => 0,
        ),
      ],
    });
    const assetId = await getAssetId(harness.service);
    const replacement = {
      from: tile(assetId, 3),
      to: tile(assetId, 2),
    };
    const flood: FloodFillOperation = {
      type: "floodFill",
      layerId: LAYER_ID,
      x: 0,
      y: 0,
      tile: tile(assetId, 1),
    };
    const exact = await plan(harness.service, [
      {
        type: "replaceTiles",
        layerId: LAYER_ID,
        mappings: [replacement],
        region: {
          x: 0,
          y: 0,
          width: MAX_REPLACE_TILE_SCANS - 2,
          height: 1,
        },
      },
      flood,
    ]);
    expect(exact.summary.tileReplacements).toEqual([
      expect.objectContaining({
        scannedCellCount:
          MAX_REPLACE_TILE_SCANS - 2,
      }),
    ]);
    expect(exact.summary.tileFloodFills).toEqual([
      expect.objectContaining({
        scannedCellCount: 2,
        changedCellCount: 1,
      }),
    ]);

    await expect(
      plan(harness.service, [
        {
          type: "replaceTiles",
          layerId: LAYER_ID,
          mappings: [replacement],
          region: {
            x: 0,
            y: 0,
            width: MAX_REPLACE_TILE_SCANS - 1,
            height: 1,
          },
        },
        flood,
      ]),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: expect.objectContaining({
        limit: MAX_REPLACE_TILE_SCANS,
      }),
    });
  }, 20_000);

  it("keeps exact source bytes and revision for a semantic no-op", async () => {
    const harness = await createHarness(roots, {
      width: 2,
      height: 1,
      data: [1, 1],
    });
    const document = baseMap({
      width: 2,
      height: 1,
      layerX: 0,
      layerY: 0,
      data: [1, 1],
    });
    document.vendorRootExtension = {
      exact: ["preserve", 17],
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
    const before = await readFile(absoluteMapPath);
    const edit = await plan(harness.service, [
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        tile: tile(assetId, 0),
      },
    ]);

    expect(edit.summary).toMatchObject({
      cellWrites: 0,
      affectedLayerIds: [],
      affectedTileLayerIds: [],
      tileFloodFills: [
        {
          scannedCellCount: 1,
          changedCellCount: 0,
          affectedBounds: null,
          wouldChange: false,
        },
      ],
    });
    const malformedPreviewPlan = structuredClone(edit);
    const malformedTarget =
      malformedPreviewPlan.summary.tileFloodFills?.[0]
        ?.targetTile;
    if (
      malformedTarget === null ||
      malformedTarget === undefined ||
      malformedTarget.transform === undefined
    ) {
      throw new Error(
        "Expected a canonical flood-fill target tile.",
      );
    }
    malformedTarget.transform.rawFlags = 1;
    expect(() =>
      new ChangeSetRegistry().put(
        malformedPreviewPlan,
      ),
    ).toThrow(/preview summary/u);

    const mismatchedSourcePlan = structuredClone(edit);
    const mismatchedSource =
      mismatchedSourcePlan.summary.tileFloodFills?.[0]
        ?.sourceTile;
    if (
      mismatchedSource === null ||
      mismatchedSource === undefined
    ) {
      throw new Error(
        "Expected a canonical flood-fill source tile.",
      );
    }
    mismatchedSource.localId = 1;
    expect(() =>
      new ChangeSetRegistry().put(
        mismatchedSourcePlan,
      ),
    ).toThrow(/preview summary/u);

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
      width: 3,
      height: 1,
      data: [1, 1, 2],
    });
    const document = baseMap({
      width: 3,
      height: 1,
      layerX: 0,
      layerY: 0,
      data: [1, 1, 2],
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
        type: "floodFill",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        tile: tile(assetId, 2),
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
    expect(
      await readLayerData(harness.root, dataPath),
    ).toEqual([3, 3, 2]);
  });

  it("rejects tampered and stale-dependency plans without changing map bytes", async () => {
    const harness = await createHarness(roots, {
      width: 2,
      height: 1,
      data: [1, 1],
    });
    const assetId = await getAssetId(harness.service);
    const edit = await plan(harness.service, [
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        tile: tile(assetId, 1),
      },
    ]);
    const mapPath = join(harness.root, MAP_PATH);
    const before = await readFile(mapPath);
    const tampered = structuredClone(edit);
    const operation = tampered.operations[0];
    if (operation?.type !== "floodFill") {
      throw new Error("Expected a floodFill operation.");
    }
    operation.tile = null;

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

  it.skipIf(!hasTiledCli)("survives a real Tiled 1.12 JSON export round-trip when the CLI is available", async () => {
    const harness = await createHarness(roots, {
      width: 3,
      height: 2,
      data: [
        1, 1, 0,
        1, 0, 0,
      ],
    });
    const assetId = await getAssetId(harness.service);
    const edit = await plan(harness.service, [
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        tile: tile(assetId, 1, {
          kind: "orthogonal",
          flipH: true,
        }),
      },
    ]);
    expect(
      new ChangeSetRegistry().put(edit).operations[0],
    ).toMatchObject({
      type: "floodFill",
      targetTile: {
        tileset: {
          kind: "external",
          assetId,
        },
        localId: 1,
        transform: expect.objectContaining({
          flipH: true,
          rawFlags: GID_FLIP_HORIZONTAL,
        }),
      },
    });
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
    const targetGid =
      (GID_FLIP_HORIZONTAL | 2) >>> 0;
    expect(exportedLayer?.data).toEqual([
      targetGid,
      targetGid,
      0,
      targetGid,
      0,
      0,
    ]);
  }, 40_000);
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
    throw new Error(
      "Fixture data length must equal width × height.",
    );
  }

  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-flood-fill-"),
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

function baseMap(
  options: Required<HarnessOptions>,
): JsonObject {
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
    tilesets: [
      {
        firstgid: 1,
        source: "../tiles/terrain.tsj",
      },
    ],
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

async function getAssetId(
  service: MapService,
): Promise<string> {
  const summary = await service.getSummary(MAP_PATH);
  const assetId = (
    summary.tilesets as TilesetSummary[]
  )[0]?.assetId;
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
    value = (
      value as Record<string | number, unknown>
    )[segment];
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
  ranges.sort(
    (left, right) => right.offset - left.offset,
  );
  for (const range of ranges) {
    body =
      body.slice(0, range.offset) +
      range.marker +
      body.slice(range.offset + range.length);
  }
  return `${hasBom ? "\uFEFF" : ""}${body}`;
}
