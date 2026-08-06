import { execFile } from "node:child_process";
import { wireProject } from "./support/project.js";
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
} from "../src/maps/types.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
const TILE_LAYER_ID = 7;
const OBJECT_LAYER_ID = 11;
const IMAGE_LAYER_ID = 13;
const GROUP_LAYER_ID = 17;

type ResizeMapOperation = Extract<
  MapEditOperation,
  { type: "resizeMap" }
>;

interface Harness {
  root: string;
  service: MapService;
}

describe("resizeMap", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("grows the map, shifts old content, and pads new cells with empty tiles", async () => {
    const harness = await createHarness(roots);
    const operation: ResizeMapOperation = {
      type: "resizeMap",
      width: 4,
      height: 3,
      offsetX: 1,
      offsetY: 1,
    };

    const edit = await plan(harness.service, [operation]);
    expect(edit.summary).toMatchObject({
      operationCount: 1,
      cellWrites: 12,
      affectedLayerIds: [TILE_LAYER_ID],
      affectedTileLayerIds: [TILE_LAYER_ID],
      affectedObjectLayerIds: [],
      mapResizes: [
        {
          operationIndex: 0,
          oldWidth: 2,
          oldHeight: 1,
          newWidth: 4,
          newHeight: 3,
          offsetX: 1,
          offsetY: 1,
          pixelOffsetX: 16,
          pixelOffsetY: 16,
          wouldChange: true,
          mapDimensionsChanged: true,
          tileLayerCount: 1,
          resizedTileLayerIds: [TILE_LAYER_ID],
          scannedCellCount: 2,
          rewrittenCellCount: 12,
          preservedNonEmptyCellCount: 1,
          croppedNonEmptyCellCount: 0,
          croppedCellSample: [],
          omittedCroppedCellCount: 0,
          objectLayerCount: 0,
          movedObjectCount: 0,
          objectsOutsideNewBounds: 0,
          imageLayerCount: 0,
          shiftedImageLayerIds: [],
          groupLayerCount: 0,
          lockedLayerCount: 0,
        },
      ],
    });

    const preview =
      new ChangeSetRegistry().put(edit).operations[0];
    expect(preview).toMatchObject({
      type: "resizeMap",
      destructive: true,
      warning: expect.stringContaining(
        "without dropping",
      ),
      oldBounds: { width: 2, height: 1 },
      newBounds: { width: 4, height: 3 },
      offset: { x: 1, y: 1 },
      pixelOffset: { x: 16, y: 16 },
      wouldChange: true,
      croppedNonEmptyCellCount: 0,
    });

    const result = await harness.service.applyEdits(edit);
    expect(result.changed).toBe(true);
    const written = await readMap(harness.root);
    expect(written.width).toBe(4);
    expect(written.height).toBe(3);
    expect(written.nextlayerid).toBe(20);
    expect(written.nextobjectid).toBe(9);
    expect(written.vendorRootExtension).toEqual({
      preserve: ["root", 23],
    });
    const layer = requireLayer(written, TILE_LAYER_ID);
    expect(layer.width).toBe(4);
    expect(layer.height).toBe(3);
    expect(layer.x).toBe(0);
    expect(layer.y).toBe(0);
    expect(layer.vendorLayerExtension).toEqual({
      preserve: ["tile-layer", 17],
    });
    expect(layer.data).toEqual([
      0, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0, 0,
    ]);
    const validation = await harness.service.validate(
      MAP_PATH,
    );
    expect(validation).toMatchObject({ valid: true });
  });

  it("crops non-empty cells fail-safe and reports a bounded sample", async () => {
    const harness = await createHarness(roots, (map) => {
      map.width = 4;
      const layer = requireLayer(map, TILE_LAYER_ID);
      layer.width = 4;
      layer.data = [1, 2, 0, 4];
    });
    const edit = await plan(harness.service, [
      { type: "resizeMap", width: 2, height: 1 },
    ]);
    expect(edit.summary.mapResizes?.[0]).toMatchObject({
      oldWidth: 4,
      newWidth: 2,
      offsetX: 0,
      offsetY: 0,
      pixelOffsetX: 0,
      pixelOffsetY: 0,
      preservedNonEmptyCellCount: 2,
      croppedNonEmptyCellCount: 1,
      croppedCellSample: [
        { layerId: TILE_LAYER_ID, x: 3, y: 0, gid: 4 },
      ],
      omittedCroppedCellCount: 0,
    });
    const preview =
      new ChangeSetRegistry().put(edit).operations[0];
    expect(preview).toMatchObject({
      type: "resizeMap",
      destructive: true,
      warning: expect.stringContaining(
        "permanently drops 1 non-empty tile cell",
      ),
    });

    const tampered = structuredClone(edit);
    const tamperedSummary =
      tampered.summary.mapResizes?.[0];
    if (tamperedSummary === undefined) {
      throw new Error("Expected a resizeMap summary.");
    }
    tamperedSummary.croppedNonEmptyCellCount = 0;
    expect(() =>
      new ChangeSetRegistry().put(tampered),
    ).toThrow(/resizeMap/u);

    await harness.service.applyEdits(edit);
    const written = await readMap(harness.root);
    expect(written.width).toBe(2);
    expect(
      requireLayer(written, TILE_LAYER_ID).data,
    ).toEqual([1, 2]);
  });

  it("keeps the root dimensions byte-untouched for an offset-only shift", async () => {
    const harness = await createHarness(roots);
    const before = await readFile(
      join(harness.root, MAP_PATH),
      "utf8",
    );
    const edit = await plan(harness.service, [
      { type: "resizeMap", width: 2, height: 1, offsetX: 1 },
    ]);
    expect(edit.summary.mapResizes?.[0]).toMatchObject({
      mapDimensionsChanged: false,
      wouldChange: true,
      croppedNonEmptyCellCount: 0,
      preservedNonEmptyCellCount: 1,
    });
    await harness.service.applyEdits(edit);
    const after = await readFile(
      join(harness.root, MAP_PATH),
      "utf8",
    );
    expect(after).not.toEqual(before);
    const written = await readMap(harness.root);
    expect(written.width).toBe(2);
    expect(written.height).toBe(1);
    expect(
      requireLayer(written, TILE_LAYER_ID).data,
    ).toEqual([0, 1]);
  });

  it("treats an identity resize as an exact-byte no-op", async () => {
    const harness = await createHarness(roots);
    const before = await readFile(
      join(harness.root, MAP_PATH),
    );
    const edit = await plan(harness.service, [
      { type: "resizeMap", width: 2, height: 1 },
    ]);
    expect(edit.summary.mapResizes?.[0]).toMatchObject({
      wouldChange: false,
      mapDimensionsChanged: false,
      scannedCellCount: 2,
      rewrittenCellCount: 2,
      preservedNonEmptyCellCount: 1,
      croppedNonEmptyCellCount: 0,
    });
    const result = await harness.service.applyEdits(edit);
    expect(result.changed).toBe(false);
    expect(
      await readFile(join(harness.root, MAP_PATH)),
    ).toEqual(before);
  });

  it("shifts objects by the pixel offset and preserves out-of-bounds objects", async () => {
    const harness = await createHarness(roots, (map) => {
      map.layers = [
        ...(map.layers as JsonObject[]),
        {
          draworder: "topdown",
          id: OBJECT_LAYER_ID,
          name: "Props",
          objects: [
            {
              height: 4,
              id: 1,
              name: "crate",
              rotation: 0,
              type: "",
              vendorObjectExtension: { keep: true },
              visible: true,
              width: 6,
              x: 10,
              y: 5.5,
            },
            {
              height: 0,
              id: 2,
              name: "path",
              polyline: [
                { x: 0, y: 0 },
                { x: 8, y: -4 },
              ],
              rotation: 0,
              type: "",
              visible: true,
              width: 0,
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
      ];
      map.nextobjectid = 3;
    });
    const edit = await plan(harness.service, [
      {
        type: "resizeMap",
        width: 1,
        height: 1,
        offsetX: -1,
      },
    ]);
    expect(edit.summary).toMatchObject({
      affectedObjectLayerIds: [OBJECT_LAYER_ID],
      mapResizes: [
        {
          pixelOffsetX: -16,
          pixelOffsetY: 0,
          movedObjectCount: 2,
          objectLayerCount: 1,
          objectsOutsideNewBounds: 2,
          croppedNonEmptyCellCount: 1,
        },
      ],
    });
    await harness.service.applyEdits(edit);
    const written = await readMap(harness.root);
    const objectLayer = requireLayer(
      written,
      OBJECT_LAYER_ID,
    );
    const objects = objectLayer.objects as JsonObject[];
    expect(objects[0]).toMatchObject({
      id: 1,
      x: -6,
      y: 5.5,
      vendorObjectExtension: { keep: true },
    });
    expect(objects[1]).toMatchObject({
      id: 2,
      x: -16,
      y: 0,
      polyline: [
        { x: 0, y: 0 },
        { x: 8, y: -4 },
      ],
    });
    expect(written.nextobjectid).toBe(3);
  });

  it("counts boundary anchors as inside the closed pixel bounds", async () => {
    const harness = await createHarness(roots, (map) => {
      map.layers = [
        ...(map.layers as JsonObject[]),
        {
          draworder: "topdown",
          id: OBJECT_LAYER_ID,
          name: "Props",
          objects: [
            {
              height: 0,
              id: 1,
              name: "corner",
              point: true,
              rotation: 0,
              type: "",
              visible: true,
              width: 0,
              x: 16,
              y: 16,
            },
          ],
          opacity: 1,
          type: "objectgroup",
          visible: true,
          x: 0,
          y: 0,
        },
      ];
      map.nextobjectid = 2;
    });
    const edit = await plan(harness.service, [
      { type: "resizeMap", width: 1, height: 1 },
    ]);
    expect(
      edit.summary.mapResizes?.[0],
    ).toMatchObject({
      movedObjectCount: 0,
      objectsOutsideNewBounds: 0,
      wouldChange: true,
    });
  });

  it("shifts only changed image-layer offset members and leaves groups untouched", async () => {
    const harness = await createHarness(roots, (map) => {
      map.layers = [
        ...(map.layers as JsonObject[]),
        {
          id: GROUP_LAYER_ID,
          layers: [
            {
              id: IMAGE_LAYER_ID,
              image: "../tiles/terrain.svg",
              locked: true,
              name: "Backdrop",
              offsetx: 4.5,
              opacity: 1,
              type: "imagelayer",
              visible: true,
              x: 0,
              y: 0,
            },
          ],
          name: "Wrapper",
          offsetx: 3,
          opacity: 1,
          type: "group",
          visible: true,
          x: 0,
          y: 0,
        },
      ];
    });
    const edit = await plan(harness.service, [
      {
        type: "resizeMap",
        width: 3,
        height: 1,
        offsetX: 1,
      },
    ]);
    expect(edit.summary.mapResizes?.[0]).toMatchObject({
      imageLayerCount: 1,
      shiftedImageLayerIds: [IMAGE_LAYER_ID],
      groupLayerCount: 1,
      lockedLayerCount: 1,
      pixelOffsetX: 16,
      pixelOffsetY: 0,
    });
    await harness.service.applyEdits(edit);
    const written = await readMap(harness.root);
    const group = requireLayer(written, GROUP_LAYER_ID);
    expect(group.offsetx).toBe(3);
    const image = (
      group.layers as JsonObject[]
    ).find((layer) => layer.id === IMAGE_LAYER_ID);
    expect(image).toMatchObject({
      offsetx: 20.5,
      locked: true,
    });
    expect(image).not.toHaveProperty("offsety");
  });

  it("fails closed on tile layers whose bounds differ from the map", async () => {
    const harness = await createHarness(roots, (map) => {
      const layer = requireLayer(map, TILE_LAYER_ID);
      layer.width = 1;
      layer.data = [1];
    });
    await expect(
      plan(harness.service, [
        { type: "resizeMap", width: 3, height: 1 },
      ]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_RESIZE_LAYER_BOUNDS",
    });

    const shifted = await createHarness(roots, (map) => {
      const layer = requireLayer(map, TILE_LAYER_ID);
      layer.x = 1;
      layer.width = 1;
      layer.data = [1];
    });
    await expect(
      plan(shifted.service, [
        { type: "resizeMap", width: 3, height: 1 },
      ]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_RESIZE_LAYER_BOUNDS",
    });
  });

  it("fails closed on template objects only when the resize would move them", async () => {
    const build = (map: JsonObject): void => {
      map.layers = [
        ...(map.layers as JsonObject[]),
        {
          draworder: "topdown",
          id: OBJECT_LAYER_ID,
          name: "Props",
          objects: [
            {
              id: 1,
              template: "../templates/crate.tj",
              x: 4,
              y: 4,
            },
          ],
          opacity: 1,
          type: "objectgroup",
          visible: true,
          x: 0,
          y: 0,
        },
      ];
      map.nextobjectid = 2;
    };
    const moving = await createHarness(roots, build);
    await expect(
      plan(moving.service, [
        {
          type: "resizeMap",
          width: 3,
          height: 1,
          offsetX: 1,
        },
      ]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_RESIZE_TEMPLATE",
    });

    const growing = await createHarness(roots, build);
    const edit = await plan(growing.service, [
      { type: "resizeMap", width: 3, height: 1 },
    ]);
    expect(edit.summary.mapResizes?.[0]).toMatchObject({
      movedObjectCount: 0,
    });
  });

  it("fails closed on malformed or unbound GIDs even when the cell would be cropped", async () => {
    const unbound = await createHarness(roots, (map) => {
      const layer = requireLayer(map, TILE_LAYER_ID);
      layer.data = [1, 9];
    });
    await expect(
      plan(unbound.service, [
        { type: "resizeMap", width: 1, height: 1 },
      ]),
    ).rejects.toMatchObject({
      code: "GID_OUT_OF_RANGE",
    });

    const malformed = await createHarness(
      roots,
      (map) => {
        const layer = requireLayer(map, TILE_LAYER_ID);
        layer.data = [1, 2.5];
      },
    );
    await expect(
      plan(malformed.service, [
        { type: "resizeMap", width: 1, height: 1 },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_TILE_DATA",
    });
  });

  it("must be the only operation in its change set", async () => {
    const harness = await createHarness(roots);
    await expect(
      plan(harness.service, [
        { type: "resizeMap", width: 3, height: 1 },
        {
          type: "updateMap",
          patch: { className: "Combined" },
        },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining(
        "resizeMap must be the only operation",
      ),
    });
  });

  it("validates dimensions, offsets, and unknown keys", async () => {
    const harness = await createHarness(roots);
    const invalidOperations: unknown[] = [
      { type: "resizeMap", width: 0, height: 1 },
      { type: "resizeMap", width: 2, height: 1.5 },
      { type: "resizeMap", width: 2 },
      {
        type: "resizeMap",
        width: 2,
        height: 1,
        offsetX: 100_001,
      },
      {
        type: "resizeMap",
        width: 2,
        height: 1,
        offsetX: 0.5,
      },
      {
        type: "resizeMap",
        width: 2,
        height: 1,
        anchor: "center",
      },
    ];
    for (const operation of invalidOperations) {
      await expect(
        plan(harness.service, [
          operation as MapEditOperation,
        ]),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
  });

  it("rejects resizes that exceed the cell-write budget", async () => {
    const harness = await createHarness(roots);
    await expect(
      plan(harness.service, [
        {
          type: "resizeMap",
          width: 100_000,
          height: 2,
        },
      ]),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: expect.objectContaining({
        limit: 100_000,
      }),
    });
  });

  it("rejects resizes that exceed the patched-subtree budget", async () => {
    const harness = await createHarness(roots, (map) => {
      const layers: JsonObject[] = [];
      for (let index = 0; index < 64; index += 1) {
        layers.push({
          data: [0, 0],
          height: 1,
          id: 100 + index,
          name: `L${index}`,
          opacity: 1,
          type: "tilelayer",
          visible: true,
          width: 2,
          x: 0,
          y: 0,
        });
      }
      map.layers = layers;
      map.nextlayerid = 200;
    });
    await expect(
      plan(harness.service, [
        { type: "resizeMap", width: 3, height: 1 },
      ]),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: expect.objectContaining({ limit: 128 }),
    });
  });

  it("revalidates revisions and summaries at apply time", async () => {
    const harness = await createHarness(roots);
    const edit = await plan(harness.service, [
      { type: "resizeMap", width: 3, height: 2 },
    ]);

    const tampered = structuredClone(edit);
    const tamperedSummary =
      tampered.summary.mapResizes?.[0];
    if (tamperedSummary === undefined) {
      throw new Error("Expected a resizeMap summary.");
    }
    tamperedSummary.croppedNonEmptyCellCount = 5;
    tamperedSummary.omittedCroppedCellCount = 5;
    await expect(
      harness.service.applyEdits(tampered),
    ).rejects.toMatchObject({
      code: "CHANGE_SET_TAMPERED",
    });

    const conflicting = await plan(harness.service, [
      { type: "resizeMap", width: 3, height: 2 },
    ]);
    await harness.service.applyEdits(edit);
    await expect(
      harness.service.applyEdits(conflicting),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
  });

  it("survives a real Tiled 1.12 JSON export round-trip when the CLI is available", async () => {
    const harness = await createHarness(roots, (map) => {
      map.layers = [
        ...(map.layers as JsonObject[]),
        {
          draworder: "topdown",
          id: OBJECT_LAYER_ID,
          name: "Props",
          objects: [
            {
              height: 4,
              id: 1,
              name: "crate",
              rotation: 0,
              type: "",
              visible: true,
              width: 6,
              x: 10,
              y: 5,
            },
          ],
          opacity: 1,
          type: "objectgroup",
          visible: true,
          x: 0,
          y: 0,
        },
      ];
      map.nextobjectid = 2;
    });
    const edit = await plan(harness.service, [
      {
        type: "resizeMap",
        width: 4,
        height: 2,
        offsetX: 1,
      },
    ]);
    await harness.service.applyEdits(edit);

    const exported = join(
      harness.root,
      "maps",
      "exported.tmj",
    );
    try {
      await execFileAsync(
        process.env.TILED_CLI_PATH ?? "tiled",
        [
          "--export-map",
          "json",
          join(harness.root, MAP_PATH),
          exported,
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
      if (
        (error as NodeJS.ErrnoException).code ===
        "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    const roundTripped = JSON.parse(
      await readFile(exported, "utf8"),
    ) as JsonObject;
    expect(roundTripped.width).toBe(4);
    expect(roundTripped.height).toBe(2);
    const layer = (
      roundTripped.layers as JsonObject[]
    ).find((entry) => entry.type === "tilelayer");
    expect(layer).toMatchObject({
      width: 4,
      height: 2,
      data: [0, 1, 0, 0, 0, 0, 0, 0],
    });
    const objectLayer = (
      roundTripped.layers as JsonObject[]
    ).find((entry) => entry.type === "objectgroup");
    expect(
      (objectLayer?.objects as JsonObject[])[0],
    ).toMatchObject({ x: 26, y: 5 });
  }, 40_000);
});

async function createHarness(
  roots: Set<string>,
  mutate?: (map: JsonObject) => void,
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-resize-map-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  const map = baseMap();
  mutate?.(map);
  await writeJson(join(root, MAP_PATH), map);
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

  const { service } =
    await wireProject(root);
  return {
    root,
    service: service,
  };
}

function baseMap(): JsonObject {
  return {
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
    nextlayerid: 20,
    nextobjectid: 9,
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
): Promise<MapEditPlan> {
  const summary = await service.getSummary(MAP_PATH);
  return service.planEdits(
    MAP_PATH,
    summary.revision as string,
    summary.dependencyRevisions as Record<
      string,
      string
    >,
    operations,
  );
}

function requireLayer(
  map: JsonObject,
  layerId: number,
): JsonObject {
  const find = (
    layers: JsonObject[],
  ): JsonObject | undefined => {
    for (const layer of layers) {
      if (layer.id === layerId) {
        return layer;
      }
      if (Array.isArray(layer.layers)) {
        const nested = find(
          layer.layers as JsonObject[],
        );
        if (nested !== undefined) {
          return nested;
        }
      }
    }
    return undefined;
  };
  const layer = find(map.layers as JsonObject[]);
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
    ).replace(/^﻿/u, ""),
  ) as JsonObject;
}

async function writeJson(
  path: string,
  document: JsonObject,
): Promise<void> {
  await writeFile(path, serializeJsonDocument(document));
}
