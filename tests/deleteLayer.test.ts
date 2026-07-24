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
  DeleteLayerOperation,
  MapEditOperation,
  MapEditPlan,
} from "../src/maps/types.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/level.tmj";
const TILE_LAYER_ID = 1;
const GROUP_LAYER_ID = 2;
const NESTED_OBJECT_LAYER_ID = 3;
const NESTED_GROUP_ID = 4;
const NESTED_IMAGE_LAYER_ID = 5;
const ROOT_OBJECT_LAYER_ID = 6;
const ROOT_IMAGE_LAYER_ID = 7;

interface Harness {
  root: string;
  service: MapService;
}

interface MapSnapshot {
  revision: string;
  dependencies: Record<string, string>;
}

describe("deleteLayer", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("previews and applies a root leaf deletion without lowering id high-water marks", async () => {
    const harness = await createHarness(roots);
    const deletionPlan = await plan(harness.service, {
      type: "deleteLayer",
      layerId: TILE_LAYER_ID,
    });

    expect(deletionPlan.summary).toMatchObject({
      operationCount: 1,
      cellWrites: 0,
      affectedLayerIds: [TILE_LAYER_ID],
      affectedTileLayerIds: [],
      affectedObjectLayerIds: [],
      createdObjectIds: [],
      updatedObjectIds: [],
      deletedObjectIds: [],
      deletedLayers: [
        {
          operationIndex: 0,
          layerId: TILE_LAYER_ID,
          layerType: "tilelayer",
          name: "Ground",
          nameTruncated: false,
          parentGroupId: null,
          index: 0,
          deletedLayerCount: 1,
          descendantLayerCount: 0,
          layerIdSample: [TILE_LAYER_ID],
          omittedLayerCount: 0,
          objectCount: 0,
          objectIdSample: [],
          omittedObjectCount: 0,
          lockedLayerCount: 1,
        },
      ],
    });

    const preview =
      new ChangeSetRegistry().put(deletionPlan);
    expect(preview.operations).toEqual([
      expect.objectContaining({
        type: "deleteLayer",
        layerId: TILE_LAYER_ID,
        deleteDescendants: false,
        destructive: true,
        lockedLayerCount: 1,
      }),
    ]);

    const result =
      await harness.service.applyEdits(deletionPlan);
    expect(result.changed).toBe(true);
    const map = await readMap(harness.root);
    expect(findLayer(map, TILE_LAYER_ID)).toBeUndefined();
    expect(map.nextlayerid).toBe(8);
    expect(map.nextobjectid).toBe(21);
  });

  it("deletes a nested leaf from its exact parent and leaves the parent in place", async () => {
    const harness = await createHarness(roots);
    const deletionPlan = await plan(harness.service, {
      type: "deleteLayer",
      layerId: NESTED_IMAGE_LAYER_ID,
    });

    expect(deletionPlan.summary.deletedLayers).toEqual([
      expect.objectContaining({
        layerId: NESTED_IMAGE_LAYER_ID,
        parentGroupId: NESTED_GROUP_ID,
        index: 0,
        deletedLayerCount: 1,
      }),
    ]);
    await harness.service.applyEdits(deletionPlan);

    const map = await readMap(harness.root);
    const parent = requireLayer(map, NESTED_GROUP_ID);
    expect(parent.layers).toEqual([]);
    expect(findLayer(map, GROUP_LAYER_ID)).toBeDefined();
  });

  it("allows deleting an empty group without recursive confirmation", async () => {
    const map = baseMap();
    requireLayer(map, NESTED_GROUP_ID).layers = [];
    const harness = await createHarness(roots, map);
    const deletionPlan = await plan(harness.service, {
      type: "deleteLayer",
      layerId: NESTED_GROUP_ID,
    });

    expect(deletionPlan.summary.deletedLayers).toEqual([
      expect.objectContaining({
        layerId: NESTED_GROUP_ID,
        layerType: "group",
        parentGroupId: GROUP_LAYER_ID,
        descendantLayerCount: 0,
      }),
    ]);
    await harness.service.applyEdits(deletionPlan);
    expect(
      findLayer(
        await readMap(harness.root),
        NESTED_GROUP_ID,
      ),
    ).toBeUndefined();
  });

  it("requires explicit recursive confirmation for a non-empty group and reports a bounded subtree summary", async () => {
    const harness = await createHarness(roots);

    await expect(
      plan(harness.service, {
        type: "deleteLayer",
        layerId: GROUP_LAYER_ID,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_HAS_DESCENDANTS",
      details: {
        layerId: GROUP_LAYER_ID,
        descendantLayerCount: 3,
      },
    });

    const recursivePlan = await plan(harness.service, {
      type: "deleteLayer",
      layerId: GROUP_LAYER_ID,
      deleteDescendants: true,
    });
    expect(recursivePlan.summary.deletedLayers).toEqual([
      expect.objectContaining({
        layerId: GROUP_LAYER_ID,
        parentGroupId: null,
        index: 1,
        deletedLayerCount: 4,
        descendantLayerCount: 3,
        layerIdSample: [
          GROUP_LAYER_ID,
          NESTED_OBJECT_LAYER_ID,
          NESTED_GROUP_ID,
          NESTED_IMAGE_LAYER_ID,
        ],
        omittedLayerCount: 0,
        objectCount: 2,
        objectIdSample: [10, 11],
        omittedObjectCount: 0,
        lockedLayerCount: 2,
      }),
    ]);

    const preview =
      new ChangeSetRegistry().put(recursivePlan);
    expect(preview.operations[0]).toMatchObject({
      type: "deleteLayer",
      deleteDescendants: true,
      destructive: true,
      descendantLayerCount: 3,
      objectCount: 2,
      lockedLayerCount: 2,
    });

    await harness.service.applyEdits(recursivePlan);
    const map = await readMap(harness.root);
    expect(findLayer(map, GROUP_LAYER_ID)).toBeUndefined();
    expect(findLayer(map, ROOT_OBJECT_LAYER_ID)).toBeDefined();
    expect(map.nextlayerid).toBe(8);
    expect(map.nextobjectid).toBe(21);
    expect(
      await readFile(
        join(
          harness.root,
          "images",
          "backdrop.svg",
        ),
        "utf8",
      ),
    ).toContain("<svg");
  });

  it("bounds deleted layer and object id samples independently", async () => {
    const map = baseMap();
    const group = requireLayer(map, GROUP_LAYER_ID);
    group.name = `${"🧩".repeat(128)}extra`;
    group.layers = Array.from(
      { length: 40 },
      (_, index): JsonObject => ({
        draworder: "topdown",
        id: 100 + index,
        name: `Objects ${index}`,
        objects: [
          {
            height: 1,
            id: 1_000 + index,
            name: `Object ${index}`,
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
      }),
    );
    map.nextlayerid = 140;
    map.nextobjectid = 1_040;
    const harness = await createHarness(roots, map);

    const deletionPlan = await plan(harness.service, {
      type: "deleteLayer",
      layerId: GROUP_LAYER_ID,
      deleteDescendants: true,
    });
    const deletion =
      deletionPlan.summary.deletedLayers?.[0];
    expect(deletion).toMatchObject({
      name: "🧩".repeat(128),
      nameTruncated: true,
      deletedLayerCount: 41,
      descendantLayerCount: 40,
      omittedLayerCount: 9,
      objectCount: 40,
      omittedObjectCount: 8,
    });
    expect(deletion?.layerIdSample).toHaveLength(32);
    expect(deletion?.layerIdSample[0]).toBe(
      GROUP_LAYER_ID,
    );
    expect(deletion?.objectIdSample).toHaveLength(32);

    await harness.service.applyEdits(deletionPlan);
    const saved = await readMap(harness.root);
    expect(findLayer(saved, GROUP_LAYER_ID)).toBeUndefined();
    expect(saved.nextlayerid).toBe(140);
    expect(saved.nextobjectid).toBe(1_040);
  });

  it.each([
    {
      label: "direct",
      property: {
        name: "target",
        type: "object",
        value: 10,
      },
      expectedPointer:
        "/layers/2/objects/0/properties/0",
    },
    {
      label: "Tiled 1.12 list",
      property: {
        name: "targets",
        type: "list",
        value: [{ type: "object", value: 10 }],
      },
      expectedPointer:
        "/layers/2/objects/0/properties/0/value/0",
    },
  ])(
    "refuses recursive deletion when a surviving $label property references a removed object",
    async ({ property, expectedPointer }) => {
      const map = baseMap();
      const survivingObjects = requireLayer(
        map,
        ROOT_OBJECT_LAYER_ID,
      ).objects as JsonObject[];
      (survivingObjects[0] as JsonObject).properties = [
        property,
      ];
      const harness = await createHarness(roots, map);

      await expect(
        plan(harness.service, {
          type: "deleteLayer",
          layerId: GROUP_LAYER_ID,
          deleteDescendants: true,
        }),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "OBJECT_IN_USE",
        details: {
          objectId: 10,
          jsonPointer: expectedPointer,
        },
      });
    },
  );

  it("fails closed when a surviving class property may hide an object reference", async () => {
    const map = baseMap();
    const survivingObjects = requireLayer(
      map,
      ROOT_OBJECT_LAYER_ID,
    ).objects as JsonObject[];
    (survivingObjects[0] as JsonObject).properties = [
      {
        name: "configuration",
        type: "class",
        propertytype: "GameplayConfig",
        value: { target: 10 },
      },
    ];
    const harness = await createHarness(roots, map);

    await expect(
      plan(harness.service, {
        type: "deleteLayer",
        layerId: GROUP_LAYER_ID,
        deleteDescendants: true,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "UNSUPPORTED_OBJECT_REFERENCE_ANALYSIS",
      details: {
        propertyName: "configuration",
        jsonPointer:
          "/layers/2/objects/0/properties/0",
      },
    });
  });

  it("treats the target parent as surviving when checking object references", async () => {
    const map = baseMap();
    const parent = requireLayer(map, GROUP_LAYER_ID);
    parent.properties = [
      {
        name: "childTarget",
        type: "object",
        value: 10,
      },
    ];
    const harness = await createHarness(roots, map);

    await expect(
      plan(harness.service, {
        type: "deleteLayer",
        layerId: NESTED_OBJECT_LAYER_ID,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "OBJECT_IN_USE",
      details: {
        objectId: 10,
        propertyName: "childTarget",
        jsonPointer: "/layers/1/properties/0",
      },
    });
  });

  it("keeps deleteLayer exclusive and rejects missing or malformed targets", async () => {
    const harness = await createHarness(roots);

    await expect(
      plan(harness.service, [
        {
          type: "deleteLayer",
          layerId: TILE_LAYER_ID,
        },
        {
          type: "updateLayer",
          layerId: ROOT_IMAGE_LAYER_ID,
          patch: { visible: false },
        },
      ]),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
    });

    await expect(
      plan(harness.service, {
        type: "deleteLayer",
        layerId: 999,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_NOT_FOUND",
    });

    await expect(
      plan(
        harness.service,
        {
          type: "deleteLayer",
          layerId: TILE_LAYER_ID,
          deleteDescendants: "yes",
        } as unknown as DeleteLayerOperation,
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
    });
  });

  it("preserves BOM, CRLF and every untouched sibling lexeme", async () => {
    const harness = await createHarness(roots);
    const mapPath = join(harness.root, MAP_PATH);
    const lexicalMap = baseMap();
    lexicalMap.vendorRootExtension = {
      futureNumber: 100,
      preserve: ["root", 23],
    };
    const source =
      `\uFEFF${serializeJsonDocument(lexicalMap)
        .toString("utf8")
        .replace(
          '"futureNumber": 100',
          '"futureNumber": 1e+2',
        )
        .replace(/\n/gu, "\r\n")}`;
    await writeFile(mapPath, source, "utf8");
    const before = await readFile(mapPath, "utf8");
    const untouchedGroup = sourceValueAt(before, [
      "layers",
      1,
    ]);
    const untouchedRootExtension = sourceValueAt(before, [
      "vendorRootExtension",
    ]);

    const deletionPlan = await plan(harness.service, {
      type: "deleteLayer",
      layerId: TILE_LAYER_ID,
    });
    await harness.service.applyEdits(deletionPlan);

    const after = await readFile(mapPath, "utf8");
    expect(after.startsWith("\uFEFF")).toBe(true);
    expect(after).toContain("\r\n");
    expect(after).not.toMatch(/(?<!\r)\n/u);
    expect(sourceValueAt(after, ["layers", 0])).toBe(
      untouchedGroup,
    );
    expect(
      sourceValueAt(after, ["vendorRootExtension"]),
    ).toBe(untouchedRootExtension);
    expect(after).toContain('"futureNumber": 1e+2');
  });

  it("rejects tampered and stale plans without changing map bytes", async () => {
    const tamperHarness = await createHarness(roots);
    const tampered = structuredClone(
      await plan(tamperHarness.service, {
        type: "deleteLayer",
        layerId: TILE_LAYER_ID,
      }),
    );
    const operation =
      tampered.operations[0] as DeleteLayerOperation;
    operation.layerId = ROOT_IMAGE_LAYER_ID;
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
      type: "deleteLayer",
      layerId: TILE_LAYER_ID,
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

  it("survives a real Tiled 1.12 JSON export round-trip when the CLI is available", async () => {
    const harness = await createHarness(roots);
    const deletionPlan = await plan(harness.service, {
      type: "deleteLayer",
      layerId: GROUP_LAYER_ID,
      deleteDescendants: true,
    });
    await harness.service.applyEdits(deletionPlan);

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
    expect(findLayer(exported, GROUP_LAYER_ID)).toBeUndefined();
    expect(
      findLayer(exported, ROOT_OBJECT_LAYER_ID),
    ).toBeDefined();
    expect(exported.nextlayerid).toBe(8);
    expect(exported.nextobjectid).toBe(21);
  }, 40_000);
});

async function createHarness(
  roots: Set<string>,
  map: JsonObject = baseMap(),
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-delete-layer-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "images"));
  await writeJson(join(root, MAP_PATH), map);
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
    height: 2,
    infinite: false,
    layers: [
      {
        data: [0, 0, 0, 0],
        height: 2,
        id: TILE_LAYER_ID,
        locked: true,
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
        id: GROUP_LAYER_ID,
        layers: [
          {
            draworder: "topdown",
            id: NESTED_OBJECT_LAYER_ID,
            locked: true,
            name: "Nested Objects",
            objects: [
              {
                height: 8,
                id: 10,
                name: "A",
                properties: [
                  {
                    name: "peer",
                    type: "object",
                    value: 11,
                  },
                  {
                    name: "deletedConfiguration",
                    type: "class",
                    propertytype: "GameplayConfig",
                    value: { target: 11 },
                  },
                ],
                rotation: 0,
                type: "",
                visible: true,
                width: 8,
                x: 1,
                y: 1,
              },
              {
                height: 8,
                id: 11,
                name: "B",
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
          {
            id: NESTED_GROUP_ID,
            layers: [
              {
                id: NESTED_IMAGE_LAYER_ID,
                image: "../images/backdrop.svg",
                name: "Nested Image",
                opacity: 1,
                type: "imagelayer",
                visible: true,
                x: 0,
                y: 0,
              },
            ],
            locked: true,
            name: "Nested Group",
            opacity: 1,
            type: "group",
            visible: true,
            x: 0,
            y: 0,
          },
        ],
        name: "Gameplay",
        opacity: 1,
        type: "group",
        visible: true,
        x: 0,
        y: 0,
      },
      {
        draworder: "topdown",
        id: ROOT_OBJECT_LAYER_ID,
        name: "Survivors",
        objects: [
          {
            height: 8,
            id: 20,
            name: "Survivor",
            rotation: 0,
            type: "",
            visible: true,
            width: 8,
            x: 3,
            y: 3,
          },
        ],
        opacity: 1,
        type: "objectgroup",
        visible: true,
        x: 0,
        y: 0,
      },
      {
        id: ROOT_IMAGE_LAYER_ID,
        image: "../images/backdrop.svg",
        name: "Backdrop",
        opacity: 1,
        type: "imagelayer",
        visible: true,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 8,
    nextobjectid: 21,
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

async function plan(
  service: MapService,
  operationOrOperations:
    | DeleteLayerOperation
    | readonly MapEditOperation[],
): Promise<MapEditPlan> {
  const snapshot = await mapSnapshot(service);
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
