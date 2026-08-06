import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import sharp from "sharp";

import { TiledCliAdapter } from "../src/adapters/tiledCli.js";
import type { JsonObject } from "../src/formats/json.js";
import { createTiledMcpServer } from "../src/server.js";
import {
  createProject,
  disposeProject,
  type TestProject,
} from "./support/project.js";

const MAP_PATH = "maps/level.tmj";
const SOURCE_MAP_PATH = "maps/room.tmj";
const BROKEN_MAP_PATH = "maps/broken.tmj";
const TEMPLATE_PATH = "templates/crate.tj";
const TILESET_PATH = "tiles/decor.tsj";
const REFERENCE_PATH = "reference/sketch.png";
const TILE_LAYER_ID = 1;
const OBJECT_LAYER_ID = 2;

/**
 * The eight summary members every narrowed schema declares. Asserting the key
 * set exactly is the load-bearing check: it proves no *optional* member of the
 * generic union appeared, which is the claim each narrowed schema makes. A
 * looser `toMatchObject` would pass even if `transcodes` or
 * `chunkedTileLayerIds` showed up, and `register()` would then have converted
 * the schema mismatch into an opaque INTERNAL_ERROR on a real map.
 */
const BASE_SUMMARY_KEYS = [
  "affectedLayerIds",
  "affectedObjectLayerIds",
  "affectedTileLayerIds",
  "cellWrites",
  "createdObjectIds",
  "deletedObjectIds",
  "operationCount",
  "updatedObjectIds",
];

interface Plan {
  kind: string;
  operations: Array<{ type: string }>;
  summary: Record<string, unknown>;
}

