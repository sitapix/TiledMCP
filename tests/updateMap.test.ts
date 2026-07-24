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
import { MapService } from "../src/maps/mapService.js";
import type {
  MapEditOperation,
  MapEditPlan,
  TileRef,
} from "../src/maps/types.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
const TILE_LAYER_ID = 7;

const RENDER_ORDERS = [
  "right-down",
  "right-up",
  "left-down",
  "left-up",
] as const;

type UpdateMapOperation = Extract<
  MapEditOperation,
  { type: "updateMap" }
>;

interface Harness {
  root: string;
  service: MapService;
}

interface MapSnapshot {
  revision: string;
  dependencies: Record<string, string>;
  tilesetAssetId: string;
}

describe("updateMap", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("maps all root fields and reports their rendering impact", async () => {
    const harness = await createHarness(roots);
    const operations: UpdateMapOperation[] = [
      {
        type: "updateMap",
        patch: {
          renderOrder: "left-up",
          backgroundColor: "#80AABBCC",
          className: "WorldMap",
        },
      },
    ];

    const edit = await plan(harness.service, operations);

    expect(edit.operations).toEqual(operations);
    expect(edit.summary).toMatchObject({
      operationCount: 1,
      cellWrites: 0,
      affectedLayerIds: [],
      affectedTileLayerIds: [],
      affectedObjectLayerIds: [],
      mapUpdates: [
        {
          operationIndex: 0,
          requestedFields: [
            "renderOrder",
            "backgroundColor",
            "className",
          ],
          changedFields: [
            "renderOrder",
            "backgroundColor",
            "className",
          ],
          wouldChange: true,
          renderingMayChange: true,
        },
      ],
    });
    const preview =
      new ChangeSetRegistry().put(edit).operations[0];
    expect(preview).toMatchObject({
      type: "updateMap",
      destructive: false,
      patch: operations[0]?.patch,
      requestedFields: [
        "renderOrder",
        "backgroundColor",
        "className",
      ],
      changedFields: [
        "renderOrder",
        "backgroundColor",
        "className",
      ],
      wouldChange: true,
      renderingMayChange: true,
      warning: expect.any(String),
    });

    const malformedPreview = structuredClone(edit);
    const malformedSummary =
      malformedPreview.summary.mapUpdates?.[0];
    if (malformedSummary === undefined) {
      throw new Error("Expected an updateMap summary.");
    }
    malformedSummary.changedFields = [
      "renderOrder",
      "unknownField",
    ];
    expect(() =>
      new ChangeSetRegistry().put(malformedPreview),
    ).toThrow(/updateMap preview summary/u);
    const malformedShape = structuredClone(edit);
    const malformedShapeSummary =
      malformedShape.summary.mapUpdates?.[0];
    if (malformedShapeSummary === undefined) {
      throw new Error("Expected an updateMap summary.");
    }
    malformedShapeSummary.changedFields =
      null as unknown as string[];
    expect(() =>
      new ChangeSetRegistry().put(malformedShape),
    ).toThrow(/updateMap summaries/u);
    const capacityRegistry = new ChangeSetRegistry(
      60_000,
      1,
    );
    expect(() =>
      capacityRegistry.put(malformedShape),
    ).toThrow(/updateMap summaries/u);
    expect(() =>
      capacityRegistry.put(edit),
    ).not.toThrow();

    const result = await harness.service.applyEdits(edit);
    const saved = await readMap(harness.root);

    expect(result).toMatchObject({
      path: MAP_PATH,
      changed: true,
      changeSetId: edit.id,
    });
    expect(saved).toMatchObject({
      renderorder: "left-up",
      backgroundcolor: "#80AABBCC",
      class: "WorldMap",
    });
    expect(saved).not.toHaveProperty("renderOrder");
    expect(saved).not.toHaveProperty("backgroundColor");
    expect(saved).not.toHaveProperty("className");
    expect(saved.vendorRootExtension).toEqual({
      preserve: ["root", 23],
    });
    expect(saved.layers).toEqual(baseMap().layers);
    await expect(
      harness.service.getSummary(MAP_PATH),
    ).resolves.toMatchObject({
      renderOrder: "left-up",
      backgroundColor: "#80AABBCC",
      className: "WorldMap",
    });
  });

  it("executes updateMap normally in a mixed generic batch and summarizes sequential state", async () => {
    const harness = await createHarness(roots);
    const snapshot = await mapSnapshot(harness.service);
    const operations: MapEditOperation[] = [
      {
        type: "updateMap",
        patch: { className: "SequentialMap" },
      },
      {
        type: "updateLayer",
        layerId: TILE_LAYER_ID,
        patch: { name: "Renamed Ground" },
      },
      {
        type: "updateMap",
        patch: {
          renderOrder: "left-down",
          className: "SequentialMap",
        },
      },
      {
        type: "setTiles",
        layerId: TILE_LAYER_ID,
        cells: [
          {
            x: 1,
            y: 0,
            tile: tile(snapshot.tilesetAssetId, 1),
          },
        ],
      },
    ];

    const edit = await plan(
      harness.service,
      operations,
      snapshot,
    );

    expect(edit.summary).toMatchObject({
      operationCount: 4,
      cellWrites: 1,
      affectedLayerIds: [TILE_LAYER_ID],
      affectedTileLayerIds: [TILE_LAYER_ID],
      updatedLayerIds: [TILE_LAYER_ID],
      mapUpdates: [
        {
          operationIndex: 0,
          requestedFields: ["className"],
          changedFields: ["className"],
          wouldChange: true,
          renderingMayChange: false,
        },
        {
          operationIndex: 2,
          requestedFields: ["renderOrder", "className"],
          changedFields: ["renderOrder"],
          wouldChange: true,
          renderingMayChange: true,
        },
      ],
      layerUpdates: [
        {
          operationIndex: 1,
          layerId: TILE_LAYER_ID,
          changedFields: ["name"],
        },
      ],
    });
    const operationPreviews =
      new ChangeSetRegistry().put(edit).operations;
    expect(operationPreviews[0]).toMatchObject({
      type: "updateMap",
      patch: { className: "SequentialMap" },
      changedFields: ["className"],
      renderingMayChange: false,
    });
    expect(operationPreviews[2]).toMatchObject({
      type: "updateMap",
      patch: {
        renderOrder: "left-down",
        className: "SequentialMap",
      },
      changedFields: ["renderOrder"],
      renderingMayChange: true,
    });

    await harness.service.applyEdits(edit);
    const saved = await readMap(harness.root);
    const layer = requireLayer(saved, TILE_LAYER_ID);

    expect(saved).toMatchObject({
      class: "SequentialMap",
      renderorder: "left-down",
    });
    expect(layer).toMatchObject({
      name: "Renamed Ground",
      data: [1, 2],
    });
  });

  it("distinguishes requested no-ops and null background deletion using sequential state", async () => {
    const harness = await createHarness(roots);
    const edit = await plan(harness.service, [
      {
        type: "updateMap",
        patch: {
          renderOrder: "right-down",
          backgroundColor: "#112233",
          className: "ExistingMapClass",
        },
      },
      {
        type: "updateMap",
        patch: { backgroundColor: null },
      },
      {
        type: "updateMap",
        patch: { backgroundColor: null },
      },
      {
        type: "updateMap",
        patch: {
          renderOrder: "right-down",
          className: "UpdatedClass",
        },
      },
    ]);

    expect(edit.summary).toMatchObject({
      affectedLayerIds: [],
      mapUpdates: [
        {
          operationIndex: 0,
          requestedFields: [
            "renderOrder",
            "backgroundColor",
            "className",
          ],
          changedFields: [],
          wouldChange: false,
          renderingMayChange: false,
        },
        {
          operationIndex: 1,
          requestedFields: ["backgroundColor"],
          changedFields: ["backgroundColor"],
          wouldChange: true,
          renderingMayChange: true,
        },
        {
          operationIndex: 2,
          requestedFields: ["backgroundColor"],
          changedFields: [],
          wouldChange: false,
          renderingMayChange: false,
        },
        {
          operationIndex: 3,
          requestedFields: ["renderOrder", "className"],
          changedFields: ["className"],
          wouldChange: true,
          renderingMayChange: false,
        },
      ],
    });

    await harness.service.applyEdits(edit);
    const saved = await readMap(harness.root);
    expect(saved).not.toHaveProperty("backgroundcolor");
    expect(saved).toHaveProperty("class", "UpdatedClass");

    const mapPath = join(harness.root, MAP_PATH);
    const beforeNoOp = await readFile(mapPath);
    const noOp = await plan(harness.service, [
      {
        type: "updateMap",
        patch: {
          renderOrder: "right-down",
          backgroundColor: null,
          className: "UpdatedClass",
        },
      },
    ]);
    expect(noOp.summary).toMatchObject({
      mapUpdates: [
        {
          changedFields: [],
          wouldChange: false,
          renderingMayChange: false,
        },
      ],
    });

    const result = await harness.service.applyEdits(noOp);
    expect(result.changed).toBe(false);
    expect(await readFile(mapPath)).toEqual(beforeNoOp);
  });

  it("accepts every render order, both color widths, and class-name boundaries", async () => {
    const harness = await createHarness(roots);
    const longClassName = "🌲".repeat(1_024);
    const operations: UpdateMapOperation[] = [
      ...RENDER_ORDERS.map(
        (renderOrder): UpdateMapOperation => ({
          type: "updateMap",
          patch: { renderOrder },
        }),
      ),
      {
        type: "updateMap",
        patch: {
          backgroundColor: "#abcdef",
          className: "",
        },
      },
      {
        type: "updateMap",
        patch: {
          backgroundColor: "#80abcdef",
          className: longClassName,
        },
      },
    ];

    const edit = await plan(harness.service, operations);
    expect(edit.summary.operationCount).toBe(
      operations.length,
    );
    expect(edit.summary).toMatchObject({
      mapUpdates: [
        {
          requestedFields: ["renderOrder"],
          changedFields: [],
          renderingMayChange: false,
        },
        ...RENDER_ORDERS.slice(1).map(() => ({
          requestedFields: ["renderOrder"],
          changedFields: ["renderOrder"],
          renderingMayChange: true,
        })),
        {
          requestedFields: [
            "backgroundColor",
            "className",
          ],
          changedFields: [
            "backgroundColor",
            "className",
          ],
          renderingMayChange: true,
        },
        {
          requestedFields: [
            "backgroundColor",
            "className",
          ],
          changedFields: [
            "backgroundColor",
            "className",
          ],
          renderingMayChange: true,
        },
      ],
    });

    await harness.service.applyEdits(edit);
    const saved = await readMap(harness.root);
    expect(saved).toMatchObject({
      renderorder: "left-up",
      backgroundcolor: "#80abcdef",
      class: longClassName,
    });
  });

  it("inserts explicit defaults into an empty dependency-free map and exposes normalized root properties", async () => {
    const harness = await createHarness(roots);
    const map = baseMap();
    delete map.renderorder;
    delete map.backgroundcolor;
    delete map.class;
    map.layers = [];
    map.tilesets = [];
    map.nextlayerid = 1;
    await writeJson(join(harness.root, MAP_PATH), map);

    const beforeSummary =
      await harness.service.getSummary(MAP_PATH);
    expect(beforeSummary).toMatchObject({
      renderOrder: "right-down",
      dependencyRevisions: {},
      layers: [],
      tilesets: [],
    });
    expect(beforeSummary).not.toHaveProperty(
      "backgroundColor",
    );
    expect(beforeSummary).not.toHaveProperty("className");

    const edit = await harness.service.planEdits(
      MAP_PATH,
      beforeSummary.revision as string,
      {},
      [
        {
          type: "updateMap",
          patch: {
            renderOrder: "right-down",
            backgroundColor: "#abcdef",
            className: "EmptyMap",
          },
        },
      ],
    );
    expect(edit.summary).toMatchObject({
      affectedLayerIds: [],
      mapUpdates: [
        {
          requestedFields: [
            "renderOrder",
            "backgroundColor",
            "className",
          ],
          changedFields: [
            "renderOrder",
            "backgroundColor",
            "className",
          ],
          wouldChange: true,
          renderingMayChange: true,
        },
      ],
    });

    await harness.service.applyEdits(edit);
    await expect(
      harness.service.getSummary(MAP_PATH),
    ).resolves.toMatchObject({
      renderOrder: "right-down",
      backgroundColor: "#abcdef",
      className: "EmptyMap",
      dependencyRevisions: {},
    });
  });

  it("bounds existing map classes by Unicode code point without splitting astral characters", async () => {
    const harness = await createHarness(roots);
    const map = baseMap();
    map.class = `${"A".repeat(1_023)}🌲Z`;
    await writeJson(join(harness.root, MAP_PATH), map);

    const summary =
      await harness.service.getSummary(MAP_PATH);
    expect(summary).toMatchObject({
      className: `${"A".repeat(1_023)}🌲`,
      classNameTruncated: true,
    });
  });

  it.each([
    ["render order", "renderorder", "diagonal"],
    ["null render order", "renderorder", null],
    ["background color", "backgroundcolor", "#abc"],
    ["class", "class", 17],
  ])(
    "rejects an invalid serialized root %s in map summaries",
    async (_label, key, value) => {
      const harness = await createHarness(roots);
      const map = baseMap();
      map[key] = value;
      await writeJson(join(harness.root, MAP_PATH), map);

      await expect(
        harness.service.getSummary(MAP_PATH),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "INVALID_DOCUMENT",
      });
    },
  );

  it.each([
    ["an empty patch", {}],
    ["an unknown patch field", { vendorField: true }],
    [
      "an unsupported render order",
      { renderOrder: "down-right" },
    ],
    ["a short color", { backgroundColor: "#abc" }],
    [
      "a seven-digit color",
      { backgroundColor: "#1234567" },
    ],
    [
      "a nine-digit color",
      { backgroundColor: "#123456789" },
    ],
    [
      "a color without a hash",
      { backgroundColor: "112233" },
    ],
    [
      "a non-hex color",
      { backgroundColor: "#GG1122" },
    ],
    [
      "an overlong class name",
      { className: "x".repeat(1_025) },
    ],
    [
      "an overlong astral class name",
      { className: "🌲".repeat(1_025) },
    ],
    ["a null class name", { className: null }],
  ])("rejects %s", async (_label, invalidPatch) => {
    const harness = await createHarness(roots);
    const operation = {
      type: "updateMap",
      patch: invalidPatch,
    } as unknown as MapEditOperation;

    await expect(
      plan(harness.service, [operation]),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
    });
  });

  it("rejects unknown operation fields and malformed patch containers", async () => {
    const harness = await createHarness(roots);
    const invalidOperations = [
      {
        type: "updateMap",
        patch: { className: "Known" },
        vendorField: true,
      },
      {
        type: "updateMap",
        patch: null,
      },
      {
        type: "updateMap",
        patch: [],
      },
    ] as unknown as MapEditOperation[];

    for (const operation of invalidOperations) {
      await expect(
        plan(harness.service, [operation]),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "INVALID_ARGUMENT",
      });
    }
  });

  it("preserves exact bytes when sequential updates are a net no-op", async () => {
    const harness = await createHarness(roots);
    const mapPath = join(harness.root, MAP_PATH);
    const before = await readFile(mapPath);
    const edit = await plan(harness.service, [
      {
        type: "updateMap",
        patch: {
          renderOrder: "left-up",
          backgroundColor: "#abcdef",
          className: "TemporaryMapClass",
        },
      },
      {
        type: "updateMap",
        patch: {
          renderOrder: "right-down",
          backgroundColor: "#112233",
          className: "ExistingMapClass",
        },
      },
    ]);

    expect(edit.summary).toMatchObject({
      mapUpdates: [
        {
          changedFields: [
            "renderOrder",
            "backgroundColor",
            "className",
          ],
          wouldChange: true,
          renderingMayChange: true,
        },
        {
          changedFields: [
            "renderOrder",
            "backgroundColor",
            "className",
          ],
          wouldChange: true,
          renderingMayChange: true,
        },
      ],
    });

    const result = await harness.service.applyEdits(edit);
    expect(result.changed).toBe(false);
    expect(await readFile(mapPath)).toEqual(before);
  });

  it("patches only changed root members while preserving BOM, CRLF, lexemes, and unrelated subtrees", async () => {
    const harness = await createHarness(roots);
    const map = baseMap();
    delete map.class;
    const unusualSource =
      `\uFEFF${JSON.stringify(map, null, "\t")
        .replace(
          '"compressionlevel": -1',
          '"compressionlevel": -1.000e+0',
        )
        .replace(
          '"opacity": 1,',
          '"opacity": 1.000e+0,',
        )
        .replace(
          '"backgroundcolor": "#112233"',
          '"backgroundcolor": "\\u0023112233"',
        )
        .replace(/\n/gu, "\r\n")}\r\n`;
    const absoluteMapPath = join(harness.root, MAP_PATH);
    await writeFile(
      absoluteMapPath,
      unusualSource,
      "utf8",
    );
    const before = await readFile(
      absoluteMapPath,
      "utf8",
    );
    const edit = await plan(harness.service, [
      {
        type: "updateMap",
        patch: {
          backgroundColor: "#abcdef",
        },
      },
      {
        type: "updateMap",
        patch: {
          renderOrder: "right-up",
          backgroundColor: "#112233",
          className: "InsertedMapClass",
        },
      },
    ]);

    await harness.service.applyEdits(edit);
    const after = await readFile(
      absoluteMapPath,
      "utf8",
    );

    expect(after.startsWith("\uFEFF")).toBe(true);
    expect(after).toContain(
      '"compressionlevel": -1.000e+0',
    );
    expect(after).toContain('"opacity": 1.000e+0');
    expect(after.replace(/\r\n/gu, "")).not.toContain(
      "\n",
    );
    expect(after).toContain(
      '\r\n\t"class": "InsertedMapClass"',
    );
    expect(
      sourceValueAt(before, ["layers"]),
    ).toBe(sourceValueAt(after, ["layers"]));
    expect(
      sourceValueAt(before, ["tilesets"]),
    ).toBe(sourceValueAt(after, ["tilesets"]));
    expect(
      sourceValueAt(before, ["vendorRootExtension"]),
    ).toBe(
      sourceValueAt(after, ["vendorRootExtension"]),
    );
    expect(
      sourceValueAt(before, ["backgroundcolor"]),
    ).toBe(sourceValueAt(after, ["backgroundcolor"]));

    const saved = await readMap(harness.root);
    expect(saved).toMatchObject({
      renderorder: "right-up",
      backgroundcolor: "#112233",
      class: "InsertedMapClass",
    });
  });

  it("rejects a stale map revision without overwriting an external edit", async () => {
    const harness = await createHarness(roots);
    const edit = await plan(harness.service, [
      {
        type: "updateMap",
        patch: { className: "PlannedClass" },
      },
    ]);
    const external = baseMap();
    external.vendorExternalEdit = {
      preserved: true,
    };
    const mapPath = join(harness.root, MAP_PATH);
    await writeJson(mapPath, external);
    const externalBytes = await readFile(mapPath);

    await expect(
      harness.service.applyEdits(edit),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "REVISION_CONFLICT",
    });
    expect(await readFile(mapPath)).toEqual(externalBytes);
  });

  it("rejects tampered and stale-dependency plans without changing map bytes", async () => {
    const harness = await createHarness(roots);
    const edit = await plan(harness.service, [
      {
        type: "updateMap",
        patch: {
          renderOrder: "left-down",
          className: "PlannedMapClass",
        },
      },
    ]);
    const mapPath = join(harness.root, MAP_PATH);
    const before = await readFile(mapPath);
    const tampered = structuredClone(edit);
    const operation = tampered.operations[0];
    if (operation?.type !== "updateMap") {
      throw new Error("Expected an updateMap operation.");
    }
    operation.patch.className = "TamperedMapClass";

    await expect(
      harness.service.applyEdits(tampered),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "CHANGE_SET_TAMPERED",
    });
    expect(await readFile(mapPath)).toEqual(before);

    const tileset = baseTileset();
    tileset.vendorDependencyEdit = {
      changedAfterUpdateMapPreview: true,
    };
    await writeJson(
      join(harness.root, TILESET_PATH),
      tileset,
    );

    await expect(
      harness.service.applyEdits(edit),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DEPENDENCY_REVISION_CONFLICT",
    });
    expect(await readFile(mapPath)).toEqual(before);
  });

  it("survives a real Tiled 1.12 JSON export round-trip when the CLI is available", async () => {
    const harness = await createHarness(roots);
    const edit = await plan(harness.service, [
      {
        type: "updateMap",
        patch: {
          renderOrder: "left-up",
          backgroundColor: "#80abcdef",
          className: "RoundTripMap",
        },
      },
    ]);
    await harness.service.applyEdits(edit);

    const inputPath = join(harness.root, MAP_PATH);
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
          inputPath,
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
    expect(exported).toMatchObject({
      renderorder: "left-up",
      backgroundcolor: "#80abcdef",
      class: "RoundTripMap",
    });
  }, 40_000);
});

