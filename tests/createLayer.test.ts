import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
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

import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import {
  MapService,
  MAX_CREATE_TILE_LAYER_CELLS,
} from "../src/maps/mapService.js";
import type {
  CreatableLayerType,
  MapEditOperation,
  MapEditPlan,
  ResolvedCreateLayerOperation,
} from "../src/maps/types.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";
import { revisionOf } from "../src/storage/revision.js";

const MAP_PATH = "maps/level.tmj";
const IMAGE_PATH = "images/backdrop.png";
const GROUP_ID = 2;
const ROOT_NON_GROUP_ID = 7;
const ALLOCATED_LAYER_ID = 9;

interface Harness {
  root: string;
  service: MapService;
  imageBytes: Buffer;
}

interface MapSnapshot {
  revision: string;
  dependencies: Record<string, string>;
}

describe("MapService createLayer", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await rm(harness.root, { recursive: true, force: true });
  });

  it.each([
    {
      layerType: "tilelayer" as const,
      name: "Fresh Tiles",
      allocatedCellCount: 12,
    },
    {
      layerType: "objectgroup" as const,
      name: "Fresh Objects",
      allocatedCellCount: 0,
    },
    {
      layerType: "group" as const,
      name: "Fresh Group",
      allocatedCellCount: 0,
    },
    {
      layerType: "imagelayer" as const,
      name: "Fresh Image",
      allocatedCellCount: 0,
    },
  ])(
    "plans and applies a canonical root $layerType",
    async ({ layerType, name, allocatedCellCount }) => {
      const absoluteMapPath = join(harness.root, MAP_PATH);
      const mapBefore = await readFile(absoluteMapPath);
      const snapshot = await mapSnapshot(harness.service);
      const plan = await harness.service.planCreateLayer({
        mapPath: MAP_PATH,
        layerType,
        name,
        expectedMapRevision: snapshot.revision,
        expectedDependencyRevisions: snapshot.dependencies,
        ...(layerType === "imagelayer"
          ? {
              imagePath: IMAGE_PATH,
              expectedImageRevision: revisionOf(harness.imageBytes),
            }
          : {}),
      });
      const operation = requireCreateLayerOperation(plan);

      expect(await readFile(absoluteMapPath)).toEqual(mapBefore);
      expect(operation).toMatchObject({
        type: "createLayer",
        layerType,
        layerId: ALLOCATED_LAYER_ID,
        name,
        parentGroupId: null,
        index: 2,
        allocatedCellCount,
      });
      expect(plan.summary).toMatchObject({
        operationCount: 1,
        cellWrites: allocatedCellCount,
        affectedLayerIds: [ALLOCATED_LAYER_ID],
        affectedTileLayerIds: [],
        affectedObjectLayerIds: [],
        createdObjectIds: [],
        updatedObjectIds: [],
        deletedObjectIds: [],
        createdLayers: [
          {
            layerId: ALLOCATED_LAYER_ID,
            layerType,
            name,
            parentGroupId: null,
            index: 2,
            allocatedCellCount,
          },
        ],
      });

      if (layerType === "imagelayer") {
        expect(operation.image).toMatchObject({
          assetId: expect.stringMatching(/^asset_[0-9a-f]{24}$/u),
          path: IMAGE_PATH,
          source: "../images/backdrop.png",
          revision: revisionOf(harness.imageBytes),
          width: 5,
          height: 3,
        });
        expect(plan.prospectiveDependencyRevisions).toEqual({
          [operation.image?.assetId ?? "missing"]:
            revisionOf(harness.imageBytes),
        });
      } else {
        expect(operation).not.toHaveProperty("image");
        expect(plan).not.toHaveProperty(
          "prospectiveDependencyRevisions",
        );
      }

      const result = await harness.service.applyEdits(plan);
      const saved = await readMapJson(absoluteMapPath);
      const layers = saved.layers as JsonObject[];

      expect(result).toMatchObject({
        path: MAP_PATH,
        changed: true,
        revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        changeSetId: plan.id,
      });
      expect(saved.nextlayerid).toBe(10);
      expect(layers.map(({ id }) => id)).toEqual([
        GROUP_ID,
        ROOT_NON_GROUP_ID,
        ALLOCATED_LAYER_ID,
      ]);
      expect(layers[2]).toEqual(
        canonicalLayer(layerType, name),
      );
      expect(await readFile(join(harness.root, IMAGE_PATH))).toEqual(
        harness.imageBytes,
      );
    },
  );

  it("inserts at a nested index while preserving existing source lexemes", async () => {
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const unusualSource =
      `\uFEFF${JSON.stringify(baseMap(), null, "\t")
        .replace(
          '"compressionlevel": -1',
          '"compressionlevel": -1.000e+0',
        )
        .replace('"Nested A"', '"\\u004eested A"')
        .replace(/\n/gu, "\r\n")}\r\n`;
    await writeFile(absoluteMapPath, unusualSource, "utf8");
    const before = await readFile(absoluteMapPath, "utf8");
    const preservedNodes = [
      jsonNodeSource(before, ["layers", 0, "layers", 0]),
      jsonNodeSource(before, ["layers", 0, "layers", 1]),
      jsonNodeSource(before, ["layers", 1]),
      jsonNodeSource(before, ["vendorExtension"]),
    ];
    const snapshot = await mapSnapshot(harness.service);

    const plan = await harness.service.planCreateLayer({
      mapPath: MAP_PATH,
      layerType: "objectgroup",
      name: "Nested Insert",
      parentGroupId: GROUP_ID,
      index: 1,
      expectedMapRevision: snapshot.revision,
      expectedDependencyRevisions: snapshot.dependencies,
    });

    expect(await readFile(absoluteMapPath, "utf8")).toBe(before);
    expect(requireCreateLayerOperation(plan)).toMatchObject({
      layerId: ALLOCATED_LAYER_ID,
      parentGroupId: GROUP_ID,
      index: 1,
    });
    await harness.service.applyEdits(plan);

    const after = await readFile(absoluteMapPath, "utf8");
    const saved = await readMapJson(absoluteMapPath);
    const rootLayers = saved.layers as JsonObject[];
    const group = rootLayers[0];
    const children = group?.layers as JsonObject[];

    expect(after.startsWith("\uFEFF")).toBe(true);
    expect(after).toContain("\r\n");
    expect(after).toContain('"compressionlevel": -1.000e+0');
    for (const preservedNode of preservedNodes) {
      expect(after).toContain(preservedNode);
    }
    expect(saved.nextlayerid).toBe(10);
    expect(children.map(({ id }) => id)).toEqual([
      3,
      ALLOCATED_LAYER_ID,
      4,
    ]);
    expect(children[1]).toEqual(
      canonicalLayer("objectgroup", "Nested Insert"),
    );
  });

  it("uses nextlayerid as a high-water mark and rejects invalid allocation bounds", async () => {
    const highWaterMap = baseMap();
    highWaterMap.nextlayerid = 20;
    await writeJson(join(harness.root, MAP_PATH), highWaterMap);
    const highWaterSnapshot = await mapSnapshot(harness.service);
    const plan = await harness.service.planCreateLayer({
      mapPath: MAP_PATH,
      layerType: "group",
      name: "No Gap Filling",
      expectedMapRevision: highWaterSnapshot.revision,
      expectedDependencyRevisions: highWaterSnapshot.dependencies,
    });

    expect(requireCreateLayerOperation(plan).layerId).toBe(20);
    await harness.service.applyEdits(plan);
    expect(
      (await readMapJson(join(harness.root, MAP_PATH))).nextlayerid,
    ).toBe(21);

    for (const [nextlayerid, code] of [
      [ROOT_NON_GROUP_ID, "NEXT_LAYER_ID_INVALID"],
      [0, "NEXT_LAYER_ID_INVALID"],
      [0x7fffffff, "LAYER_ID_EXHAUSTED"],
    ] as const) {
      const invalid = baseMap();
      invalid.nextlayerid = nextlayerid;
      await writeJson(join(harness.root, MAP_PATH), invalid);
      const snapshot = await mapSnapshot(harness.service);

      await expect(
        harness.service.planCreateLayer({
          mapPath: MAP_PATH,
          layerType: "group",
          name: "Rejected",
          expectedMapRevision: snapshot.revision,
          expectedDependencyRevisions: snapshot.dependencies,
        }),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code,
      });
    }
  });

  it("validates the parent, insertion index, and tile allocation budget before planning", async () => {
    const snapshot = await mapSnapshot(harness.service);
    await expect(
      harness.service.planCreateLayer({
        mapPath: MAP_PATH,
        layerType: "group",
        name: "Missing Parent",
        parentGroupId: 999,
        expectedMapRevision: snapshot.revision,
        expectedDependencyRevisions: snapshot.dependencies,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_NOT_FOUND",
      details: { layerId: 999 },
    });
    await expect(
      harness.service.planCreateLayer({
        mapPath: MAP_PATH,
        layerType: "group",
        name: "Wrong Parent Kind",
        parentGroupId: ROOT_NON_GROUP_ID,
        expectedMapRevision: snapshot.revision,
        expectedDependencyRevisions: snapshot.dependencies,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_TYPE_MISMATCH",
      details: { layerId: ROOT_NON_GROUP_ID },
    });
    await expect(
      harness.service.planCreateLayer({
        mapPath: MAP_PATH,
        layerType: "group",
        name: "Bad Root Index",
        index: 3,
        expectedMapRevision: snapshot.revision,
        expectedDependencyRevisions: snapshot.dependencies,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_INDEX_OUT_OF_RANGE",
      details: { index: 3, minimum: 0, maximum: 2 },
    });

    const tooLarge = baseMap();
    tooLarge.width = MAX_CREATE_TILE_LAYER_CELLS + 1;
    tooLarge.height = 1;
    await writeJson(join(harness.root, MAP_PATH), tooLarge);
    const oversizedSnapshot = await mapSnapshot(harness.service);
    await expect(
      harness.service.planCreateLayer({
        mapPath: MAP_PATH,
        layerType: "tilelayer",
        name: "Too Many Cells",
        expectedMapRevision: oversizedSnapshot.revision,
        expectedDependencyRevisions:
          oversizedSnapshot.dependencies,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        width: MAX_CREATE_TILE_LAYER_CELLS + 1,
        height: 1,
        actual: MAX_CREATE_TILE_LAYER_CELLS + 1,
        limit: MAX_CREATE_TILE_LAYER_CELLS,
      },
    });

    const exactBoundary = baseMap();
    exactBoundary.width = MAX_CREATE_TILE_LAYER_CELLS;
    exactBoundary.height = 1;
    await writeJson(join(harness.root, MAP_PATH), exactBoundary);
    const boundarySnapshot = await mapSnapshot(harness.service);
    const boundaryPlan = await harness.service.planCreateLayer({
      mapPath: MAP_PATH,
      layerType: "tilelayer",
      name: "At Cell Limit",
      expectedMapRevision: boundarySnapshot.revision,
      expectedDependencyRevisions:
        boundarySnapshot.dependencies,
    });
    expect(requireCreateLayerOperation(boundaryPlan)).toMatchObject({
      allocatedCellCount: MAX_CREATE_TILE_LAYER_CELLS,
    });
    expect(boundaryPlan.summary.cellWrites).toBe(
      MAX_CREATE_TILE_LAYER_CELLS,
    );
    const boundaryResult =
      await harness.service.applyEdits(boundaryPlan);
    const savedBoundary = await readMapJson(
      join(harness.root, MAP_PATH),
    );
    const savedBoundaryLayers =
      savedBoundary.layers as JsonObject[];
    const savedBoundaryLayer = savedBoundaryLayers.at(-1);
    const savedBoundaryData =
      savedBoundaryLayer?.data as unknown[] | undefined;

    expect(boundaryResult).toMatchObject({
      changed: true,
      checkpointId: expect.any(String),
      changeSetId: boundaryPlan.id,
    });
    expect(savedBoundary.nextlayerid).toBe(
      ALLOCATED_LAYER_ID + 1,
    );
    expect(savedBoundaryLayer).toMatchObject({
      id: ALLOCATED_LAYER_ID,
      name: "At Cell Limit",
      type: "tilelayer",
      width: MAX_CREATE_TILE_LAYER_CELLS,
      height: 1,
    });
    expect(savedBoundaryData).toHaveLength(
      MAX_CREATE_TILE_LAYER_CELLS,
    );
    expect(savedBoundaryData?.every((cell) => cell === 0)).toBe(
      true,
    );
  });

  it("reports a stale image revision before inspecting malformed replacement bytes", async () => {
    const absoluteImagePath = join(harness.root, IMAGE_PATH);
    const originalRevision = revisionOf(harness.imageBytes);
    const replacement = Buffer.from("not an image", "utf8");
    await writeFile(absoluteImagePath, replacement);
    const snapshot = await mapSnapshot(harness.service);

    await expect(
      harness.service.planCreateLayer({
        mapPath: MAP_PATH,
        layerType: "imagelayer",
        name: "Stale Image",
        imagePath: IMAGE_PATH,
        expectedImageRevision: originalRevision,
        expectedMapRevision: snapshot.revision,
        expectedDependencyRevisions: snapshot.dependencies,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        path: IMAGE_PATH,
        expectedRevision: originalRevision,
        actualRevision: revisionOf(replacement),
      },
    });
  });

  it("rejects apply when an image-layer dependency revision changes, even to malformed bytes", async () => {
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const absoluteImagePath = join(harness.root, IMAGE_PATH);
    const mapBefore = await readFile(absoluteMapPath);
    const snapshot = await mapSnapshot(harness.service);
    const plan = await harness.service.planCreateLayer({
      mapPath: MAP_PATH,
      layerType: "imagelayer",
      name: "Pinned Image",
      imagePath: IMAGE_PATH,
      expectedImageRevision: revisionOf(harness.imageBytes),
      expectedMapRevision: snapshot.revision,
      expectedDependencyRevisions: snapshot.dependencies,
    });
    const operation = requireCreateLayerOperation(plan);
    const replacement = Buffer.from("not an image anymore", "utf8");

    await writeFile(absoluteImagePath, replacement);
    await expect(
      harness.service.applyEdits(plan),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: {
        path: IMAGE_PATH,
        assetId: operation.image?.assetId,
        expectedRevision: revisionOf(harness.imageBytes),
        actualRevision: revisionOf(replacement),
      },
    });
    expect(await readFile(absoluteMapPath)).toEqual(mapBefore);
    expect(await readFile(absoluteImagePath)).toEqual(replacement);
  });

  it("keeps resolved createLayer operations out of the generic edit planner", async () => {
    const snapshot = await mapSnapshot(harness.service);
    const dedicatedPlan = await harness.service.planCreateLayer({
      mapPath: MAP_PATH,
      layerType: "group",
      name: "Dedicated Only",
      expectedMapRevision: snapshot.revision,
      expectedDependencyRevisions: snapshot.dependencies,
    });

    await expect(
      harness.service.planEdits(
        MAP_PATH,
        snapshot.revision,
        snapshot.dependencies,
        dedicatedPlan.operations as unknown as readonly MapEditOperation[],
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining(
        "dedicated preview tool",
      ),
    });
  });
});

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "tiledmcp-create-layer-"));
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "images"));
  const imageBytes = await testImagePng();
  await writeJson(join(root, MAP_PATH), baseMap());
  await writeFile(join(root, IMAGE_PATH), imageBytes);
  const resolver = await ProjectPathResolver.create(root);
  return {
    root,
    imageBytes,
    service: new MapService(
      resolver,
      new DocumentStore(resolver),
    ),
  };
}