describe("narrowed map-edit preview outputs over the MCP tool surface", () => {
  let project: TestProject;
  let client: Client;
  let mapRevision: string;
  let sourceRevision: string;
  let brokenRevision: string;
  let brokenDependencyRevisions: Record<
    string,
    string
  >;
  let dependencyRevisions: Record<string, string>;
  let assetId: string;

  // Previews never write, so one project serves every tool here.
  beforeAll(async () => {
    ({ project, client } = await harness());
    const map = await summaryOf(client, MAP_PATH);
    mapRevision = map.revision;
    dependencyRevisions = map.dependencyRevisions;
    assetId = map.tilesets[0]?.assetId ?? "";
    sourceRevision = (
      await summaryOf(client, SOURCE_MAP_PATH)
    ).revision;
    const broken = await summaryOf(
      client,
      BROKEN_MAP_PATH,
    );
    brokenRevision = broken.revision;
    brokenDependencyRevisions =
      broken.dependencyRevisions;
  });

  afterAll(async () => {
    await disposeProject(project);
  });

  const tile = (localId: number) => ({
    tileset: { kind: "external" as const, assetId },
    localId,
  });

  it("tiled_preview_generate emits exactly one setTiles", async () => {
    const plan = await preview(
      client,
      "tiled_preview_generate",
      {
        mapPath: MAP_PATH,
        layerId: TILE_LAYER_ID,
        region: { x: 0, y: 0, width: 4, height: 4 },
        seed: 42,
        generator: { algorithm: "noise", scale: 4 },
        mapping: [
          { min: 0, max: 1, tile: tile(0) },
        ],
        expectedMapRevision: mapRevision,
        expectedDependencyRevisions:
          dependencyRevisions,
      },
    );
    expectSingleSetTiles(plan);
  });

  it("tiled_preview_scatter emits exactly one setTiles", async () => {
    const plan = await preview(
      client,
      "tiled_preview_scatter",
      {
        mapPath: MAP_PATH,
        layerId: TILE_LAYER_ID,
        region: { x: 0, y: 0, width: 4, height: 4 },
        seed: 42,
        density: 1,
        choices: [{ tile: tile(1), weight: 1 }],
        skipOccupied: false,
        expectedMapRevision: mapRevision,
        expectedDependencyRevisions:
          dependencyRevisions,
      },
    );
    expectSingleSetTiles(plan);
  });

  it("tiled_preview_import_image emits exactly one setTiles", async () => {
    const plan = await preview(
      client,
      "tiled_preview_import_image",
      {
        mapPath: MAP_PATH,
        layerId: TILE_LAYER_ID,
        imagePath: REFERENCE_PATH,
        region: { x: 0, y: 0, width: 2, height: 2 },
        palette: [
          { color: "#ff0000", tile: tile(0) },
          { color: "#00ff00", tile: tile(1) },
        ],
        expectedMapRevision: mapRevision,
        expectedDependencyRevisions:
          dependencyRevisions,
      },
    );
    expectSingleSetTiles(plan);
  });

  it("tiled_preview_terrain emits exactly one setTiles on the native path", async () => {
    // The CLI paths in the harness point at binaries that do not exist, so
    // `evaluate` stays undefined and planTerrainPaint takes its native branch.
    // Both branches end at the same single-element planEdits call.
    const plan = await preview(
      client,
      "tiled_preview_terrain",
      {
        mapPath: MAP_PATH,
        layerId: TILE_LAYER_ID,
        tilesetAssetId: assetId,
        wangSetIndex: 0,
        corners: [
          { x: 0, y: 0, colorIndex: 1 },
          { x: 1, y: 0, colorIndex: 1 },
          { x: 0, y: 1, colorIndex: 1 },
          { x: 1, y: 1, colorIndex: 1 },
        ],
        expectedMapRevision: mapRevision,
        expectedDependencyRevisions:
          dependencyRevisions,
      },
    );
    expectSingleSetTiles(plan);
  });

  it("tiled_preview_validation_fixes emits only setTiles", async () => {
    const plan = await preview(
      client,
      "tiled_preview_validation_fixes",
      {
        mapPath: BROKEN_MAP_PATH,
        expectedMapRevision: brokenRevision,
        expectedDependencyRevisions:
          brokenDependencyRevisions,
      },
    );
    expectSetTilesSequence(plan);
  });

  it("tiled_preview_merge_map emits only setTiles", async () => {
    const plan = await preview(
      client,
      "tiled_preview_merge_map",
      {
        mapPath: MAP_PATH,
        sourceMapPath: SOURCE_MAP_PATH,
        expectedMapRevision: mapRevision,
        expectedDependencyRevisions:
          dependencyRevisions,
        offsetX: 0,
        offsetY: 0,
      },
    );
    expectSetTilesSequence(plan);
  });

  it("tiled_preview_template emits exactly one instantiateTemplate", async () => {
    const plan = await preview(
      client,
      "tiled_preview_template",
      {
        mapPath: MAP_PATH,
        layerId: OBJECT_LAYER_ID,
        templatePath: TEMPLATE_PATH,
        x: 48,
        y: 32,
        expectedMapRevision: mapRevision,
        expectedDependencyRevisions:
          dependencyRevisions,
      },
    );
    expect(plan.kind).toBe("mapEdit");
    expect(
      plan.operations.map(({ type }) => type),
    ).toEqual(["instantiateTemplate"]);
    expect(Object.keys(plan.summary).sort()).toEqual(
      BASE_SUMMARY_KEYS,
    );
    // instantiateTemplate resolves an object layer and writes no cells, which
    // is what pins cellWrites to the literal 0 and affectedTileLayerIds empty.
    expect(plan.summary).toEqual({
      operationCount: 1,
      cellWrites: 0,
      affectedLayerIds: [OBJECT_LAYER_ID],
      affectedTileLayerIds: [],
      affectedObjectLayerIds: [OBJECT_LAYER_ID],
      createdObjectIds: [1],
      updatedObjectIds: [],
      deletedObjectIds: [],
    });
  });

  it("tiled_preview_prefab emits setTiles, createObject and updateObject", async () => {
    const plan = await preview(
      client,
      "tiled_preview_prefab",
      {
        mapPath: MAP_PATH,
        sourceMapPath: SOURCE_MAP_PATH,
        source: {
          layerId: TILE_LAYER_ID,
          x: 0,
          y: 0,
          width: 4,
          height: 3,
        },
        target: {
          layerId: TILE_LAYER_ID,
          x: 0,
          y: 0,
        },
        objects: {
          sourceLayerId: OBJECT_LAYER_ID,
          targetLayerId: OBJECT_LAYER_ID,
        },
        expectedMapRevision: mapRevision,
        expectedDependencyRevisions:
          dependencyRevisions,
        expectedSourceRevision: sourceRevision,
      },
    );
    expect(plan.kind).toBe("mapEdit");
    // The source object carries a scalar custom property, so the follow-up
    // updateObject patch is emitted -- the third and last kind this planner
    // can push, and the reason the narrowed union declares three.
    expect(
      plan.operations.map(({ type }) => type),
    ).toEqual([
      "setTiles",
      "createObject",
      "updateObject",
    ]);
    expect(Object.keys(plan.summary).sort()).toEqual(
      BASE_SUMMARY_KEYS,
    );
    expect(plan.summary).toMatchObject({
      affectedTileLayerIds: [TILE_LAYER_ID],
      affectedObjectLayerIds: [OBJECT_LAYER_ID],
      createdObjectIds: [1],
      updatedObjectIds: [1],
      deletedObjectIds: [],
    });
  });

  it("refuses infinite maps, so no chunked summary is reachable", async () => {
    // chunkedTileLayerIds is the one omitted member that depends on the map
    // rather than on the operation kind. Every planner here loads its context
    // without allowInfinite, so an infinite map never reaches an operation --
    // note that planEdits itself passes allowInfinite: true, which is why this
    // has to be asserted per planner rather than argued once for the shared
    // path. planInstantiateTemplate is excluded: it has no load of its own and
    // needs none, because instantiateTemplate never touches a tile layer.
    const infinite = await harness(infiniteMap());
    try {
      // Pinned with real dependency revisions so the only thing left to
      // reject is the map profile itself.
      const pinned = await summaryOf(
        infinite.client,
        MAP_PATH,
      );
      for (const [name, args] of [
        [
          "tiled_preview_generate",
          {
            layerId: TILE_LAYER_ID,
            region: {
              x: 0,
              y: 0,
              width: 4,
              height: 4,
            },
            seed: 42,
            generator: {
              algorithm: "noise",
              scale: 4,
            },
            mapping: [
              { min: 0, max: 1, tile: null },
            ],
          },
        ],
        [
          "tiled_preview_scatter",
          {
            layerId: TILE_LAYER_ID,
            region: {
              x: 0,
              y: 0,
              width: 4,
              height: 4,
            },
            seed: 42,
            density: 1,
            choices: [
              { tile: null, weight: 1 },
            ],
          },
        ],
        [
          "tiled_preview_validation_fixes",
          {},
        ],
      ] as const) {
        const response = (await infinite.client.callTool(
          {
            name,
            arguments: {
              mapPath: MAP_PATH,
              expectedMapRevision: pinned.revision,
              expectedDependencyRevisions:
                pinned.dependencyRevisions,
              ...args,
            },
          },
        )) as {
          isError?: boolean;
          content?: Array<{ text?: string }>;
        };
        expect(
          `${name}: ${JSON.stringify(response.content)}`,
        ).toMatch(/UNSUPPORTED_MAP_PROFILE/u);
      }
    } finally {
      await disposeProject(infinite.project);
    }
  });
});

