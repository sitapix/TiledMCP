import { execFile } from "node:child_process";
import { makeStore } from "./support/project.js";
import {
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
import { MapService } from "../src/maps/mapService.js";
import type {
  MapEditOperation,
  MapEditPlan,
  MoveLayerOperation,
} from "../src/maps/types.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/level.tmj";
const TILE_LAYER_ID = 1;
const OBJECT_LAYER_ID = 2;
const LOCKED_GROUP_ID = 3;
const NESTED_TILE_LAYER_ID = 4;
const NESTED_GROUP_ID = 5;
const DEEP_OBJECT_LAYER_ID = 6;
const TARGET_GROUP_ID = 7;
const IMAGE_LAYER_ID = 8;

interface Harness {
  root: string;
  service: MapService;
}

interface MapSnapshot {
  revision: string;
  dependencies: Record<string, string>;
}

describe("moveLayer", () => {
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
      label: "forward to the final root index",
      layerId: OBJECT_LAYER_ID,
      index: 4,
      expected: [
        TILE_LAYER_ID,
        LOCKED_GROUP_ID,
        TARGET_GROUP_ID,
        IMAGE_LAYER_ID,
        OBJECT_LAYER_ID,
      ],
      sourceIndex: 1,
    },
    {
      label: "backward to an earlier final root index",
      layerId: IMAGE_LAYER_ID,
      index: 1,
      expected: [
        TILE_LAYER_ID,
        IMAGE_LAYER_ID,
        OBJECT_LAYER_ID,
        LOCKED_GROUP_ID,
        TARGET_GROUP_ID,
      ],
      sourceIndex: 4,
    },
  ])(
    "moves a sibling $label",
    async ({
      layerId,
      index,
      expected,
      sourceIndex,
    }) => {
      const harness = await createHarness(roots);
      const movePlan = await plan(harness.service, {
        type: "moveLayer",
        layerId,
        index,
      });

      expect(movePlan.summary).toMatchObject({
        affectedLayerIds: [layerId],
        movedLayers: [
          {
            operationIndex: 0,
            layerId,
            sourceParentGroupId: null,
            sourceIndex,
            targetParentGroupId: null,
            targetIndex: index,
            wouldChange: true,
            renderOrderMayChange: true,
            renderContextMayChange: false,
          },
        ],
      });
      await harness.service.applyEdits(movePlan);

      expect(rootLayerIds(await readMap(harness.root))).toEqual(
        expected,
      );
    },
  );

  it("moves a root layer into a Group whose source path shifts after removal", async () => {
    const harness = await createHarness(roots);
    const movePlan = await plan(harness.service, {
      type: "moveLayer",
      layerId: TILE_LAYER_ID,
      parentGroupId: TARGET_GROUP_ID,
      index: 0,
    });

    expect(movePlan.summary.movedLayers).toEqual([
      expect.objectContaining({
        layerId: TILE_LAYER_ID,
        sourceParentGroupId: null,
        sourceIndex: 0,
        targetParentGroupId: TARGET_GROUP_ID,
        targetIndex: 0,
        renderContextMayChange: true,
      }),
    ]);
    await harness.service.applyEdits(movePlan);

    const map = await readMap(harness.root);
    expect(rootLayerIds(map)).toEqual([
      OBJECT_LAYER_ID,
      LOCKED_GROUP_ID,
      TARGET_GROUP_ID,
      IMAGE_LAYER_ID,
    ]);
    expect(layerChildIds(map, TARGET_GROUP_ID)).toEqual([
      TILE_LAYER_ID,
    ]);
    expect(map.nextlayerid).toBe(9);
    expect(map.nextobjectid).toBe(11);
  });

  it("moves a child out to root while its source Group shifts after insertion", async () => {
    const harness = await createHarness(roots);
    const movePlan = await plan(harness.service, {
      type: "moveLayer",
      layerId: NESTED_TILE_LAYER_ID,
      index: 1,
    });
    await harness.service.applyEdits(movePlan);

    const map = await readMap(harness.root);
    expect(rootLayerIds(map)).toEqual([
      TILE_LAYER_ID,
      NESTED_TILE_LAYER_ID,
      OBJECT_LAYER_ID,
      LOCKED_GROUP_ID,
      TARGET_GROUP_ID,
      IMAGE_LAYER_ID,
    ]);
    expect(layerChildIds(map, LOCKED_GROUP_ID)).toEqual([
      NESTED_GROUP_ID,
    ]);
  });

  it("moves a nested layer into an empty sibling Group", async () => {
    const harness = await createHarness(roots);
    const movePlan = await plan(harness.service, {
      type: "moveLayer",
      layerId: NESTED_TILE_LAYER_ID,
      parentGroupId: TARGET_GROUP_ID,
      index: 0,
    });
    await harness.service.applyEdits(movePlan);

    const map = await readMap(harness.root);
    expect(layerChildIds(map, LOCKED_GROUP_ID)).toEqual([
      NESTED_GROUP_ID,
    ]);
    expect(layerChildIds(map, TARGET_GROUP_ID)).toEqual([
      NESTED_TILE_LAYER_ID,
    ]);
  });

  it("reports subtree and effective-lock changes when moving a Group out of a locked parent", async () => {
    const harness = await createHarness(roots);
    const movePlan = await plan(harness.service, {
      type: "moveLayer",
      layerId: NESTED_GROUP_ID,
      index: 0,
    });

    expect(movePlan.summary.movedLayers).toEqual([
      expect.objectContaining({
        layerId: NESTED_GROUP_ID,
        layerType: "group",
        sourceParentGroupId: LOCKED_GROUP_ID,
        sourceIndex: 1,
        targetParentGroupId: null,
        targetIndex: 0,
        subtreeLayerCount: 2,
        descendantLayerCount: 1,
        layerIdSample: [
          NESTED_GROUP_ID,
          DEEP_OBJECT_LAYER_ID,
        ],
        omittedLayerCount: 0,
        objectCount: 1,
        lockedLayerCount: 0,
        sourceParentLocked: true,
        targetParentLocked: false,
        effectivelyLockedLayerCountBefore: 2,
        effectivelyLockedLayerCountAfter: 0,
        wouldChange: true,
        renderOrderMayChange: true,
        renderContextMayChange: true,
        affectsDescendants: true,
      }),
    ]);
    const preview = new ChangeSetRegistry().put(movePlan);
    expect(preview.operations[0]).toMatchObject({
      type: "moveLayer",
      destructive: false,
      wouldChange: true,
      effectivelyLockedLayerCountBefore: 2,
      effectivelyLockedLayerCountAfter: 0,
      warning: expect.stringContaining(
        "effectively locked",
      ),
    });

    await harness.service.applyEdits(movePlan);
    const map = await readMap(harness.root);
    expect(rootLayerIds(map)[0]).toBe(NESTED_GROUP_ID);
    expect(layerChildIds(map, LOCKED_GROUP_ID)).toEqual([
      NESTED_TILE_LAYER_ID,
    ]);
    expect(
      (requireLayer(
        map,
        DEEP_OBJECT_LAYER_ID,
      ).objects as JsonObject[])[0]?.id,
    ).toBe(10);
    expect(map.nextlayerid).toBe(9);
    expect(map.nextobjectid).toBe(11);
  });

  it("detects effective locking inherited through a target ancestor", async () => {
    const harness = await createHarness(roots);
    const movePlan = await plan(harness.service, {
      type: "moveLayer",
      layerId: TILE_LAYER_ID,
      parentGroupId: NESTED_GROUP_ID,
      index: 1,
    });
    expect(movePlan.summary.movedLayers).toEqual([
      expect.objectContaining({
        layerId: TILE_LAYER_ID,
        sourceParentLocked: false,
        targetParentLocked: false,
        effectivelyLockedLayerCountBefore: 0,
        effectivelyLockedLayerCountAfter: 1,
      }),
    ]);
    expect(
      new ChangeSetRegistry().put(movePlan).operations[0],
    ).toMatchObject({
      warning: expect.stringContaining(
        "effectively locked",
      ),
    });

    await harness.service.applyEdits(movePlan);
    expect(
      layerChildIds(
        await readMap(harness.root),
        NESTED_GROUP_ID,
      ),
    ).toEqual([DEEP_OBJECT_LAYER_ID, TILE_LAYER_ID]);
  });

  it("treats the same final parent/index as an exact-byte no-op", async () => {
    const harness = await createHarness(roots);
    const absolutePath = join(harness.root, MAP_PATH);
    const before = await readFile(absolutePath);
    const snapshot = await mapSnapshot(harness.service);
    const movePlan = await plan(
      harness.service,
      {
        type: "moveLayer",
        layerId: TILE_LAYER_ID,
        index: 0,
      },
      snapshot,
    );

    expect(movePlan.summary).toMatchObject({
      affectedLayerIds: [],
      movedLayers: [
        {
          layerId: TILE_LAYER_ID,
          sourceParentGroupId: null,
          sourceIndex: 0,
          targetParentGroupId: null,
          targetIndex: 0,
          wouldChange: false,
          renderOrderMayChange: false,
          renderContextMayChange: false,
          affectsDescendants: false,
        },
      ],
    });
    const result = await harness.service.applyEdits(movePlan);
    expect(result).toMatchObject({
      changed: false,
      revision: snapshot.revision,
    });
    expect(await readFile(absolutePath)).toEqual(before);
  });

  it.each([
    {
      label: "itself",
      parentGroupId: LOCKED_GROUP_ID,
    },
    {
      label: "a descendant",
      parentGroupId: NESTED_GROUP_ID,
    },
  ])(
    "rejects moving a Group into $label",
    async ({ parentGroupId }) => {
      const harness = await createHarness(roots);
      await expect(
        plan(harness.service, {
          type: "moveLayer",
          layerId: LOCKED_GROUP_ID,
          parentGroupId,
          index: 0,
        }),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "LAYER_MOVE_CYCLE",
        details: {
          layerId: LOCKED_GROUP_ID,
          parentGroupId,
        },
      });
    },
  );

  it("rejects invalid parent, index, extra fields and mixed batches before mutation", async () => {
    const harness = await createHarness(roots);
    await expect(
      plan(harness.service, {
        type: "moveLayer",
        layerId: 999,
        index: 0,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_NOT_FOUND",
      details: { layerId: 999 },
    });
    await expect(
      plan(harness.service, {
        type: "moveLayer",
        layerId: TILE_LAYER_ID,
        parentGroupId: 999,
        index: 0,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_NOT_FOUND",
      details: { layerId: 999, role: "parent" },
    });
    await expect(
      plan(harness.service, {
        type: "moveLayer",
        layerId: TILE_LAYER_ID,
        parentGroupId: OBJECT_LAYER_ID,
        index: 0,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_TYPE_MISMATCH",
      details: { layerId: OBJECT_LAYER_ID, role: "parent" },
    });
    await expect(
      plan(harness.service, {
        type: "moveLayer",
        layerId: TILE_LAYER_ID,
        index: 5,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_INDEX_OUT_OF_RANGE",
      details: {
        index: 5,
        maximumIndex: 4,
        indexSemantics: "final-index-after-move",
      },
    });
    await expect(
      plan(harness.service, {
        type: "moveLayer",
        layerId: TILE_LAYER_ID,
        parentGroupId: TARGET_GROUP_ID,
        index: 1,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_INDEX_OUT_OF_RANGE",
      details: { index: 1, maximumIndex: 0 },
    });
    await expect(
      plan(harness.service, [
        {
          type: "moveLayer",
          layerId: TILE_LAYER_ID,
          index: 1,
        },
        {
          type: "updateLayer",
          layerId: OBJECT_LAYER_ID,
          patch: { visible: false },
        },
      ]),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
    });
    await expect(
      plan(
        harness.service,
        {
          type: "moveLayer",
          layerId: TILE_LAYER_ID,
          index: 1,
          unexpected: true,
        } as unknown as MoveLayerOperation,
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
    });
  });

  it("rejects a move whose resulting subtree depth would exceed 64", async () => {
    const map = depthBoundaryMap();
    const harness = await createHarness(roots, map);
    await expect(
      plan(harness.service, {
        type: "moveLayer",
        layerId: 1,
        parentGroupId: 163,
        index: 0,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_DEPTH_EXCEEDED",
      details: {
        layerId: 1,
        parentGroupId: 163,
        resultingDepth: 65,
        maxDepth: 64,
      },
    });
  });

  it("bounds the moved subtree id sample and display name", async () => {
    const map = baseMap();
    const group = requireLayer(map, LOCKED_GROUP_ID);
    group.name = `${"🧩".repeat(128)}extra`;
    group.layers = Array.from(
      { length: 40 },
      (_, index): JsonObject => ({
        id: 100 + index,
        layers: [],
        name: `Group ${index}`,
        opacity: 1,
        type: "group",
        visible: true,
        x: 0,
        y: 0,
      }),
    );
    map.nextlayerid = 140;
    const harness = await createHarness(roots, map);
    const movePlan = await plan(harness.service, {
      type: "moveLayer",
      layerId: LOCKED_GROUP_ID,
      index: 4,
    });
    const move = movePlan.summary.movedLayers?.[0];

    expect(move).toMatchObject({
      name: "🧩".repeat(128),
      nameTruncated: true,
      subtreeLayerCount: 41,
      descendantLayerCount: 40,
      omittedLayerCount: 9,
      effectivelyLockedLayerCountBefore: 41,
      effectivelyLockedLayerCountAfter: 41,
    });
    expect(move?.layerIdSample).toHaveLength(32);
    expect(move?.layerIdSample[0]).toBe(LOCKED_GROUP_ID);
  });

  it("moves the exact subtree bytes across depths while preserving BOM, CRLF and untouched lexemes", async () => {
    const harness = await createHarness(roots);
    const absolutePath = join(harness.root, MAP_PATH);
    const lexicalMap = baseMap();
    (
      requireLayer(
        lexicalMap,
        TILE_LAYER_ID,
      ).vendorTileExtension as JsonObject
    ).futureNumber = 100;
    const source =
      `\uFEFF${serializeJsonDocument(lexicalMap)
        .toString("utf8")
        .replace(
          '"futureNumber": 100',
          '"futureNumber": 1e+2',
        )
        .replace(/\n/gu, "\r\n")}`;
    await writeFile(absolutePath, source, "utf8");
    const beforeMap = JSON.parse(
      source.replace(/^\uFEFF/u, ""),
    ) as JsonObject;
    const movedBefore = sourceValueAt(
      source,
      requireLayerPath(beforeMap, TILE_LAYER_ID),
    );
    const siblingBefore = sourceValueAt(
      source,
      requireLayerPath(beforeMap, OBJECT_LAYER_ID),
    );
    const rootExtensionBefore = sourceValueAt(source, [
      "vendorRootExtension",
    ]);

    const movePlan = await plan(harness.service, {
      type: "moveLayer",
      layerId: TILE_LAYER_ID,
      parentGroupId: TARGET_GROUP_ID,
      index: 0,
    });
    await harness.service.applyEdits(movePlan);

    const after = await readFile(absolutePath, "utf8");
    const afterMap = JSON.parse(
      after.replace(/^\uFEFF/u, ""),
    ) as JsonObject;
    expect(after.startsWith("\uFEFF")).toBe(true);
    expect(after).toContain("\r\n");
    expect(after).not.toMatch(/(?<!\r)\n/u);
    expect(
      sourceValueAt(
        after,
        requireLayerPath(afterMap, TILE_LAYER_ID),
      ),
    ).toBe(movedBefore);
    expect(
      sourceValueAt(
        after,
        requireLayerPath(afterMap, OBJECT_LAYER_ID),
      ),
    ).toBe(siblingBefore);
    expect(
      sourceValueAt(after, ["vendorRootExtension"]),
    ).toBe(rootExtensionBefore);
    expect(after).toContain('"futureNumber": 1e+2');
  });

  it("rejects tampered and stale plans without changing external bytes", async () => {
    const tamperHarness = await createHarness(roots);
    const tampered = structuredClone(
      await plan(tamperHarness.service, {
        type: "moveLayer",
        layerId: TILE_LAYER_ID,
        index: 1,
      }),
    );
    (
      tampered.operations[0] as MoveLayerOperation
    ).index = 2;
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
    expect(await readFile(tamperPath)).toEqual(beforeTamper);

    const staleHarness = await createHarness(roots);
    const stalePlan = await plan(staleHarness.service, {
      type: "moveLayer",
      layerId: TILE_LAYER_ID,
      index: 1,
    });
    const externallyEdited = baseMap();
    externallyEdited.vendorExternalEdit = true;
    const stalePath = join(staleHarness.root, MAP_PATH);
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

  it.skipIf(!hasTiledCli)("survives a real Tiled 1.12 JSON export round-trip when the CLI is available", async () => {
    const harness = await createHarness(roots);
    const movePlan = await plan(harness.service, {
      type: "moveLayer",
      layerId: NESTED_GROUP_ID,
      index: 0,
    });
    await harness.service.applyEdits(movePlan);

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

    const exported = JSON.parse(
      await readFile(outputPath, "utf8"),
    ) as JsonObject;
    expect(rootLayerIds(exported)[0]).toBe(
      NESTED_GROUP_ID,
    );
    expect(
      findLayer(exported, DEEP_OBJECT_LAYER_ID),
    ).toBeDefined();
    expect(exported.nextlayerid).toBe(9);
    expect(exported.nextobjectid).toBe(11);
  }, 40_000);
});

async function createHarness(
  roots: Set<string>,
  map: JsonObject = baseMap(),
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-move-layer-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "images"));
  await writeJson(join(root, MAP_PATH), map);
  await writeFile(
    join(root, "images", "backdrop.svg"),
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16">',
      '<rect width="32" height="16" fill="#334455"/>',
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
      makeStore(resolver),
    ),
  };
}

function baseMap(): JsonObject {
  return {
    compressionlevel: -1,
    height: 2,
    infinite: false,
    layers: [
      {
        data: [0, 0, 0, 0],
        height: 2,
        id: TILE_LAYER_ID,
        name: "Ground",
        opacity: 1,
        type: "tilelayer",
        vendorTileExtension: {
          preserve: ["tile", 17],
        },
        visible: true,
        width: 2,
        x: 0,
        y: 0,
      },
      {
        draworder: "topdown",
        id: OBJECT_LAYER_ID,
        name: "Objects",
        objects: [],
        opacity: 1,
        type: "objectgroup",
        visible: true,
        x: 0,
        y: 0,
      },
      {
        id: LOCKED_GROUP_ID,
        layers: [
          {
            data: [0, 0, 0, 0],
            height: 2,
            id: NESTED_TILE_LAYER_ID,
            name: "Nested Ground",
            opacity: 1,
            type: "tilelayer",
            visible: true,
            width: 2,
            x: 0,
            y: 0,
          },
          {
            id: NESTED_GROUP_ID,
            layers: [
              {
                draworder: "topdown",
                id: DEEP_OBJECT_LAYER_ID,
                name: "Deep Objects",
                objects: [
                  {
                    height: 1,
                    id: 10,
                    name: "Deep Object",
                    rotation: 0,
                    type: "",
                    visible: true,
                    width: 1,
                    x: 0,
                    y: 0,
                  },
                ],
                opacity: 1,
                type: "objectgroup",
                visible: true,
                x: 0,
                y: 0,
              },
            ],
            name: "Nested Group",
            opacity: 1,
            type: "group",
            visible: true,
            x: 0,
            y: 0,
          },
        ],
        locked: true,
        name: "Locked Parent",
        opacity: 1,
        type: "group",
        visible: true,
        x: 0,
        y: 0,
      },
      {
        id: TARGET_GROUP_ID,
        layers: [],
        name: "Target",
        opacity: 1,
        type: "group",
        visible: true,
        x: 0,
        y: 0,
      },
      {
        id: IMAGE_LAYER_ID,
        image: "../images/backdrop.svg",
        name: "Backdrop",
        opacity: 1,
        type: "imagelayer",
        visible: true,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 9,
    nextobjectid: 11,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [],
    tilewidth: 16,
    type: "map",
    vendorRootExtension: {
      preserve: ["root", 23],
    },
    version: "1.10",
    width: 2,
  };
}

function depthBoundaryMap(): JsonObject {
  const movable: JsonObject = {
    id: 1,
    layers: [
      {
        id: 2,
        layers: [],
        name: "Movable Child",
        opacity: 1,
        type: "group",
        visible: true,
        x: 0,
        y: 0,
      },
    ],
    name: "Movable",
    opacity: 1,
    type: "group",
    visible: true,
    x: 0,
    y: 0,
  };
  let chain: JsonObject = {
    id: 163,
    layers: [],
    name: "Depth 63",
    opacity: 1,
    type: "group",
    visible: true,
    x: 0,
    y: 0,
  };
  for (let id = 162; id >= 100; id -= 1) {
    chain = {
      id,
      layers: [chain],
      name: `Depth ${id - 100}`,
      opacity: 1,
      type: "group",
      visible: true,
      x: 0,
      y: 0,
    };
  }
  return {
    compressionlevel: -1,
    height: 1,
    infinite: false,
    layers: [movable, chain],
    nextlayerid: 164,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 1,
  };
}

async function plan(
  service: MapService,
  operationOrOperations:
    | MoveLayerOperation
    | readonly MapEditOperation[],
  suppliedSnapshot?: MapSnapshot,
): Promise<MapEditPlan> {
  const snapshot =
    suppliedSnapshot ?? (await mapSnapshot(service));
  const operations = Array.isArray(operationOrOperations)
    ? operationOrOperations
    : [operationOrOperations];
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
  return {
    revision: summary.revision as string,
    dependencies:
      summary.dependencyRevisions as Record<
        string,
        string
      >,
  };
}

function rootLayerIds(map: JsonObject): number[] {
  return (map.layers as JsonObject[]).map(
    (layer) => layer.id as number,
  );
}

function layerChildIds(
  map: JsonObject,
  groupId: number,
): number[] {
  return (
    requireLayer(map, groupId).layers as JsonObject[]
  ).map((layer) => layer.id as number);
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

function requireLayerPath(
  map: JsonObject,
  layerId: number,
): JSONPath {
  const visit = (
    layers: JsonObject[],
    path: JSONPath,
  ): JSONPath | undefined => {
    for (const [index, layer] of layers.entries()) {
      const layerPath: JSONPath = [...path, index];
      if (layer.id === layerId) {
        return layerPath;
      }
      if (Array.isArray(layer.layers)) {
        const nested = visit(
          layer.layers as JsonObject[],
          [...layerPath, "layers"],
        );
        if (nested !== undefined) {
          return nested;
        }
      }
    }
    return undefined;
  };
  const path = visit(
    map.layers as JsonObject[],
    ["layers"],
  );
  if (path === undefined) {
    throw new Error(`Missing fixture layer path ${layerId}.`);
  }
  return path;
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
