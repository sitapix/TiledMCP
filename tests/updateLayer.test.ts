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

import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import type {
  LayerBlendMode,
  MapEditOperation,
  MapEditPlan,
  TileRef,
  UpdateLayerOperation,
} from "../src/maps/types.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
const TILE_LAYER_ID = 1;
const OBJECT_LAYER_ID = 2;
const IMAGE_LAYER_ID = 3;
const GROUP_LAYER_ID = 4;
const OBJECT_ID = 1;

const BLEND_MODES = [
  "normal",
  "add",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
] as const satisfies readonly LayerBlendMode[];

type TestEditOperation = MapEditOperation;

interface Harness {
  root: string;
  service: MapService;
}

interface MapSnapshot {
  revision: string;
  dependencies: Record<string, string>;
  tilesetAssetId: string;
}

describe("updateLayer", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("maps every common field across all four supported layer types", async () => {
    const harness = await createHarness(roots);
    const operations: UpdateLayerOperation[] = [
      {
        type: "updateLayer",
        layerId: TILE_LAYER_ID,
        patch: {
          name: "Renamed Ground",
          className: "TerrainLayer",
          visible: false,
          opacity: 0.25,
        },
      },
      {
        type: "updateLayer",
        layerId: OBJECT_LAYER_ID,
        patch: {
          offsetX: 10.5,
          offsetY: -2.25,
          parallaxX: 0,
          parallaxY: -1.5,
        },
      },
      {
        type: "updateLayer",
        layerId: IMAGE_LAYER_ID,
        patch: {
          tintColor: "#80AABBCC",
          locked: true,
          blendMode: "multiply",
        },
      },
      {
        type: "updateLayer",
        layerId: GROUP_LAYER_ID,
        patch: {
          name: "Gameplay Group",
          className: "LayerFolder",
          offsetX: -12.5,
          tintColor: "#112233",
        },
      },
    ];

    const edit = await plan(harness.service, operations);

    expect(edit.operations).toEqual(operations);
    expect(edit.summary).toMatchObject({
      operationCount: 4,
      cellWrites: 0,
      affectedLayerIds: [
        TILE_LAYER_ID,
        OBJECT_LAYER_ID,
        IMAGE_LAYER_ID,
        GROUP_LAYER_ID,
      ],
      updatedLayerIds: [
        TILE_LAYER_ID,
        OBJECT_LAYER_ID,
        IMAGE_LAYER_ID,
        GROUP_LAYER_ID,
      ],
      layerUpdates: [
        {
          operationIndex: 0,
          layerId: TILE_LAYER_ID,
          layerType: "tilelayer",
          requestedFields: [
            "name",
            "className",
            "visible",
            "opacity",
          ],
          changedFields: [
            "name",
            "className",
            "visible",
            "opacity",
          ],
          wouldChange: true,
          affectsDescendants: false,
        },
        {
          operationIndex: 1,
          layerId: OBJECT_LAYER_ID,
          layerType: "objectgroup",
          requestedFields: [
            "offsetX",
            "offsetY",
            "parallaxX",
            "parallaxY",
          ],
          changedFields: [
            "offsetX",
            "offsetY",
            "parallaxX",
            "parallaxY",
          ],
          wouldChange: true,
          affectsDescendants: false,
        },
        {
          operationIndex: 2,
          layerId: IMAGE_LAYER_ID,
          layerType: "imagelayer",
          requestedFields: [
            "tintColor",
            "locked",
            "blendMode",
          ],
          changedFields: [
            "tintColor",
            "locked",
            "blendMode",
          ],
          wouldChange: true,
          affectsDescendants: false,
        },
        {
          operationIndex: 3,
          layerId: GROUP_LAYER_ID,
          layerType: "group",
          requestedFields: [
            "name",
            "className",
            "offsetX",
            "tintColor",
          ],
          changedFields: [
            "name",
            "className",
            "offsetX",
            "tintColor",
          ],
          wouldChange: true,
          affectsDescendants: true,
        },
      ],
    });

    const result = await harness.service.applyEdits(edit);
    const saved = await readMap(harness.root);
    const layers = saved.layers as JsonObject[];

    expect(result).toMatchObject({
      path: MAP_PATH,
      changed: true,
      changeSetId: edit.id,
    });
    expect(layers[0]).toMatchObject({
      id: TILE_LAYER_ID,
      name: "Renamed Ground",
      class: "TerrainLayer",
      visible: false,
      opacity: 0.25,
    });
    expect(layers[0]).not.toHaveProperty("className");
    expect(layers[1]).toMatchObject({
      id: OBJECT_LAYER_ID,
      offsetx: 10.5,
      offsety: -2.25,
      parallaxx: 0,
      parallaxy: -1.5,
    });
    expect(layers[2]).toMatchObject({
      id: IMAGE_LAYER_ID,
      tintcolor: "#80AABBCC",
      locked: true,
      mode: "multiply",
    });
    expect(layers[3]).toMatchObject({
      id: GROUP_LAYER_ID,
      name: "Gameplay Group",
      class: "LayerFolder",
      offsetx: -12.5,
      tintcolor: "#112233",
    });
    expect(saved.vendorRootExtension).toEqual({
      preserve: ["root", 23],
    });
    expect(layers[0]?.vendorLayerExtension).toEqual({
      preserve: ["tile-layer", 17],
    });
  });

  it("marks descendant impact only for changed Group rendering fields", async () => {
    const harness = await createHarness(roots);
    const edit = await plan(harness.service, [
      {
        type: "updateLayer",
        layerId: GROUP_LAYER_ID,
        patch: { name: "Renamed Group" },
      },
      {
        type: "updateLayer",
        layerId: GROUP_LAYER_ID,
        patch: { name: "Renamed Group" },
      },
      {
        type: "updateLayer",
        layerId: GROUP_LAYER_ID,
        patch: { locked: true },
      },
      {
        type: "updateLayer",
        layerId: GROUP_LAYER_ID,
        patch: { visible: false },
      },
    ]);

    expect(edit.summary.layerUpdates).toMatchObject([
      {
        changedFields: ["name"],
        wouldChange: true,
        affectsDescendants: false,
      },
      {
        changedFields: [],
        wouldChange: false,
        affectsDescendants: false,
      },
      {
        changedFields: ["locked"],
        wouldChange: true,
        affectsDescendants: false,
      },
      {
        changedFields: ["visible"],
        wouldChange: true,
        affectsDescendants: true,
      },
    ]);
  });

  it("reports sequential updates while preserving a net no-op document", async () => {
    const harness = await createHarness(roots);
    const mapPath = join(harness.root, MAP_PATH);
    const before = await readFile(mapPath);
    const edit = await plan(harness.service, [
      {
        type: "updateLayer",
        layerId: GROUP_LAYER_ID,
        patch: { name: "Temporary Group Name" },
      },
      {
        type: "updateLayer",
        layerId: GROUP_LAYER_ID,
        patch: { name: "Gameplay" },
      },
    ]);

    expect(edit.summary).toMatchObject({
      affectedLayerIds: [GROUP_LAYER_ID],
      updatedLayerIds: [GROUP_LAYER_ID],
      layerUpdates: [
        { changedFields: ["name"], wouldChange: true },
        { changedFields: ["name"], wouldChange: true },
      ],
    });
    const result = await harness.service.applyEdits(edit);
    expect(result.changed).toBe(false);
    expect(await readFile(mapPath)).toEqual(before);
  });

  it("distinguishes exact JSON no-ops from inserting defaults and deleting tint", async () => {
    const harness = await createHarness(roots);
    const operations: UpdateLayerOperation[] = [
      {
        type: "updateLayer",
        layerId: TILE_LAYER_ID,
        patch: {
          name: "Ground",
          visible: true,
          opacity: 1,
        },
      },
      {
        type: "updateLayer",
        layerId: OBJECT_LAYER_ID,
        patch: { locked: false },
      },
      {
        type: "updateLayer",
        layerId: IMAGE_LAYER_ID,
        patch: { tintColor: null },
      },
      {
        type: "updateLayer",
        layerId: TILE_LAYER_ID,
        patch: { tintColor: null },
      },
    ];
    const edit = await plan(harness.service, operations);

    expect(edit.summary).toMatchObject({
      affectedLayerIds: [
        TILE_LAYER_ID,
        OBJECT_LAYER_ID,
      ],
      updatedLayerIds: [
        TILE_LAYER_ID,
        OBJECT_LAYER_ID,
      ],
      layerUpdates: [
        {
          operationIndex: 0,
          layerId: TILE_LAYER_ID,
          requestedFields: ["name", "visible", "opacity"],
          changedFields: [],
        },
        {
          operationIndex: 1,
          layerId: OBJECT_LAYER_ID,
          requestedFields: ["locked"],
          changedFields: ["locked"],
        },
        {
          operationIndex: 2,
          layerId: IMAGE_LAYER_ID,
          requestedFields: ["tintColor"],
          changedFields: [],
        },
        {
          operationIndex: 3,
          layerId: TILE_LAYER_ID,
          requestedFields: ["tintColor"],
          changedFields: ["tintColor"],
        },
      ],
    });

    await harness.service.applyEdits(edit);
    const layers = (await readMap(harness.root))
      .layers as JsonObject[];
    expect(layers[1]).toHaveProperty("locked", false);
    expect(layers[2]).not.toHaveProperty("tintcolor");
    expect(layers[0]).not.toHaveProperty("tintcolor");

    const beforeNoOp = await readFile(
      join(harness.root, MAP_PATH),
    );
    const allNoOp = await plan(harness.service, [
      {
        type: "updateLayer",
        layerId: OBJECT_LAYER_ID,
        patch: { locked: false },
      },
      {
        type: "updateLayer",
        layerId: IMAGE_LAYER_ID,
        patch: { tintColor: null },
      },
    ]);
    expect(allNoOp.summary).toMatchObject({
      affectedLayerIds: [],
      updatedLayerIds: [],
      layerUpdates: [
        { changedFields: [] },
        { changedFields: [] },
      ],
    });

    const noOpResult =
      await harness.service.applyEdits(allNoOp);
    expect(noOpResult.changed).toBe(false);
    expect(
      await readFile(join(harness.root, MAP_PATH)),
    ).toEqual(beforeNoOp);
  });

  it("accepts boundary values and all official blend modes", async () => {
    const harness = await createHarness(roots);
    const longName = "N".repeat(1_024);
    const longClass = "C".repeat(1_024);
    const operations: UpdateLayerOperation[] = [
      {
        type: "updateLayer",
        layerId: TILE_LAYER_ID,
        patch: {
          name: longName,
          className: longClass,
          opacity: 0,
          offsetX: -1_000_000_000,
          offsetY: 1_000_000_000,
          parallaxX: -1_000_000_000,
          parallaxY: 1_000_000_000,
          tintColor: "#aabbcc",
        },
      },
      {
        type: "updateLayer",
        layerId: IMAGE_LAYER_ID,
        patch: {
          opacity: 1,
          tintColor: "#80aabbcc",
        },
      },
      ...BLEND_MODES.map(
        (blendMode): UpdateLayerOperation => ({
          type: "updateLayer",
          layerId: GROUP_LAYER_ID,
          patch: { blendMode },
        }),
      ),
    ];

    const edit = await plan(harness.service, operations);
    expect(edit.summary.operationCount).toBe(
      operations.length,
    );
    expect(
      (
        edit.summary as MapEditPlan["summary"] & {
          layerUpdates: Array<{
            requestedFields: string[];
          }>;
        }
      ).layerUpdates.slice(-BLEND_MODES.length),
    ).toEqual(
      BLEND_MODES.map(() =>
        expect.objectContaining({
          requestedFields: ["blendMode"],
        }),
      ),
    );

    await harness.service.applyEdits(edit);
    const layers = (await readMap(harness.root))
      .layers as JsonObject[];
    expect(layers[0]).toMatchObject({
      name: longName,
      class: longClass,
      opacity: 0,
      offsetx: -1_000_000_000,
      offsety: 1_000_000_000,
      parallaxx: -1_000_000_000,
      parallaxy: 1_000_000_000,
      tintcolor: "#aabbcc",
    });
    expect(layers[2]).toMatchObject({
      opacity: 1,
      tintcolor: "#80aabbcc",
    });
    expect(layers[3]).toHaveProperty("mode", "exclusion");
  });

  it.each([
    ["an empty patch", {}],
    ["an unknown patch field", { vendorField: true }],
    ["an overlong name", { name: "x".repeat(1_025) }],
    [
      "an overlong class",
      { className: "x".repeat(1_025) },
    ],
    ["a negative opacity", { opacity: -0.001 }],
    ["an opacity above one", { opacity: 1.001 }],
    ["a non-finite opacity", { opacity: Number.NaN }],
    ["a non-finite offset", { offsetX: Number.POSITIVE_INFINITY }],
    [
      "an offset outside the numeric bound",
      { offsetY: -1_000_000_001 },
    ],
    [
      "parallax outside the numeric bound",
      { parallaxX: 1_000_000_001 },
    ],
    ["a short tint", { tintColor: "#abc" }],
    ["a malformed ARGB tint", { tintColor: "#1234567" }],
    ["an unsupported blend mode", { blendMode: "source-over" }],
    ["a non-string class", { className: null }],
  ])("rejects %s", async (_label, invalidPatch) => {
    const harness = await createHarness(roots);
    const operation = {
      type: "updateLayer",
      layerId: TILE_LAYER_ID,
      patch: invalidPatch,
    } as unknown as UpdateLayerOperation;

    await expect(
      plan(harness.service, [operation]),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
    });
  });

  it("rejects a missing layer without falling back to its name", async () => {
    const harness = await createHarness(roots);

    await expect(
      plan(harness.service, [
        {
          type: "updateLayer",
          layerId: 999,
          patch: { name: "Ground" },
        },
      ]),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_NOT_FOUND",
      details: {
        path: MAP_PATH,
        layerId: 999,
      },
    });
  });

  it("preserves BOM, CRLF, adjacent lexemes, and unrelated source while replacing, inserting, and deleting members", async () => {
    const harness = await createHarness(roots);
    const map = baseMap();
    const tileLayer = requireLayer(map, TILE_LAYER_ID);
    delete tileLayer.class;
    delete tileLayer.locked;
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
          '"offsetx": 3,',
          '"offsetx": 3.00e+0,',
        )
        .replace(/\n/gu, "\r\n")}\r\n`;
    const absoluteMapPath = join(harness.root, MAP_PATH);
    await writeFile(
      absoluteMapPath,
      unusualSource,
      "utf8",
    );
    const before = await readFile(absoluteMapPath, "utf8");
    const edit = await plan(harness.service, [
      {
        type: "updateLayer",
        layerId: TILE_LAYER_ID,
        patch: {
          name: "Source-preserving Ground",
          className: "InsertedClass",
          tintColor: null,
          locked: true,
        },
      },
    ]);

    await harness.service.applyEdits(edit);
    const after = await readFile(absoluteMapPath, "utf8");

    expect(after.startsWith("\uFEFF")).toBe(true);
    expect(after).toContain(
      '"compressionlevel": -1.000e+0',
    );
    expect(after).toContain('"opacity": 1.000e+0');
    expect(after).toContain('"offsetx": 3.00e+0');
    expect(after).toContain(
      '\r\n\t\t\t"class": "InsertedClass"',
    );
    expect(after.replace(/\r\n/gu, "")).not.toContain("\n");
    expect(
      sourceValueAt(before, [
        "layers",
        0,
        "data",
      ]),
    ).toBe(
      sourceValueAt(after, [
        "layers",
        0,
        "data",
      ]),
    );
    expect(
      sourceValueAt(before, [
        "layers",
        0,
        "vendorLayerExtension",
      ]),
    ).toBe(
      sourceValueAt(after, [
        "layers",
        0,
        "vendorLayerExtension",
      ]),
    );
    expect(sourceValueAt(before, ["layers", 1])).toBe(
      sourceValueAt(after, ["layers", 1]),
    );
    expect(
      sourceValueAt(before, ["vendorRootExtension"]),
    ).toBe(
      sourceValueAt(after, ["vendorRootExtension"]),
    );

    const saved = await readMap(harness.root);
    const savedTileLayer = requireLayer(
      saved,
      TILE_LAYER_ID,
    );
    expect(savedTileLayer).toMatchObject({
      name: "Source-preserving Ground",
      class: "InsertedClass",
      locked: true,
    });
    expect(savedTileLayer).not.toHaveProperty("tintcolor");
  });

  it("coexists with tile-data and object edits, while locked remains advisory", async () => {
    const harness = await createHarness(roots);
    const snapshot = await mapSnapshot(harness.service);
    const operations: TestEditOperation[] = [
      {
        type: "updateLayer",
        layerId: TILE_LAYER_ID,
        patch: { locked: true },
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
      {
        type: "updateLayer",
        layerId: OBJECT_LAYER_ID,
        patch: { locked: true },
      },
      {
        type: "updateObject",
        objectId: OBJECT_ID,
        patch: {
          x: 42,
          name: "Moved while layer is locked",
        },
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
      affectedLayerIds: [
        TILE_LAYER_ID,
        OBJECT_LAYER_ID,
      ],
      affectedTileLayerIds: [TILE_LAYER_ID],
      affectedObjectLayerIds: [OBJECT_LAYER_ID],
      updatedLayerIds: [
        TILE_LAYER_ID,
        OBJECT_LAYER_ID,
      ],
      updatedObjectIds: [OBJECT_ID],
    });

    await harness.service.applyEdits(edit);
    const saved = await readMap(harness.root);
    const tileLayer = requireLayer(
      saved,
      TILE_LAYER_ID,
    );
    const objectLayer = requireLayer(
      saved,
      OBJECT_LAYER_ID,
    );
    const objects = objectLayer.objects as JsonObject[];

    expect(tileLayer.locked).toBe(true);
    expect(tileLayer.data).toEqual([1, 2]);
    expect(objectLayer.locked).toBe(true);
    expect(objects[0]).toMatchObject({
      id: OBJECT_ID,
      x: 42,
      name: "Moved while layer is locked",
    });
  });

  it("rejects tampered and stale plans without overwriting external bytes", async () => {
    const tamperHarness = await createHarness(roots);
    const tamperPlan = await plan(
      tamperHarness.service,
      [
        {
          type: "updateLayer",
          layerId: GROUP_LAYER_ID,
          patch: { name: "Planned Group" },
        },
      ],
    );
    const tampered = structuredClone(tamperPlan);
    const tamperedOperation =
      tampered.operations[0] as unknown as
        | UpdateLayerOperation
        | undefined;
    if (tamperedOperation?.type !== "updateLayer") {
      throw new Error(
        "Expected an updateLayer operation fixture.",
      );
    }
    tamperedOperation.patch.name = "Tampered Group";
    const tamperMapPath = join(
      tamperHarness.root,
      MAP_PATH,
    );
    const beforeTamper = await readFile(tamperMapPath);

    await expect(
      tamperHarness.service.applyEdits(tampered),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "CHANGE_SET_TAMPERED",
    });
    expect(await readFile(tamperMapPath)).toEqual(
      beforeTamper,
    );

    const staleHarness = await createHarness(roots);
    const stalePlan = await plan(staleHarness.service, [
      {
        type: "updateLayer",
        layerId: IMAGE_LAYER_ID,
        patch: { blendMode: "screen" },
      },
    ]);
    const externallyEdited = baseMap();
    externallyEdited.externalOwnerField =
      "changed after updateLayer preview";
    const staleMapPath = join(
      staleHarness.root,
      MAP_PATH,
    );
    await writeJson(staleMapPath, externallyEdited);
    const externalBytes = await readFile(staleMapPath);

    await expect(
      staleHarness.service.applyEdits(stalePlan),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "REVISION_CONFLICT",
      details: {
        path: MAP_PATH,
        expectedRevision: stalePlan.baseRevision,
        actualRevision: expect.stringMatching(
          /^sha256:[0-9a-f]{64}$/u,
        ),
      },
    });
    expect(await readFile(staleMapPath)).toEqual(
      externalBytes,
    );
  });

  it("survives a real Tiled 1.12 JSON export round-trip when the CLI is available", async () => {
    const harness = await createHarness(roots);
    const edit = await plan(harness.service, [
      {
        type: "updateLayer",
        layerId: TILE_LAYER_ID,
        patch: {
          className: "RoundTripLayer",
          offsetX: 2.5,
          parallaxY: 0.75,
          tintColor: "#80abcdef",
          locked: true,
          blendMode: "soft-light",
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
    expect(
      requireLayer(exported, TILE_LAYER_ID),
    ).toMatchObject({
      class: "RoundTripLayer",
      offsetx: 2.5,
      parallaxy: 0.75,
      tintcolor: "#80abcdef",
      locked: true,
      mode: "soft-light",
    });
  }, 40_000);
});

async function createHarness(
  roots: Set<string>,
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-update-layer-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await mkdir(join(root, "images"));
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
  await writeFile(
    join(root, "images", "backdrop.svg"),
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16">',
      '<rect width="32" height="16" fill="#112233"/>',
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
    compressionlevel: -1,
    height: 1,
    infinite: false,
    layers: [
      {
        class: "ExistingTerrain",
        data: [1, 0],
        height: 1,
        id: TILE_LAYER_ID,
        locked: false,
        mode: "normal",
        name: "Ground",
        offsetx: 3,
        offsety: -4,
        opacity: 1,
        parallaxx: 1,
        parallaxy: 1,
        tintcolor: "#ffffffff",
        type: "tilelayer",
        vendorLayerExtension: {
          preserve: ["tile-layer", 17],
        },
        visible: true,
        width: 2,
        x: 0,
        y: 0,
      },
      {
        id: OBJECT_LAYER_ID,
        name: "Objects",
        objects: [
          {
            height: 8,
            id: OBJECT_ID,
            name: "Crate",
            rotation: 0,
            type: "Collision",
            visible: true,
            width: 8,
            x: 4,
            y: 5,
          },
        ],
        opacity: 1,
        type: "objectgroup",
        vendorObjectLayerExtension: {
          preserve: "object-layer",
        },
        visible: true,
      },
      {
        id: IMAGE_LAYER_ID,
        image: "../images/backdrop.svg",
        name: "Backdrop",
        opacity: 0.5,
        type: "imagelayer",
        visible: true,
        x: 0,
        y: 0,
      },
      {
        id: GROUP_LAYER_ID,
        layers: [],
        name: "Gameplay",
        opacity: 1,
        type: "group",
        visible: true,
      },
    ],
    nextlayerid: 5,
    nextobjectid: 2,
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
  operations: readonly TestEditOperation[],
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
      "Expected the updateLayer fixture tileset.",
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
  const pending = [
    ...(map.layers as JsonObject[]),
  ];
  while (pending.length > 0) {
    const layer = pending.shift();
    if (layer === undefined) {
      continue;
    }
    if (layer.id === layerId) {
      return layer;
    }
    if (Array.isArray(layer.layers)) {
      pending.push(
        ...(layer.layers as JsonObject[]),
      );
    }
  }
  throw new Error(`Missing fixture layer ${layerId}.`);
}

async function readMap(root: string): Promise<JsonObject> {
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