/** Every setTiles-only single-operation tool produces this exact summary. */
function expectSingleSetTiles(plan: Plan): void {
  expect(plan.kind).toBe("mapEdit");
  expect(
    plan.operations.map(({ type }) => type),
  ).toEqual(["setTiles"]);
  expect(Object.keys(plan.summary).sort()).toEqual(
    BASE_SUMMARY_KEYS,
  );
  expect(plan.summary).toMatchObject({
    operationCount: 1,
    affectedLayerIds: [TILE_LAYER_ID],
    affectedTileLayerIds: [TILE_LAYER_ID],
    affectedObjectLayerIds: [],
    createdObjectIds: [],
    updatedObjectIds: [],
    deletedObjectIds: [],
  });
  expect(
    plan.summary.cellWrites,
  ).toBeGreaterThan(0);
}

/** validation_fixes and merge_map push one setTiles per touched tile layer. */
function expectSetTilesSequence(plan: Plan): void {
  expect(plan.kind).toBe("mapEdit");
  expect(plan.operations.length).toBeGreaterThan(0);
  expect([
    ...new Set(
      plan.operations.map(({ type }) => type),
    ),
  ]).toEqual(["setTiles"]);
  expect(Object.keys(plan.summary).sort()).toEqual(
    BASE_SUMMARY_KEYS,
  );
  expect(plan.summary).toMatchObject({
    affectedObjectLayerIds: [],
    createdObjectIds: [],
    updatedObjectIds: [],
    deletedObjectIds: [],
  });
}

