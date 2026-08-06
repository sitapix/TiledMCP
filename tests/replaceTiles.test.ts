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

import {
  findNodeAtLocation,
  parseTree,
  type JSONPath,
} from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";

import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import {
  GID_DIAGONAL_OR_HEX_60,
  GID_FLIP_HORIZONTAL,
  GID_FLIP_VERTICAL,
} from "../src/maps/gid.js";
import {
  MapService,
  MAX_REPLACE_TILE_MAPPINGS,
  MAX_REPLACE_TILE_SCANS,
} from "../src/maps/mapService.js";
import type {
  MapEditOperation,
  MapEditPlan,
  TileRef,
} from "../src/maps/types.js";

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

describe("replaceTiles", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("uses one simultaneous pass for chained mappings and swaps", async () => {
    const chained = await createHarness(
      roots,
      { width: 4, height: 1, data: [1, 2, 1, 2] },
    );
    const chainedAssetId = await getAssetId(chained.service);
    const chainedPlan = await plan(
      chained.service,
      [
        {
          type: "replaceTiles",
          layerId: LAYER_ID,
          mappings: [
            {
              from: tile(chainedAssetId, 0),
              to: tile(chainedAssetId, 1),
            },
            {
              from: tile(chainedAssetId, 1),
              to: tile(chainedAssetId, 2),
            },
          ],
        },
      ],
    );

    expect(chainedPlan.summary).toMatchObject({
      cellWrites: 4,
      affectedLayerIds: [LAYER_ID],
      affectedTileLayerIds: [LAYER_ID],
      tileReplacements: [
        {
          operationIndex: 0,
          layerId: LAYER_ID,
          region: { x: 0, y: 0, width: 4, height: 1 },
          scannedCellCount: 4,
          replacedCellCount: 4,
          mappingCount: 2,
        },
      ],
    });
    await chained.service.applyEdits(chainedPlan);
    expect(await readLayerData(chained.root)).toEqual([2, 3, 2, 3]);

    const swapped = await createHarness(
      roots,
      { width: 4, height: 1, data: [1, 2, 2, 1] },
    );
    const swappedAssetId = await getAssetId(swapped.service);
    const swappedPlan = await plan(
      swapped.service,
      [
        {
          type: "replaceTiles",
          layerId: LAYER_ID,
          mappings: [
            {
              from: tile(swappedAssetId, 0),
              to: tile(swappedAssetId, 1),
            },
            {
              from: tile(swappedAssetId, 1),
              to: tile(swappedAssetId, 0),
            },
          ],
        },
      ],
    );

    await swapped.service.applyEdits(swappedPlan);
    expect(await readLayerData(swapped.root)).toEqual([2, 1, 1, 2]);
  });

  it("matches the complete encoded GID and uses the target transform flags", async () => {
    const diagonalLocalZero =
      (GID_DIAGONAL_OR_HEX_60 | 1) >>> 0;
    const harness = await createHarness(
      roots,
      {
        width: 3,
        height: 1,
        data: [
          1,
          (GID_FLIP_HORIZONTAL | 1) >>> 0,
          diagonalLocalZero,
        ],
      },
    );
    const assetId = await getAssetId(harness.service);
    const edit = await plan(
      harness.service,
      [
        {
          type: "replaceTiles",
          layerId: LAYER_ID,
          mappings: [
            {
              from: tile(assetId, 0),
              to: tile(assetId, 1, {
                kind: "orthogonal",
                flipV: true,
              }),
            },
            {
              from: tile(assetId, 0, {
                kind: "orthogonal",
                flipH: true,
              }),
              to: tile(assetId, 2, {
                kind: "orthogonal",
                flipD: true,
              }),
            },
          ],
        },
      ],
    );

    expect(edit.summary.tileReplacements?.[0]).toMatchObject({
      scannedCellCount: 3,
      replacedCellCount: 2,
    });
    await harness.service.applyEdits(edit);
    expect(await readLayerData(harness.root)).toEqual([
      (GID_FLIP_VERTICAL | 2) >>> 0,
      (GID_DIAGONAL_OR_HEX_60 | 3) >>> 0,
      diagonalLocalZero,
    ]);
  });

  it("replaces a tile with null", async () => {
    const harness = await createHarness(
      roots,
      { width: 3, height: 1, data: [1, 2, 1] },
    );
    const assetId = await getAssetId(harness.service);
    const edit = await plan(
      harness.service,
      [
        {
          type: "replaceTiles",
          layerId: LAYER_ID,
          mappings: [{ from: tile(assetId, 0), to: null }],
        },
      ],
    );

    await harness.service.applyEdits(edit);
    expect(await readLayerData(harness.root)).toEqual([0, 2, 0]);
  });

  it("uses an explicit region and defaults to the complete offset layer bounds", async () => {
    const harness = await createHarness(
      roots,
      {
        width: 3,
        height: 2,
        layerX: -2,
        layerY: 4,
        data: [1, 1, 1, 1, 1, 1],
      },
    );
    const assetId = await getAssetId(harness.service);
    const edit = await plan(
      harness.service,
      [
        {
          type: "replaceTiles",
          layerId: LAYER_ID,
          mappings: [
            {
              from: tile(assetId, 0),
              to: tile(assetId, 1),
            },
          ],
          region: { x: -1, y: 4, width: 1, height: 2 },
        },
        {
          type: "replaceTiles",
          layerId: LAYER_ID,
          mappings: [
            {
              from: tile(assetId, 0),
              to: tile(assetId, 2),
            },
          ],
        },
      ],
    );

    expect(edit.summary).toMatchObject({
      cellWrites: 6,
      tileReplacements: [
        {
          operationIndex: 0,
          region: { x: -1, y: 4, width: 1, height: 2 },
          scannedCellCount: 2,
          replacedCellCount: 2,
        },
        {
          operationIndex: 1,
          region: { x: -2, y: 4, width: 3, height: 2 },
          scannedCellCount: 6,
          replacedCellCount: 4,
        },
      ],
    });
    await harness.service.applyEdits(edit);
    expect(await readLayerData(harness.root)).toEqual([
      3, 2, 3,
      3, 2, 3,
    ]);
  });

  it("rejects duplicate canonical sources and encoded no-op mappings", async () => {
    const harness = await createHarness(roots);
    const assetId = await getAssetId(harness.service);

    await expect(
      plan(
        harness.service,
        [
          {
            type: "replaceTiles",
            layerId: LAYER_ID,
            mappings: [
              {
                from: tile(assetId, 0),
                to: tile(assetId, 1),
              },
              {
                from: tile(assetId, 0, {
                  kind: "orthogonal",
                  flipH: false,
                  flipV: false,
                  flipD: false,
                }),
                to: tile(assetId, 2),
              },
            ],
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: expect.objectContaining({
        mappingIndex: 1,
        duplicateMappingIndex: 0,
      }),
    });

    await expect(
      plan(
        harness.service,
        [
          {
            type: "replaceTiles",
            layerId: LAYER_ID,
            mappings: [
              {
                from: tile(assetId, 0),
                to: tile(assetId, 0, {
                  kind: "orthogonal",
                  flipH: false,
                  flipV: false,
                  flipD: false,
                }),
              },
            ],
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: expect.objectContaining({ mappingIndex: 0, gid: 1 }),
    });
  });

  it("rejects unknown assets and out-of-range local tile IDs", async () => {
    const harness = await createHarness(roots);
    const assetId = await getAssetId(harness.service);

    await expect(
      plan(
        harness.service,
        [
          {
            type: "replaceTiles",
            layerId: LAYER_ID,
            mappings: [
              {
                from: tile("asset_not_in_this_map", 0),
                to: tile(assetId, 1),
              },
            ],
          },
        ],
      ),
    ).rejects.toMatchObject({ code: "TILESET_NOT_IN_MAP" });

    await expect(
      plan(
        harness.service,
        [
          {
            type: "replaceTiles",
            layerId: LAYER_ID,
            mappings: [
              {
                from: tile(assetId, 0),
                to: tile(assetId, 4),
              },
            ],
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "TILE_ID_OUT_OF_RANGE",
      details: expect.objectContaining({
        localId: 4,
        tileCount: 4,
      }),
    });
  });

  it("rejects out-of-bounds or unsafe regions and malformed scanned GIDs", async () => {
    const harness = await createHarness(
      roots,
      { width: 2, height: 1, layerX: -1, data: [1, 2] },
    );
    const assetId = await getAssetId(harness.service);
    const mapping = {
      from: tile(assetId, 0),
      to: tile(assetId, 1),
    };

    await expect(
      plan(
        harness.service,
        [
          {
            type: "replaceTiles",
            layerId: LAYER_ID,
            mappings: [mapping],
            region: { x: -2, y: 0, width: 1, height: 1 },
          },
        ],
      ),
    ).rejects.toMatchObject({ code: "REGION_OUT_OF_BOUNDS" });

    const unsafeOrigin = await createHarness(
      roots,
      {
        width: 2,
        height: 1,
        layerX: Number.MAX_SAFE_INTEGER,
        data: [1, 2],
      },
    );
    const unsafeAssetId = await getAssetId(unsafeOrigin.service);
    await expect(
      plan(
        unsafeOrigin.service,
        [
          {
            type: "replaceTiles",
            layerId: LAYER_ID,
            mappings: [
              {
                from: tile(unsafeAssetId, 0),
                to: tile(unsafeAssetId, 1),
              },
            ],
          },
        ],
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const malformed = await createHarness(
      roots,
      { width: 2, height: 1, data: [1, -1] },
    );
    const malformedAssetId = await getAssetId(malformed.service);
    await expect(
      plan(
        malformed.service,
        [
          {
            type: "replaceTiles",
            layerId: LAYER_ID,
            mappings: [
              {
                from: tile(malformedAssetId, 2),
                to: tile(malformedAssetId, 3),
              },
            ],
          },
        ],
      ),
    ).rejects.toMatchObject({ code: "INVALID_GID" });
  });

  it("patches only a nested tile data subtree in a BOM/CRLF source", async () => {
    const harness = await createHarness(
      roots,
      { width: 2, height: 1, data: [1, 2] },
    );
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
    const edit = await plan(
      harness.service,
      [
        {
          type: "replaceTiles",
          layerId: LAYER_ID,
          mappings: [
            {
              from: tile(assetId, 0),
              to: tile(assetId, 2),
            },
          ],
        },
      ],
    );
    const before = await readFile(absoluteMapPath, "utf8");

    await harness.service.applyEdits(edit);
    const after = await readFile(absoluteMapPath, "utf8");
    const dataPath: JSONPath = [
      "layers",
      0,
      "layers",
      0,
      "data",
    ];
    expect(maskJsonValues(after, [dataPath])).toBe(
      maskJsonValues(before, [dataPath]),
    );
    expect(after.startsWith("\uFEFF")).toBe(true);
    expect(after).toContain('"compressionlevel": -1.000e+0');
    expect(after).toContain("\r\n");
    expect(await readLayerData(harness.root, dataPath)).toEqual([3, 2]);
  });

  it("replaces across tilesets and rejects a stale target dependency at apply", async () => {
    const harness = await createHarness(
      roots,
      { width: 2, height: 1, data: [1, 5] },
    );
    const secondTilesetPath = join(
      harness.root,
      "tiles",
      "other.tsj",
    );
    const secondTileset = baseTileset();
    secondTileset.name = "Other";
    await writeJson(secondTilesetPath, secondTileset);
    const mapPath = join(harness.root, MAP_PATH);
    const document = JSON.parse(
      await readFile(mapPath, "utf8"),
    ) as JsonObject;
    document.tilesets = [
      { firstgid: 1, source: "../tiles/terrain.tsj" },
      { firstgid: 5, source: "../tiles/other.tsj" },
    ];
    await writeJson(mapPath, document);
    const summary = await harness.service.getSummary(MAP_PATH);
    const tilesets = summary.tilesets as Array<{
      assetId: string;
      path: string;
    }>;
    const firstAssetId = tilesets.find(
      ({ path }) => path === TILESET_PATH,
    )?.assetId;
    const secondAssetId = tilesets.find(
      ({ path }) => path === "tiles/other.tsj",
    )?.assetId;
    if (firstAssetId === undefined || secondAssetId === undefined) {
      throw new Error("Expected both fixture tilesets.");
    }

    const crossTilesetPlan = await plan(
      harness.service,
      [
        {
          type: "replaceTiles",
          layerId: LAYER_ID,
          mappings: [
            {
              from: tile(firstAssetId, 0),
              to: tile(secondAssetId, 1),
            },
          ],
        },
      ],
    );
    await harness.service.applyEdits(crossTilesetPlan);
    expect(await readLayerData(harness.root)).toEqual([6, 5]);

    const stalePlan = await plan(
      harness.service,
      [
        {
          type: "replaceTiles",
          layerId: LAYER_ID,
          mappings: [
            {
              from: tile(secondAssetId, 0),
              to: tile(firstAssetId, 2),
            },
          ],
        },
      ],
    );
    const before = await readFile(mapPath);
    secondTileset.vendorDependencyEdit = true;
    await writeJson(secondTilesetPath, secondTileset);

    await expect(
      harness.service.applyEdits(stalePlan),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
    });
    expect(await readFile(mapPath)).toEqual(before);
  });

  it("reports a bounded zero-match no-op without touching the source", async () => {
    const harness = await createHarness(
      roots,
      { width: 3, height: 1, data: [1, 0, 2] },
    );
    const assetId = await getAssetId(harness.service);
    const before = await readFile(join(harness.root, MAP_PATH));
    const edit = await plan(
      harness.service,
      [
        {
          type: "replaceTiles",
          layerId: LAYER_ID,
          mappings: [
            {
              from: tile(assetId, 2),
              to: tile(assetId, 3),
            },
          ],
        },
      ],
    );

    expect(edit.summary).toEqual({
      operationCount: 1,
      cellWrites: 0,
      affectedLayerIds: [],
      affectedTileLayerIds: [],
      affectedObjectLayerIds: [],
      createdObjectIds: [],
      updatedObjectIds: [],
      deletedObjectIds: [],
      tileReplacements: [
        {
          operationIndex: 0,
          layerId: LAYER_ID,
          region: { x: 0, y: 0, width: 3, height: 1 },
          scannedCellCount: 3,
          replacedCellCount: 0,
          mappingCount: 1,
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
    expect(await readFile(join(harness.root, MAP_PATH))).toEqual(before);
  });

  it("enforces mapping, scan, and actual-write budgets", async () => {
    const mappingHarness = await createHarness(roots);
    const mappingAssetId = await getAssetId(mappingHarness.service);
    await expect(
      plan(
        mappingHarness.service,
        [
          {
            type: "replaceTiles",
            layerId: LAYER_ID,
            mappings: Array.from(
              { length: MAX_REPLACE_TILE_MAPPINGS + 1 },
              () => ({
                from: tile(mappingAssetId, 0),
                to: tile(mappingAssetId, 1),
              }),
            ),
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: { limit: MAX_REPLACE_TILE_MAPPINGS },
    });

    const scanHarness = await createHarness(
      roots,
      {
        width: MAX_REPLACE_TILE_SCANS + 1,
        height: 1,
        data: Array.from(
          { length: MAX_REPLACE_TILE_SCANS + 1 },
          () => 0,
        ),
      },
    );
    const scanAssetId = await getAssetId(scanHarness.service);
    await expect(
      plan(
        scanHarness.service,
        [
          {
            type: "replaceTiles",
            layerId: LAYER_ID,
            mappings: [
              {
                from: tile(scanAssetId, 0),
                to: tile(scanAssetId, 1),
              },
            ],
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        limit: MAX_REPLACE_TILE_SCANS,
        actual: MAX_REPLACE_TILE_SCANS + 1,
      },
    });

    const writeCount = 100_001;
    const exactWriteHarness = await createHarness(
      roots,
      {
        width: 100_000,
        height: 1,
        data: Array.from({ length: 100_000 }, () => 1),
      },
    );
    const exactWriteAssetId = await getAssetId(
      exactWriteHarness.service,
    );
    const exactWritePlan = await plan(
      exactWriteHarness.service,
      [
        {
          type: "replaceTiles",
          layerId: LAYER_ID,
          mappings: [
            {
              from: tile(exactWriteAssetId, 0),
              to: tile(exactWriteAssetId, 1),
            },
          ],
        },
      ],
    );
    expect(exactWritePlan.summary.cellWrites).toBe(100_000);

    const cumulativeScanHarness = await createHarness(
      roots,
      {
        width: 600_000,
        height: 1,
        data: Array.from({ length: 600_000 }, () => 0),
      },
    );
    const cumulativeScanAssetId = await getAssetId(
      cumulativeScanHarness.service,
    );
    await expect(
      plan(
        cumulativeScanHarness.service,
        [
          {
            type: "replaceTiles",
            layerId: LAYER_ID,
            mappings: [
              {
                from: tile(cumulativeScanAssetId, 0),
                to: tile(cumulativeScanAssetId, 1),
              },
            ],
          },
          {
            type: "replaceTiles",
            layerId: LAYER_ID,
            mappings: [
              {
                from: tile(cumulativeScanAssetId, 1),
                to: tile(cumulativeScanAssetId, 2),
              },
            ],
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        limit: MAX_REPLACE_TILE_SCANS,
        actual: 1_200_000,
      },
    });

    const writeHarness = await createHarness(
      roots,
      {
        width: writeCount,
        height: 1,
        data: Array.from({ length: writeCount }, () => 1),
      },
    );
    const writeAssetId = await getAssetId(writeHarness.service);
    await expect(
      plan(
        writeHarness.service,
        [
          {
            type: "replaceTiles",
            layerId: LAYER_ID,
            mappings: [
              {
                from: tile(writeAssetId, 0),
                to: tile(writeAssetId, 1),
              },
            ],
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: { limit: 100_000 },
    });

    const sharedWriteHarness = await createHarness(
      roots,
      {
        width: 100_001,
        height: 1,
        data: Array.from({ length: 100_001 }, () => 1),
      },
    );
    const sharedWriteAssetId = await getAssetId(
      sharedWriteHarness.service,
    );
    await expect(
      plan(
        sharedWriteHarness.service,
        [
          {
            type: "setTiles",
            layerId: LAYER_ID,
            cells: [
              {
                x: 0,
                y: 0,
                tile: tile(sharedWriteAssetId, 1),
              },
            ],
          },
          {
            type: "replaceTiles",
            layerId: LAYER_ID,
            mappings: [
              {
                from: tile(sharedWriteAssetId, 0),
                to: tile(sharedWriteAssetId, 1),
              },
            ],
          },
        ],
      ),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: { limit: 100_000 },
    });
  }, 20_000);
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
    join(tmpdir(), "tiledmcp-replace-tiles-"),
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
