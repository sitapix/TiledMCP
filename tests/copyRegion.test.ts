import { execFile } from "node:child_process";
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
import {
  MapService,
  MAX_TILE_OPERATION_SCANS,
} from "../src/maps/mapService.js";
import type {
  CopyRegionOperation,
  MapEditOperation,
  MapEditPlan,
  TileRef,
} from "../src/maps/types.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
const SOURCE_LAYER_ID = 7;
const DESTINATION_LAYER_ID = 8;
const MAX_COPY_CELL_WRITES = 100_000;

interface Harness {
  root: string;
  service: MapService;
}

interface LayerFixture {
  id: number;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  data: number[];
}

interface HarnessOptions {
  layers?: LayerFixture[];
  compactMap?: boolean;
}

interface MapSnapshot {
  revision: string;
  dependencies: Record<string, string>;
  tilesetAssetId: string;
}

type TileCopySummary = NonNullable<
  MapEditPlan["summary"]["tileCopies"]
>[number];

type CopyRegionPreview = Omit<
  TileCopySummary,
  "operationIndex"
> & {
  type: "copyRegion";
  destructive: true;
  warning: string;
};

describe("copyRegion", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("copies exact encoded GIDs across offset layers and clears from a zero source cell", async () => {
    const allFlags =
      (
        GID_FLIP_HORIZONTAL |
        GID_FLIP_VERTICAL |
        GID_DIAGONAL_OR_HEX_60 |
        GID_HEX_120 |
        6
      ) >>> 0;
    const sourceData = [
      1,
      0,
      (GID_FLIP_HORIZONTAL | 2) >>> 0,
      (GID_FLIP_VERTICAL | 3) >>> 0,
      (GID_DIAGONAL_OR_HEX_60 | 4) >>> 0,
      allFlags,
    ];
    const harness = await createHarness(roots, {
      layers: [
        layer(
          SOURCE_LAYER_ID,
          "Source",
          3,
          2,
          -2,
          5,
          sourceData,
        ),
        layer(
          DESTINATION_LAYER_ID,
          "Destination",
          3,
          2,
          10,
          -3,
          Array.from({ length: 6 }, () => 16),
        ),
      ],
    });
    const operation: CopyRegionOperation = {
      type: "copyRegion",
      source: {
        layerId: SOURCE_LAYER_ID,
        x: -2,
        y: 5,
        width: 3,
        height: 2,
      },
      destination: {
        layerId: DESTINATION_LAYER_ID,
        x: 10,
        y: -3,
      },
    };
    const edit = await plan(harness.service, [
      operation,
    ]);

    expect(edit.summary).toMatchObject({
      operationCount: 1,
      cellWrites: 6,
      affectedLayerIds: [DESTINATION_LAYER_ID],
      affectedTileLayerIds: [
        DESTINATION_LAYER_ID,
      ],
      tileCopies: [
        {
          operationIndex: 0,
          source: operation.source,
          destination: {
            ...operation.destination,
            width: 3,
            height: 2,
          },
          scannedCellCount: 12,
          cellCount: 6,
          sourceNonEmptyCellCount: 5,
          changedCellCount: 6,
          overwrittenNonEmptyCellCount: 6,
          clearedCellCount: 1,
          overlapsSource: false,
          wouldChange: true,
        },
      ],
    });
    const preview = new ChangeSetRegistry().put(
      edit,
    ).operations[0] as CopyRegionPreview;
    expect(preview).toMatchObject({
      type: "copyRegion",
      destructive: true,
      warning: expect.any(String),
      source: operation.source,
      destination: {
        ...operation.destination,
        width: 3,
        height: 2,
      },
      scannedCellCount: 12,
      cellCount: 6,
      sourceNonEmptyCellCount: 5,
      changedCellCount: 6,
      overwrittenNonEmptyCellCount: 6,
      clearedCellCount: 1,
      overlapsSource: false,
      wouldChange: true,
    });

    await harness.service.applyEdits(edit);
    expect(
      await readLayerData(
        harness.root,
        DESTINATION_LAYER_ID,
      ),
    ).toEqual(sourceData);
    expect(
      await readLayerData(
        harness.root,
        SOURCE_LAYER_ID,
      ),
    ).toEqual(sourceData);
  });

  it.each([
    {
      label: "forward",
      sourceX: 0,
      destinationX: 2,
      expected: [1, 2, 1, 2, 3, 4],
    },
    {
      label: "backward",
      sourceX: 2,
      destinationX: 0,
      expected: [3, 4, 5, 6, 5, 6],
    },
  ])(
    "uses a source snapshot for a same-layer $label overlap",
    async ({
      sourceX,
      destinationX,
      expected,
    }) => {
      const harness = await createHarness(roots, {
        layers: [
          layer(
            SOURCE_LAYER_ID,
            "Shared",
            6,
            1,
            0,
            0,
            [1, 2, 3, 4, 5, 6],
          ),
        ],
      });
      const edit = await plan(harness.service, [
        copyRegion(
          SOURCE_LAYER_ID,
          sourceX,
          0,
          4,
          1,
          SOURCE_LAYER_ID,
          destinationX,
          0,
        ),
      ]);

      expect(requireCopySummary(edit)).toMatchObject({
        scannedCellCount: 8,
        cellCount: 4,
        changedCellCount: 4,
        overwrittenNonEmptyCellCount: 4,
        clearedCellCount: 0,
        overlapsSource: true,
        wouldChange: true,
      });
      await harness.service.applyEdits(edit);
      expect(
        await readLayerData(
          harness.root,
          SOURCE_LAYER_ID,
        ),
      ).toEqual(expected);
    },
  );

  it.each([
    {
      label: "downward",
      sourceY: 0,
      destinationY: 1,
      expected: [
        1, 2,
        1, 2,
        3, 4,
        5, 6,
      ],
    },
    {
      label: "upward",
      sourceY: 1,
      destinationY: 0,
      expected: [
        3, 4,
        5, 6,
        7, 8,
        7, 8,
      ],
    },
  ])(
    "uses a source snapshot for a same-layer $label overlap",
    async ({
      sourceY,
      destinationY,
      expected,
    }) => {
      const harness = await createHarness(roots, {
        layers: [
          layer(
            SOURCE_LAYER_ID,
            "Shared",
            2,
            4,
            0,
            0,
            [1, 2, 3, 4, 5, 6, 7, 8],
          ),
        ],
      });
      const edit = await plan(harness.service, [
        copyRegion(
          SOURCE_LAYER_ID,
          0,
          sourceY,
          2,
          3,
          SOURCE_LAYER_ID,
          0,
          destinationY,
        ),
      ]);

      expect(requireCopySummary(edit)).toMatchObject({
        scannedCellCount: 12,
        cellCount: 6,
        changedCellCount: 6,
        overwrittenNonEmptyCellCount: 6,
        clearedCellCount: 0,
        overlapsSource: true,
        wouldChange: true,
      });
      await harness.service.applyEdits(edit);
      expect(
        await readLayerData(
          harness.root,
          SOURCE_LAYER_ID,
        ),
      ).toEqual(expected);
    },
  );

  it("uses one snapshot when overlap shifts on both axes", async () => {
    const harness = await createHarness(roots, {
      layers: [
        layer(
          SOURCE_LAYER_ID,
          "Shared",
          3,
          3,
          -5,
          7,
          [1, 2, 3, 4, 5, 6, 7, 8, 9],
        ),
      ],
    });
    const edit = await plan(harness.service, [
      copyRegion(
        SOURCE_LAYER_ID,
        -5,
        7,
        2,
        2,
        SOURCE_LAYER_ID,
        -4,
        8,
      ),
    ]);

    expect(requireCopySummary(edit)).toMatchObject({
      scannedCellCount: 8,
      cellCount: 4,
      changedCellCount: 4,
      overwrittenNonEmptyCellCount: 4,
      overlapsSource: true,
      wouldChange: true,
    });
    await harness.service.applyEdits(edit);
    expect(
      await readLayerData(
        harness.root,
        SOURCE_LAYER_ID,
      ),
    ).toEqual([1, 2, 3, 4, 1, 2, 7, 4, 5]);
  });

  it("observes earlier edits at the source and allows later edits to win at the destination", async () => {
    const harness = await createHarness(roots, {
      layers: [
        layer(
          SOURCE_LAYER_ID,
          "Source",
          2,
          1,
          0,
          0,
          [1, 2],
        ),
        layer(
          DESTINATION_LAYER_ID,
          "Destination",
          2,
          1,
          0,
          0,
          [3, 4],
        ),
      ],
    });
    const snapshot = await mapSnapshot(
      harness.service,
    );
    const edit = await plan(
      harness.service,
      [
        {
          type: "setTiles",
          layerId: SOURCE_LAYER_ID,
          cells: [
            {
              x: 0,
              y: 0,
              tile: tile(
                snapshot.tilesetAssetId,
                4,
              ),
            },
          ],
        },
        copyRegion(
          SOURCE_LAYER_ID,
          0,
          0,
          2,
          1,
          DESTINATION_LAYER_ID,
          0,
          0,
        ),
        {
          type: "setTiles",
          layerId: DESTINATION_LAYER_ID,
          cells: [
            {
              x: 1,
              y: 0,
              tile: tile(
                snapshot.tilesetAssetId,
                5,
              ),
            },
          ],
        },
      ],
      snapshot,
    );

    expect(requireCopySummary(edit)).toMatchObject({
      operationIndex: 1,
      sourceNonEmptyCellCount: 2,
      changedCellCount: 2,
    });
    await harness.service.applyEdits(edit);
    expect(
      await readLayerData(
        harness.root,
        SOURCE_LAYER_ID,
      ),
    ).toEqual([5, 2]);
    expect(
      await readLayerData(
        harness.root,
        DESTINATION_LAYER_ID,
      ),
    ).toEqual([5, 6]);
  });

  it.each([
    {
      label: "source left",
      operation: copyRegion(
        SOURCE_LAYER_ID,
        -3,
        5,
        1,
        1,
        DESTINATION_LAYER_ID,
        10,
        -3,
      ),
      code: "REGION_OUT_OF_BOUNDS",
    },
    {
      label: "source right",
      operation: copyRegion(
        SOURCE_LAYER_ID,
        0,
        5,
        2,
        1,
        DESTINATION_LAYER_ID,
        10,
        -3,
      ),
      code: "REGION_OUT_OF_BOUNDS",
    },
    {
      label: "source top",
      operation: copyRegion(
        SOURCE_LAYER_ID,
        -2,
        4,
        1,
        1,
        DESTINATION_LAYER_ID,
        10,
        -3,
      ),
      code: "REGION_OUT_OF_BOUNDS",
    },
    {
      label: "source bottom",
      operation: copyRegion(
        SOURCE_LAYER_ID,
        -2,
        6,
        1,
        2,
        DESTINATION_LAYER_ID,
        10,
        -3,
      ),
      code: "REGION_OUT_OF_BOUNDS",
    },
    {
      label: "destination left",
      operation: copyRegion(
        SOURCE_LAYER_ID,
        -2,
        5,
        1,
        1,
        DESTINATION_LAYER_ID,
        9,
        -3,
      ),
      code: "REGION_OUT_OF_BOUNDS",
    },
    {
      label: "destination right",
      operation: copyRegion(
        SOURCE_LAYER_ID,
        -2,
        5,
        2,
        1,
        DESTINATION_LAYER_ID,
        12,
        -3,
      ),
      code: "REGION_OUT_OF_BOUNDS",
    },
    {
      label: "destination top",
      operation: copyRegion(
        SOURCE_LAYER_ID,
        -2,
        5,
        1,
        1,
        DESTINATION_LAYER_ID,
        10,
        -4,
      ),
      code: "REGION_OUT_OF_BOUNDS",
    },
    {
      label: "destination bottom",
      operation: copyRegion(
        SOURCE_LAYER_ID,
        -2,
        5,
        1,
        2,
        DESTINATION_LAYER_ID,
        10,
        -2,
      ),
      code: "REGION_OUT_OF_BOUNDS",
    },
    {
      label: "unsafe source endpoint",
      operation: copyRegion(
        SOURCE_LAYER_ID,
        Number.MAX_SAFE_INTEGER,
        5,
        2,
        1,
        DESTINATION_LAYER_ID,
        10,
        -3,
      ),
      code: "INVALID_ARGUMENT",
    },
  ])(
    "rejects an all-or-nothing $label region",
    async ({ operation, code }) => {
      const harness = await createHarness(roots, {
        layers: [
          layer(
            SOURCE_LAYER_ID,
            "Source",
            3,
            2,
            -2,
            5,
            [1, 2, 3, 4, 5, 6],
          ),
          layer(
            DESTINATION_LAYER_ID,
            "Destination",
            3,
            2,
            10,
            -3,
            [6, 5, 4, 3, 2, 1],
          ),
        ],
      });
      const mapPath = join(
        harness.root,
        MAP_PATH,
      );
      const before = await readFile(mapPath);

      await expect(
        plan(harness.service, [operation]),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code,
      });
      expect(await readFile(mapPath)).toEqual(
        before,
      );
    },
  );

  it("rejects non-canonical shapes, ids, coordinates and dimensions", async () => {
    const harness = await createHarness(roots);
    const valid = copyRegion(
      SOURCE_LAYER_ID,
      0,
      0,
      1,
      1,
      DESTINATION_LAYER_ID,
      0,
      0,
    );
    const malformed: unknown[] = [
      { ...valid, extra: true },
      {
        ...valid,
        source: {
          ...valid.source,
          extra: true,
        },
      },
      {
        ...valid,
        destination: {
          ...valid.destination,
          extra: true,
        },
      },
      {
        type: "copyRegion",
        source: {
          layerId: SOURCE_LAYER_ID,
          x: 0,
          y: 0,
          height: 1,
        },
        destination: valid.destination,
      },
      {
        ...valid,
        source: {
          ...valid.source,
          layerId: 0,
        },
      },
      {
        ...valid,
        destination: {
          ...valid.destination,
          layerId: -1,
        },
      },
      {
        ...valid,
        source: {
          ...valid.source,
          layerId: 1.5,
        },
      },
      {
        ...valid,
        source: {
          ...valid.source,
          x: 0.5,
        },
      },
      {
        ...valid,
        destination: {
          ...valid.destination,
          y: Number.MAX_SAFE_INTEGER + 1,
        },
      },
      {
        ...valid,
        source: {
          ...valid.source,
          width: 0,
        },
      },
      {
        ...valid,
        source: {
          ...valid.source,
          width: -1,
        },
      },
      {
        ...valid,
        source: {
          ...valid.source,
          width: 1.5,
        },
      },
      {
        ...valid,
        source: {
          ...valid.source,
          height: 0,
        },
      },
    ];
    for (const operation of malformed) {
      await expect(
        planRaw(harness.service, [operation]),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "INVALID_ARGUMENT",
      });
    }

    for (const operation of [
      copyRegion(
        999,
        0,
        0,
        1,
        1,
        DESTINATION_LAYER_ID,
        0,
        0,
      ),
      copyRegion(
        SOURCE_LAYER_ID,
        0,
        0,
        1,
        1,
        999,
        0,
        0,
      ),
    ]) {
      await expect(
        plan(harness.service, [operation]),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "LAYER_NOT_FOUND",
      });
    }
  });

  it.each([
    {
      label: "source non-integer",
      sourceData: [1.5],
      destinationData: [1],
      code: "INVALID_TILE_DATA",
    },
    {
      label: "destination flag-only zero",
      sourceData: [1],
      destinationData: [GID_FLIP_HORIZONTAL],
      code: "INVALID_GID",
    },
    {
      label: "source out-of-range",
      sourceData: [17],
      destinationData: [1],
      code: "GID_OUT_OF_RANGE",
    },
    {
      label: "destination greater than uint32",
      sourceData: [1],
      destinationData: [0x1_0000_0000],
      code: "INVALID_GID",
    },
  ])(
    "fails closed on a malformed observed GID at the $label",
    async ({
      sourceData,
      destinationData,
      code,
    }) => {
      const harness = await createHarness(roots, {
        layers: [
          layer(
            SOURCE_LAYER_ID,
            "Source",
            1,
            1,
            0,
            0,
            sourceData,
          ),
          layer(
            DESTINATION_LAYER_ID,
            "Destination",
            1,
            1,
            0,
            0,
            destinationData,
          ),
        ],
      });
      const mapPath = join(
        harness.root,
        MAP_PATH,
      );
      const before = await readFile(mapPath);

      await expect(
        plan(harness.service, [
          copyRegion(
            SOURCE_LAYER_ID,
            0,
            0,
            1,
            1,
            DESTINATION_LAYER_ID,
            0,
            0,
          ),
        ]),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code,
      });
      expect(await readFile(mapPath)).toEqual(
        before,
      );
    },
  );

  it("enforces the exact shared scan and write boundaries", async () => {
    const exactData =
      new Array<number>(800_000).fill(1);
    exactData.fill(0, 0, MAX_COPY_CELL_WRITES);
    const exact = await createHarness(roots, {
      compactMap: true,
      layers: [
        layer(
          SOURCE_LAYER_ID,
          "Large",
          800_000,
          1,
          0,
          0,
          exactData,
        ),
      ],
    });
    const exactSnapshot = await mapSnapshot(
      exact.service,
    );
    const exactPlan = await plan(
      exact.service,
      [
        {
          type: "replaceTiles",
          layerId: SOURCE_LAYER_ID,
          mappings: [
            {
              from: tile(
                exactSnapshot.tilesetAssetId,
                15,
              ),
              to: tile(
                exactSnapshot.tilesetAssetId,
                14,
              ),
            },
          ],
        },
        copyRegion(
          SOURCE_LAYER_ID,
          0,
          0,
          MAX_COPY_CELL_WRITES,
          1,
          SOURCE_LAYER_ID,
          MAX_COPY_CELL_WRITES,
          0,
        ),
      ],
      exactSnapshot,
    );
    expect(exactPlan.summary).toMatchObject({
      cellWrites: MAX_COPY_CELL_WRITES,
      tileReplacements: [
        {
          scannedCellCount: 800_000,
          replacedCellCount: 0,
        },
      ],
      tileCopies: [
        {
          operationIndex: 1,
          scannedCellCount: 200_000,
          cellCount: MAX_COPY_CELL_WRITES,
          changedCellCount:
            MAX_COPY_CELL_WRITES,
          clearedCellCount:
            MAX_COPY_CELL_WRITES,
        },
      ],
    });
    expect(
      800_000 +
        requireCopySummary(exactPlan)
          .scannedCellCount,
    ).toBe(MAX_TILE_OPERATION_SCANS);
    const sharedScanTamper =
      structuredClone(exactPlan);
    const replacementSummary =
      sharedScanTamper.summary
        .tileReplacements?.[0];
    if (replacementSummary === undefined) {
      throw new Error(
        "Expected a replacement summary.",
      );
    }
    replacementSummary.scannedCellCount += 1;
    refreshPlanDigest(sharedScanTamper);
    expect(() =>
      new ChangeSetRegistry().put(
        sharedScanTamper,
      ),
    ).toThrow(/shared tile-operation accounting/u);

    const writeOverData =
      new Array<number>(200_002).fill(1);
    writeOverData.fill(0, 0, 100_001);
    const writeOver = await createHarness(roots, {
      compactMap: true,
      layers: [
        layer(
          SOURCE_LAYER_ID,
          "Write over",
          200_002,
          1,
          0,
          0,
          writeOverData,
        ),
      ],
    });
    await expect(
      plan(writeOver.service, [
        copyRegion(
          SOURCE_LAYER_ID,
          0,
          0,
          100_001,
          1,
          SOURCE_LAYER_ID,
          100_001,
          0,
        ),
      ]),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        limit: MAX_COPY_CELL_WRITES,
      },
    });

    const scanOverData =
      new Array<number>(800_001).fill(1);
    scanOverData.fill(
      0,
      0,
      MAX_COPY_CELL_WRITES,
    );
    const scanOver = await createHarness(roots, {
      compactMap: true,
      layers: [
        layer(
          SOURCE_LAYER_ID,
          "Scan over",
          800_001,
          1,
          0,
          0,
          scanOverData,
        ),
      ],
    });
    const scanOverSnapshot = await mapSnapshot(
      scanOver.service,
    );
    await expect(
      plan(
        scanOver.service,
        [
          {
            type: "replaceTiles",
            layerId: SOURCE_LAYER_ID,
            mappings: [
              {
                from: tile(
                  scanOverSnapshot.tilesetAssetId,
                  15,
                ),
                to: tile(
                  scanOverSnapshot.tilesetAssetId,
                  14,
                ),
              },
            ],
          },
          copyRegion(
            SOURCE_LAYER_ID,
            0,
            0,
            MAX_COPY_CELL_WRITES,
            1,
            SOURCE_LAYER_ID,
            MAX_COPY_CELL_WRITES,
            0,
          ),
        ],
        scanOverSnapshot,
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        limit: MAX_TILE_OPERATION_SCANS,
      },
    });
  }, 30_000);

  it("keeps exact source bytes for a semantic no-op copy", async () => {
    const data = [
      1,
      0,
      (GID_FLIP_HORIZONTAL | 2) >>> 0,
    ];
    const harness = await createHarness(roots, {
      layers: [
        layer(
          SOURCE_LAYER_ID,
          "Source",
          3,
          1,
          0,
          0,
          data,
        ),
        layer(
          DESTINATION_LAYER_ID,
          "Destination",
          3,
          1,
          0,
          0,
          [...data],
        ),
      ],
    });
    const mapPath = join(harness.root, MAP_PATH);
    const before = await readFile(mapPath);
    const edit = await plan(harness.service, [
      copyRegion(
        SOURCE_LAYER_ID,
        0,
        0,
        3,
        1,
        DESTINATION_LAYER_ID,
        0,
        0,
      ),
    ]);

    expect(edit.summary).toMatchObject({
      cellWrites: 3,
      affectedLayerIds: [],
      affectedTileLayerIds: [],
      tileCopies: [
        {
          changedCellCount: 0,
          clearedCellCount: 0,
          wouldChange: false,
        },
      ],
    });
    const result =
      await harness.service.applyEdits(edit);
    expect(result).toMatchObject({
      changed: false,
      checkpointId: null,
      beforeRevision: edit.baseRevision,
      revision: edit.baseRevision,
    });
    expect(await readFile(mapPath)).toEqual(before);
  });

  it("patches only destination data in a BOM/CRLF document", async () => {
    const layers = [
      layer(
        SOURCE_LAYER_ID,
        "Source",
        2,
        1,
        0,
        0,
        [1, 2],
      ),
      layer(
        DESTINATION_LAYER_ID,
        "Destination",
        2,
        1,
        0,
        0,
        [3, 4],
      ),
    ];
    const harness = await createHarness(roots, {
      layers,
    });
    const document = baseMap(layers);
    const sourceLayer = (
      document.layers as JsonObject[]
    )[0];
    const destinationLayer = (
      document.layers as JsonObject[]
    )[1];
    if (
      sourceLayer === undefined ||
      destinationLayer === undefined
    ) {
      throw new Error(
        "Expected both fixture tile layers.",
      );
    }
    sourceLayer.vendorSourceExtension = {
      preserve: ["source", 17],
    };
    destinationLayer.vendorDestinationExtension = {
      preserve: ["destination", 19],
    };
    document.vendorRootExtension = {
      preserve: { exact: "outside-data" },
    };
    const source =
      `\uFEFF${JSON.stringify(
        document,
        null,
        "\t",
      )
        .replace(
          '"compressionlevel": -1',
          '"compressionlevel": -1.000e+0',
        )
        .replace(/\n/gu, "\r\n")}\r\n`;
    const mapPath = join(harness.root, MAP_PATH);
    await writeFile(mapPath, source, "utf8");
    const before = await readFile(mapPath, "utf8");
    const destinationDataPath: JSONPath = [
      "layers",
      1,
      "data",
    ];
    const sourceDataLexeme = sourceValueAt(
      before,
      ["layers", 0, "data"],
    );
    const edit = await plan(harness.service, [
      copyRegion(
        SOURCE_LAYER_ID,
        0,
        0,
        2,
        1,
        DESTINATION_LAYER_ID,
        0,
        0,
      ),
    ]);

    await harness.service.applyEdits(edit);
    const after = await readFile(mapPath, "utf8");
    expect(
      maskJsonValues(after, [
        destinationDataPath,
      ]),
    ).toBe(
      maskJsonValues(before, [
        destinationDataPath,
      ]),
    );
    expect(
      sourceValueAt(after, [
        "layers",
        0,
        "data",
      ]),
    ).toBe(sourceDataLexeme);
    expect(after.startsWith("\uFEFF")).toBe(true);
    expect(after).toContain(
      '"compressionlevel": -1.000e+0',
    );
    expect(after).toContain("\r\n");
    expect(
      await readLayerData(
        harness.root,
        DESTINATION_LAYER_ID,
      ),
    ).toEqual([1, 2]);
  });

  it("rejects operation and preview-summary tampering", async () => {
    const harness = await createHarness(roots);
    const edit = await plan(harness.service, [
      copyRegion(
        SOURCE_LAYER_ID,
        0,
        0,
        2,
        1,
        DESTINATION_LAYER_ID,
        0,
        0,
      ),
    ]);
    const mapPath = join(harness.root, MAP_PATH);
    const before = await readFile(mapPath);
    const operationTamper = structuredClone(edit);
    const operation = operationTamper.operations[0];
    if (operation?.type !== "copyRegion") {
      throw new Error(
        "Expected a copyRegion operation.",
      );
    }
    operation.destination.x += 1;
    await expect(
      harness.service.applyEdits(operationTamper),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "CHANGE_SET_TAMPERED",
    });
    expect(await readFile(mapPath)).toEqual(before);

    const staleDigest = structuredClone(edit);
    requireCopySummary(
      staleDigest,
    ).changedCellCount += 1;
    expect(() =>
      new ChangeSetRegistry().put(staleDigest),
    ).toThrow(/copyRegion|digest/u);

    const impossibleCounts = structuredClone(edit);
    const impossibleSummary =
      requireCopySummary(impossibleCounts);
    impossibleSummary.sourceNonEmptyCellCount = 0;
    impossibleSummary.overwrittenNonEmptyCellCount =
      0;
    impossibleSummary.changedCellCount = 1;
    impossibleSummary.clearedCellCount = 0;
    impossibleSummary.wouldChange = true;
    refreshPlanDigest(impossibleCounts);
    expect(() =>
      new ChangeSetRegistry().put(
        impossibleCounts,
      ),
    ).toThrow(/copyRegion/u);

    const underreportedWrites =
      structuredClone(edit);
    underreportedWrites.summary.cellWrites =
      requireCopySummary(underreportedWrites)
        .cellCount - 1;
    refreshPlanDigest(underreportedWrites);
    expect(() =>
      new ChangeSetRegistry().put(
        underreportedWrites,
      ),
    ).toThrow(/shared tile-operation accounting/u);

    const semanticMismatch = structuredClone(edit);
    requireCopySummary(
      semanticMismatch,
    ).source.x += 1;
    refreshPlanDigest(semanticMismatch);
    expect(() =>
      new ChangeSetRegistry().put(
        semanticMismatch,
      ),
    ).toThrow(/copyRegion/u);

    const duplicate = structuredClone(edit);
    const duplicateSummary =
      requireCopySummary(duplicate);
    duplicate.summary.tileCopies?.push(
      structuredClone(duplicateSummary),
    );
    refreshPlanDigest(duplicate);
    expect(() =>
      new ChangeSetRegistry().put(duplicate),
    ).toThrow(/copyRegion/u);
  });

  it("rejects stale map and dependency revisions without changing current bytes", async () => {
    const staleMapHarness =
      await createHarness(roots);
    const staleMapPlan = await plan(
      staleMapHarness.service,
      [
        copyRegion(
          SOURCE_LAYER_ID,
          0,
          0,
          2,
          1,
          DESTINATION_LAYER_ID,
          0,
          0,
        ),
      ],
    );
    const staleMapPath = join(
      staleMapHarness.root,
      MAP_PATH,
    );
    const externalMap = JSON.parse(
      await readFile(staleMapPath, "utf8"),
    ) as JsonObject;
    externalMap.vendorExternalEdit = true;
    await writeJson(staleMapPath, externalMap);
    const externalMapBytes =
      await readFile(staleMapPath);
    await expect(
      staleMapHarness.service.applyEdits(
        staleMapPlan,
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "REVISION_CONFLICT",
    });
    expect(await readFile(staleMapPath)).toEqual(
      externalMapBytes,
    );

    const dependencyHarness =
      await createHarness(roots);
    const dependencyPlan = await plan(
      dependencyHarness.service,
      [
        copyRegion(
          SOURCE_LAYER_ID,
          0,
          0,
          2,
          1,
          DESTINATION_LAYER_ID,
          0,
          0,
        ),
      ],
    );
    const dependencyMapPath = join(
      dependencyHarness.root,
      MAP_PATH,
    );
    const beforeDependencyConflict =
      await readFile(dependencyMapPath);
    const changedTileset = baseTileset();
    changedTileset.vendorExternalEdit = true;
    await writeJson(
      join(
        dependencyHarness.root,
        TILESET_PATH,
      ),
      changedTileset,
    );
    await expect(
      dependencyHarness.service.applyEdits(
        dependencyPlan,
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DEPENDENCY_REVISION_CONFLICT",
    });
    expect(
      await readFile(dependencyMapPath),
    ).toEqual(beforeDependencyConflict);
  });

  it("survives a real Tiled 1.12 JSON export round-trip when the CLI is available", async () => {
    const sourceData = [
      1,
      0,
      (GID_FLIP_HORIZONTAL | 2) >>> 0,
      3,
    ];
    const harness = await createHarness(roots, {
      layers: [
        layer(
          SOURCE_LAYER_ID,
          "Source",
          2,
          2,
          0,
          0,
          sourceData,
        ),
        layer(
          DESTINATION_LAYER_ID,
          "Destination",
          2,
          2,
          0,
          0,
          [4, 4, 4, 4],
        ),
      ],
    });
    const edit = await plan(harness.service, [
      copyRegion(
        SOURCE_LAYER_ID,
        0,
        0,
        2,
        2,
        DESTINATION_LAYER_ID,
        0,
        0,
      ),
    ]);
    await harness.service.applyEdits(edit);

    const outputPath = join(
      harness.root,
      "maps",
      "roundtrip.tmj",
    );
    try {
      await execFileAsync(
        process.env.TILED_CLI_PATH ?? "tiled",
        [
          "--export-map",
          "json",
          join(harness.root, MAP_PATH),
          outputPath,
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
      if (hasErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }

    const exported = JSON.parse(
      await readFile(outputPath, "utf8"),
    ) as JsonObject;
    expect(
      requireLayer(
        exported,
        DESTINATION_LAYER_ID,
      ).data,
    ).toEqual(sourceData);
  }, 40_000);
});

async function createHarness(
  roots: Set<string>,
  options: HarnessOptions = {},
): Promise<Harness> {
  const layers =
    options.layers ?? defaultLayers();
  for (const candidate of layers) {
    if (
      candidate.data.length !==
      candidate.width * candidate.height
    ) {
      throw new Error(
        `Fixture layer ${candidate.id} data length must equal width × height.`,
      );
    }
  }
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-copy-region-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  const map = baseMap(layers);
  if (options.compactMap === true) {
    await writeFile(
      join(root, MAP_PATH),
      JSON.stringify(map),
      "utf8",
    );
  } else {
    await writeJson(join(root, MAP_PATH), map);
  }
  await writeJson(
    join(root, TILESET_PATH),
    baseTileset(),
  );
  await writeFile(
    join(root, "tiles", "terrain.svg"),
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">',
      '<rect width="64" height="64" fill="#4c8f45"/>',
      '<path d="M0 32h64M32 0v64" stroke="#274f27"/>',
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

function defaultLayers(): LayerFixture[] {
  return [
    layer(
      SOURCE_LAYER_ID,
      "Source",
      4,
      2,
      0,
      0,
      [1, 2, 3, 4, 5, 6, 7, 8],
    ),
    layer(
      DESTINATION_LAYER_ID,
      "Destination",
      4,
      2,
      0,
      0,
      [8, 7, 6, 5, 4, 3, 2, 1],
    ),
  ];
}

function layer(
  id: number,
  name: string,
  width: number,
  height: number,
  x: number,
  y: number,
  data: number[],
): LayerFixture {
  return {
    id,
    name,
    width,
    height,
    x,
    y,
    data,
  };
}

function baseMap(
  layers: readonly LayerFixture[],
): JsonObject {
  const maximumLayerId = Math.max(
    0,
    ...layers.map(({ id }) => id),
  );
  return {
    compressionlevel: -1,
    height: Math.max(
      1,
      ...layers.map(({ height }) => height),
    ),
    infinite: false,
    layers: layers.map((candidate) => ({
      data: [...candidate.data],
      height: candidate.height,
      id: candidate.id,
      name: candidate.name,
      opacity: 1,
      type: "tilelayer",
      visible: true,
      width: candidate.width,
      x: candidate.x,
      y: candidate.y,
    })),
    nextlayerid: maximumLayerId + 1,
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
    vendorRootExtension: {
      preserve: ["root", 23],
    },
    version: "1.10",
    width: Math.max(
      1,
      ...layers.map(({ width }) => width),
    ),
  };
}

function baseTileset(): JsonObject {
  return {
    columns: 4,
    image: "terrain.svg",
    imageheight: 64,
    imagewidth: 64,
    margin: 0,
    name: "Terrain",
    spacing: 0,
    tilecount: 16,
    tileheight: 16,
    tilewidth: 16,
    tiledversion: "1.12.2",
    type: "tileset",
    version: "1.10",
  };
}

function copyRegion(
  sourceLayerId: number,
  sourceX: number,
  sourceY: number,
  width: number,
  height: number,
  destinationLayerId: number,
  destinationX: number,
  destinationY: number,
): CopyRegionOperation {
  return {
    type: "copyRegion",
    source: {
      layerId: sourceLayerId,
      x: sourceX,
      y: sourceY,
      width,
      height,
    },
    destination: {
      layerId: destinationLayerId,
      x: destinationX,
      y: destinationY,
    },
  };
}

function tile(
  assetId: string,
  localId: number,
  transform?: TileRef["transform"],
): TileRef {
  return {
    tileset: {
      kind: "external",
      assetId,
    },
    localId,
    ...(transform === undefined
      ? {}
      : { transform }),
  };
}

async function plan(
  service: MapService,
  operations: MapEditOperation[],
  suppliedSnapshot?: MapSnapshot,
): Promise<MapEditPlan> {
  const snapshot =
    suppliedSnapshot ??
    (await mapSnapshot(service));
  return service.planEdits(
    MAP_PATH,
    snapshot.revision,
    snapshot.dependencies,
    operations,
  );
}

async function planRaw(
  service: MapService,
  operations: unknown[],
): Promise<MapEditPlan> {
  const snapshot = await mapSnapshot(service);
  return service.planEdits(
    MAP_PATH,
    snapshot.revision,
    snapshot.dependencies,
    operations as MapEditOperation[],
  );
}

async function mapSnapshot(
  service: MapService,
): Promise<MapSnapshot> {
  const summary = await service.getSummary(MAP_PATH);
  const tileset = (
    summary.tilesets as Array<{
      assetId: string;
    }>
  )[0];
  if (tileset === undefined) {
    throw new Error(
      "Expected one external tileset.",
    );
  }
  return {
    revision: summary.revision as string,
    dependencies:
      summary.dependencyRevisions as Record<
        string,
        string
      >,
    tilesetAssetId: tileset.assetId,
  };
}

function requireCopySummary(
  plan: MapEditPlan,
): TileCopySummary {
  const summary = plan.summary.tileCopies?.[0];
  if (summary === undefined) {
    throw new Error(
      "Expected one tile-copy summary.",
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

async function readMap(root: string): Promise<JsonObject> {
  return JSON.parse(
    (
      await readFile(
        join(root, MAP_PATH),
        "utf8",
      )
    ).replace(/^\uFEFF/u, ""),
  ) as JsonObject;
}

async function readLayerData(
  root: string,
  layerId: number,
): Promise<number[]> {
  const layerObject = requireLayer(
    await readMap(root),
    layerId,
  );
  if (!Array.isArray(layerObject.data)) {
    throw new Error(
      `Expected numeric data for layer ${layerId}.`,
    );
  }
  return layerObject.data as number[];
}

function requireLayer(
  map: JsonObject,
  layerId: number,
): JsonObject {
  const pending = [
    ...(map.layers as JsonObject[]),
  ];
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate === undefined) {
      continue;
    }
    if (candidate.id === layerId) {
      return candidate;
    }
    if (Array.isArray(candidate.layers)) {
      pending.push(
        ...(candidate.layers as JsonObject[]),
      );
    }
  }
  throw new Error(
    `Missing fixture layer ${layerId}.`,
  );
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
    throw new Error(
      "Expected a valid JSON fixture.",
    );
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
      marker:
        `<masked:${JSON.stringify(path)}>`,
    };
  });
  ranges.sort(
    (left, right) =>
      right.offset - left.offset,
  );
  for (const range of ranges) {
    body =
      body.slice(0, range.offset) +
      range.marker +
      body.slice(
        range.offset + range.length,
      );
  }
  return `${hasBom ? "\uFEFF" : ""}${body}`;
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
    throw new Error(
      "Expected a valid JSON fixture.",
    );
  }
  const node = findNodeAtLocation(tree, path);
  if (node === undefined) {
    throw new Error(
      `Missing JSON source path ${JSON.stringify(path)}.`,
    );
  }
  return body.slice(
    node.offset,
    node.offset + node.length,
  );
}

function hasErrorCode(
  value: unknown,
  code: string,
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    (value as { code?: unknown }).code ===
      code
  );
}