/**
 * Calls a preview tool and surfaces a failure with its payload. An
 * output-schema mismatch is swallowed into INTERNAL_ERROR by register(), so a
 * bare isError check would report "failed" without saying why.
 */
async function preview(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Plan> {
  const response = (await client.callTool({
    name,
    arguments: args,
  })) as {
    isError?: boolean;
    structuredContent?: { result: unknown };
  };
  if (response.isError === true) {
    throw new Error(
      `${name} failed: ${JSON.stringify(response)}`,
    );
  }
  return response.structuredContent
    ?.result as Plan;
}

async function summaryOf(
  client: Client,
  mapPath: string,
): Promise<{
  revision: string;
  dependencyRevisions: Record<string, string>;
  tilesets: Array<{ assetId: string }>;
}> {
  const response = (await client.callTool({
    name: "tiled_get_map_summary",
    arguments: { mapPath },
  })) as {
    isError?: boolean;
    structuredContent?: { result: unknown };
  };
  if (response.isError === true) {
    throw new Error(
      `tiled_get_map_summary(${mapPath}) failed: ${JSON.stringify(response)}`,
    );
  }
  return response.structuredContent
    ?.result as {
    revision: string;
    dependencyRevisions: Record<string, string>;
    tilesets: Array<{ assetId: string }>;
  };
}

async function harness(
  mapOverride?: JsonObject,
): Promise<{
  project: TestProject;
  client: Client;
}> {
  const project = await createProject({
    prefix: "tiledmcp-preview-narrowed",
    files: {
      "tiles/decor.png": await solidPng(2, 1),
      [REFERENCE_PATH]: await rgbaPng(2, 2, [
        255, 0, 0, 255, 0, 255, 0, 255, 0, 255,
        0, 255, 255, 0, 0, 255,
      ]),
      [TILESET_PATH]: tileset(),
      [MAP_PATH]: mapOverride ?? targetMap(),
      [SOURCE_MAP_PATH]: sourceMap(),
      [BROKEN_MAP_PATH]: brokenMap(),
      [TEMPLATE_PATH]: {
        type: "template",
        object: {
          id: 0,
          name: "Crate",
          width: 12,
          height: 8,
          x: 0,
          y: 0,
        },
      },
    },
  });

  const missing = `${project.root}/does-not-exist`;
  const created = await createTiledMcpServer({
    resolver: project.resolver,
    store: project.store,
    maps: project.service,
    cli: new TiledCliAdapter({
      tiledCliPath: `${missing}-tiled`,
      rasterizerPath: `${missing}-tmxrasterizer`,
    }),
  });
  const client = new Client(
    {
      name: "preview-narrowed-test",
      version: "0.0.0",
    },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await created.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { project, client };
}

/** Two 16x16 tiles side by side, carrying a corner Wang set for terrain. */
function tileset(): JsonObject {
  return {
    columns: 2,
    image: "decor.png",
    imageheight: 16,
    imagewidth: 32,
    margin: 0,
    name: "Decor",
    spacing: 0,
    tilecount: 2,
    tiledversion: "1.12.2",
    tileheight: 16,
    tilewidth: 16,
    type: "tileset",
    version: "1.10",
    wangsets: [
      {
        name: "Ground",
        type: "corner",
        tile: -1,
        colors: [
          {
            color: "#00ff00",
            name: "Grass",
            probability: 1,
            tile: -1,
          },
        ],
        wangtiles: [
          {
            tileid: 0,
            wangid: [0, 1, 0, 1, 0, 1, 0, 1],
          },
          {
            tileid: 1,
            wangid: [0, 0, 0, 0, 0, 0, 0, 0],
          },
        ],
      },
    ],
  };
}

function baseMap(
  layers: JsonObject[],
  overrides: JsonObject = {},
): JsonObject {
  return {
    compressionlevel: -1,
    height: 8,
    infinite: false,
    layers,
    nextlayerid: 3,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [
      { firstgid: 1, source: "../tiles/decor.tsj" },
    ],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 8,
    ...overrides,
  };
}

function tileLayer(
  data: number[],
  overrides: JsonObject = {},
): JsonObject {
  return {
    data,
    height: 8,
    id: TILE_LAYER_ID,
    name: "ground",
    opacity: 1,
    type: "tilelayer",
    visible: true,
    width: 8,
    x: 0,
    y: 0,
    ...overrides,
  };
}

function objectLayer(
  objects: JsonObject[],
): JsonObject {
  return {
    draworder: "topdown",
    id: OBJECT_LAYER_ID,
    name: "things",
    objects,
    opacity: 1,
    type: "objectgroup",
    visible: true,
    x: 0,
    y: 0,
  };
}

/** Empty 8x8 tile layer plus an empty object layer. */
function targetMap(): JsonObject {
  return baseMap([
    tileLayer(new Array(64).fill(0)),
    objectLayer([]),
  ]);
}

/**
 * The merge and prefab source: a layer named like the target's so merge pairs
 * them, and one object carrying a scalar property so the prefab stamp emits
 * its updateObject follow-up.
 */
function sourceMap(): JsonObject {
  const data = new Array(64).fill(0);
  data[0] = 1;
  data[1] = 2;
  data[8] = 1;
  return baseMap(
    [
      tileLayer(data),
      objectLayer([
        {
          height: 8,
          id: 1,
          name: "crate",
          rotation: 0,
          type: "",
          visible: true,
          width: 8,
          x: 8,
          y: 8,
          properties: [
            { name: "hp", type: "int", value: 3 },
          ],
        },
      ]),
    ],
    { nextobjectid: 2 },
  );
}

/** A GID past the bound tileset's range, which is what validation fixes erase. */
function brokenMap(): JsonObject {
  const data = new Array(64).fill(0);
  data[0] = 99;
  data[5] = 99;
  return baseMap([tileLayer(data)], {
    nextlayerid: 2,
  });
}

/** Chunked layer on an infinite map -- the only source of chunkedTileLayerIds. */
function infiniteMap(): JsonObject {
  return baseMap(
    [
      {
        chunks: [
          {
            data: Array.from(
              { length: 256 },
              (_unused, index) =>
                index === 0 ? 1 : 0,
            ),
            height: 16,
            width: 16,
            x: 0,
            y: 0,
          },
        ],
        height: 16,
        id: TILE_LAYER_ID,
        name: "ground",
        opacity: 1,
        startx: 0,
        starty: 0,
        type: "tilelayer",
        visible: true,
        width: 16,
        x: 0,
        y: 0,
      },
      objectLayer([]),
    ],
    { height: 16, infinite: true, width: 16 },
  );
}

async function solidPng(
  width: number,
  height: number,
): Promise<Buffer> {
  return rgbaPng(
    width,
    height,
    Array.from(
      { length: width * height * 4 },
      (_unused, index) =>
        index % 4 === 3 ? 255 : 128,
    ),
  );
}

async function rgbaPng(
  width: number,
  height: number,
  rgba: number[],
): Promise<Buffer> {
  return sharp(
    Buffer.from(new Uint8Array(rgba)),
    { raw: { width, height, channels: 4 } },
  )
    .png()
    .toBuffer();
}