async function createHarness(
  roots: Set<string>,
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-update-map-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeJson(join(root, MAP_PATH), baseMap());
  await writeJson(
    join(root, TILESET_PATH),
    baseTileset(),
  );
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
  const store = new DocumentStore(resolver);
  return {
    root,
    service: new MapService(resolver, store),
  };
}

function baseMap(): JsonObject {
  return {
    backgroundcolor: "#112233",
    class: "ExistingMapClass",
    compressionlevel: -1,
    height: 1,
    infinite: false,
    layers: [
      {
        data: [1, 0],
        height: 1,
        id: TILE_LAYER_ID,
        name: "Ground",
        opacity: 1,
        type: "tilelayer",
        vendorLayerExtension: {
          preserve: ["tile-layer", 17],
        },
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
    tileheight: 16,
    tilewidth: 16,
    tiledversion: "1.12.2",
    type: "tileset",
    version: "1.10",
  };
}

async function plan(
  service: MapService,
  operations: readonly MapEditOperation[],
  suppliedSnapshot?: MapSnapshot,
): Promise<MapEditPlan> {
  const snapshot =
    suppliedSnapshot ?? (await mapSnapshot(service));
  return service.planEdits(
    MAP_PATH,
    snapshot.revision,
    snapshot.dependencies,
    operations,
  );
}

async function mapSnapshot(
  service: MapService,
): Promise<MapSnapshot> {
  const summary = await service.getSummary(MAP_PATH);
  const tileset = (
    summary.tilesets as Array<{ assetId: string }>
  )[0];
  if (tileset === undefined) {
    throw new Error(
      "Expected the updateMap fixture tileset.",
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

function tile(
  assetId: string,
  localId: number,
): TileRef {
  return {
    tileset: {
      kind: "external",
      assetId,
    },
    localId,
  };
}

function requireLayer(
  map: JsonObject,
  layerId: number,
): JsonObject {
  const layers = map.layers as JsonObject[];
  const layer = layers.find(
    (candidate) => candidate.id === layerId,
  );
  if (layer === undefined) {
    throw new Error(`Missing fixture layer ${layerId}.`);
  }
  return layer;
}

async function readMap(
  root: string,
): Promise<JsonObject> {
  return JSON.parse(
    (
      await readFile(join(root, MAP_PATH), "utf8")
    ).replace(/^\uFEFF/u, ""),
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
    (value as { code?: unknown }).code === code
  );
}