function baseMap(): JsonObject {
  return {
    compressionlevel: -1,
    height: 3,
    infinite: false,
    layers: [
      {
        id: GROUP_ID,
        layers: [
          {
            draworder: "topdown",
            id: 3,
            name: "Nested A",
            objects: [],
            opacity: 1,
            type: "objectgroup",
            visible: true,
            x: 0,
            y: 0,
            vendorNestedA: {
              preserve: ["first", 1],
            },
          },
          {
            id: 4,
            layers: [],
            name: "Nested B",
            opacity: 1,
            type: "group",
            visible: true,
            x: 0,
            y: 0,
            vendorNestedB: {
              preserve: ["second", 2],
            },
          },
        ],
        name: "Parent Group",
        opacity: 1,
        type: "group",
        visible: true,
        x: 0,
        y: 0,
        vendorGroupExtension: {
          preserve: true,
        },
      },
      {
        draworder: "topdown",
        id: ROOT_NON_GROUP_ID,
        name: "Existing Root",
        objects: [],
        opacity: 1,
        type: "objectgroup",
        visible: true,
        x: 0,
        y: 0,
        vendorRootLayerExtension: {
          preserve: "root sibling",
        },
      },
    ],
    nextlayerid: ALLOCATED_LAYER_ID,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [],
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

function canonicalLayer(
  layerType: CreatableLayerType,
  name: string,
): JsonObject {
  const common = {
    id: ALLOCATED_LAYER_ID,
    name,
    opacity: 1,
    type: layerType,
    visible: true,
    x: 0,
    y: 0,
  };
  if (layerType === "tilelayer") {
    return {
      data: Array.from({ length: 12 }, () => 0),
      height: 3,
      ...common,
      width: 4,
    };
  }
  if (layerType === "objectgroup") {
    return {
      draworder: "topdown",
      ...common,
      objects: [],
    };
  }
  if (layerType === "group") {
    return {
      id: common.id,
      layers: [],
      name: common.name,
      opacity: common.opacity,
      type: common.type,
      visible: common.visible,
      x: common.x,
      y: common.y,
    };
  }
  return {
    id: common.id,
    image: "../images/backdrop.png",
    imageheight: 3,
    imagewidth: 5,
    name: common.name,
    opacity: common.opacity,
    type: common.type,
    visible: common.visible,
    x: common.x,
    y: common.y,
  };
}

async function mapSnapshot(service: MapService): Promise<MapSnapshot> {
  const summary = await service.getSummary(MAP_PATH);
  return {
    revision: summary.revision as string,
    dependencies: summary.dependencyRevisions as Record<
      string,
      string
    >,
  };
}

function requireCreateLayerOperation(
  plan: MapEditPlan,
): ResolvedCreateLayerOperation {
  const operation = plan.operations[0];
  if (
    operation === undefined ||
    operation.type !== "createLayer"
  ) {
    throw new Error(
      "Expected one resolved createLayer operation.",
    );
  }
  return operation;
}

async function writeJson(
  path: string,
  document: JsonObject,
): Promise<void> {
  await writeFile(path, serializeJsonDocument(document));
}

async function readMapJson(path: string): Promise<JsonObject> {
  const source = await readFile(path, "utf8");
  const body =
    source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return JSON.parse(body) as JsonObject;
}

function jsonNodeSource(
  source: string,
  path: JSONPath,
): string {
  const body =
    source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const tree = parseTree(body, [], {
    allowTrailingComma: false,
    disallowComments: true,
    allowEmptyContent: false,
  });
  if (tree === undefined) {
    throw new Error("Expected a valid JSON source fixture.");
  }
  const node = findNodeAtLocation(tree, path);
  if (node === undefined) {
    throw new Error(
      `Missing JSON source fixture path ${JSON.stringify(path)}.`,
    );
  }
  return body.slice(node.offset, node.offset + node.length);
}

async function testImagePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 5,
      height: 3,
      channels: 4,
      background: {
        r: 29,
        g: 78,
        b: 121,
        alpha: 1,
      },
    },
  })
    .png()
    .toBuffer();
}
