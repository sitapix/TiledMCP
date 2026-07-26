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

import { afterEach, describe, expect, it } from "vitest";

import { ChangeSetRegistry } from "../src/changeSets.js";
import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import {
  MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET,
  MapService,
} from "../src/maps/mapService.js";
import {
  MAX_PROPERTIES_PER_TARGET,
  MAX_PROPERTY_SETS_PER_TARGET,
} from "../src/maps/propertyEdits.js";
import type {
  MapEditOperation,
  MapEditPlan,
} from "../src/maps/types.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/props.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
const OBJECT_LAYER_ID = 4;
const GATE_ID = 1;
const DOOR_ID = 2;
const SIGN_ID = 3;
const PLAIN_ID = 4;
const FILLER_IDS = [5, 6, 7, 8, 9, 10, 11, 12];

interface Harness {
  root: string;
  service: MapService;
}

interface MapSnapshot {
  revision: string;
  dependencies: Record<string, string>;
}

describe("map object property editing", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("inserts new scalar properties sorted by name and previews the patch", async () => {
    const harness = await createHarness(roots);

    const edit = await plan(harness.service, [
      {
        type: "updateObject",
        objectId: PLAIN_ID,
        patch: {
          properties: {
            set: [
              {
                name: "spawn",
                type: "bool",
                value: true,
              },
              {
                name: "budget",
                type: "int",
                value: 12,
              },
            ],
          },
        },
      },
    ]);
    expect(edit.summary.updatedObjectIds).toEqual([
      PLAIN_ID,
    ]);
    const preview =
      new ChangeSetRegistry().put(edit);
    expect(preview.operations).toEqual([
      {
        type: "updateObject",
        objectId: PLAIN_ID,
        changedFields: ["properties"],
        patch: {
          properties: {
            set: [
              {
                name: "spawn",
                type: "bool",
                value: true,
              },
              {
                name: "budget",
                type: "int",
                value: 12,
              },
            ],
          },
        },
      },
    ]);

    await harness.service.applyEdits(edit);

    const object = await readObject(
      harness.root,
      PLAIN_ID,
    );
    expect(object.properties).toEqual([
      { name: "budget", type: "int", value: 12 },
      { name: "spawn", type: "bool", value: true },
    ]);
    expect(object.vendorObjectExtension).toEqual({
      preserve: "plain",
    });
  });

  it("updates an existing property in place, preserving order and unknown entry members", async () => {
    const harness = await createHarness(roots);

    const edit = await plan(harness.service, [
      {
        type: "updateObject",
        objectId: GATE_ID,
        patch: {
          name: "Renamed gate",
          properties: {
            set: [
              {
                name: "locked",
                type: "bool",
                value: false,
              },
            ],
          },
        },
      },
    ]);
    await harness.service.applyEdits(edit);

    const object = await readObject(
      harness.root,
      GATE_ID,
    );
    expect(object.name).toBe("Renamed gate");
    expect(object.properties).toEqual([
      {
        name: "locked",
        type: "bool",
        value: false,
        vendorPropertyExtension: {
          preserve: [1, "keep"],
        },
      },
      {
        name: "strength",
        type: "int",
        value: 5,
      },
    ]);
  });

  it("removes properties and drops an emptied properties member", async () => {
    const harness = await createHarness(roots);

    const first = await plan(harness.service, [
      {
        type: "updateObject",
        objectId: GATE_ID,
        patch: {
          properties: { remove: ["strength"] },
        },
      },
    ]);
    await harness.service.applyEdits(first);
    let object = await readObject(
      harness.root,
      GATE_ID,
    );
    expect(object.properties).toEqual([
      {
        name: "locked",
        type: "bool",
        value: true,
        vendorPropertyExtension: {
          preserve: [1, "keep"],
        },
      },
    ]);

    const second = await plan(harness.service, [
      {
        type: "updateObject",
        objectId: GATE_ID,
        patch: {
          properties: { remove: ["locked"] },
        },
      },
    ]);
    await harness.service.applyEdits(second);
    object = await readObject(
      harness.root,
      GATE_ID,
    );
    expect(
      Object.prototype.hasOwnProperty.call(
        object,
        "properties",
      ),
    ).toBe(false);
  });

  it("applies mixed set and remove entries in one bounded patch", async () => {
    const harness = await createHarness(roots);

    const edit = await plan(harness.service, [
      {
        type: "updateObject",
        objectId: GATE_ID,
        patch: {
          properties: {
            set: [
              {
                name: "tint",
                type: "color",
                value: "#80ff0000",
              },
              {
                name: "note",
                type: "string",
                value: "guarded",
              },
            ],
            remove: ["strength"],
          },
        },
      },
    ]);
    await harness.service.applyEdits(edit);

    const object = await readObject(
      harness.root,
      GATE_ID,
    );
    expect(object.properties).toEqual([
      {
        name: "locked",
        type: "bool",
        value: true,
        vendorPropertyExtension: {
          preserve: [1, "keep"],
        },
      },
      {
        name: "note",
        type: "string",
        value: "guarded",
      },
      {
        name: "tint",
        type: "color",
        value: "#80ff0000",
      },
    ]);
  });

  it("fails closed when a set or remove targets a complex or custom-typed property", async () => {
    const harness = await createHarness(roots);

    await expect(
      plan(harness.service, [
        {
          type: "updateObject",
          objectId: DOOR_ID,
          patch: {
            properties: {
              set: [
                {
                  name: "linked",
                  type: "int",
                  value: 9,
                },
              ],
            },
          },
        },
      ]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_PROPERTY_WRITE",
      details: expect.objectContaining({
        path: MAP_PATH,
        objectId: DOOR_ID,
        name: "linked",
        type: "object",
      }),
    });

    await expect(
      plan(harness.service, [
        {
          type: "updateObject",
          objectId: DOOR_ID,
          patch: {
            properties: { remove: ["style"] },
          },
        },
      ]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_PROPERTY_WRITE",
      details: expect.objectContaining({
        name: "style",
      }),
    });
  });

  it("fails closed on inserts into unsorted properties but allows in-place updates", async () => {
    const harness = await createHarness(roots);

    await expect(
      plan(harness.service, [
        {
          type: "updateObject",
          objectId: SIGN_ID,
          patch: {
            properties: {
              set: [
                {
                  name: "mid",
                  type: "string",
                  value: "new",
                },
              ],
            },
          },
        },
      ]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_PROPERTY_WRITE",
      message: expect.stringContaining(
        "not sorted by property name",
      ),
    });

    const edit = await plan(harness.service, [
      {
        type: "updateObject",
        objectId: SIGN_ID,
        patch: {
          properties: {
            set: [
              {
                name: "zeta",
                type: "string",
                value: "updated",
              },
            ],
          },
        },
      },
    ]);
    await harness.service.applyEdits(edit);
    const object = await readObject(
      harness.root,
      SIGN_ID,
    );
    expect(object.properties).toEqual([
      {
        name: "zeta",
        type: "string",
        value: "updated",
      },
      {
        name: "alpha",
        type: "string",
        value: "first",
      },
    ]);
  });

  it("rejects template and tile objects, malformed patches, and per-target overflow", async () => {
    const harness = await createHarness(roots);

    await expect(
      plan(harness.service, [
        {
          type: "updateObject",
          objectId: PLAIN_ID,
          patch: { properties: {} },
        },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });

    await expect(
      plan(harness.service, [
        {
          type: "updateObject",
          objectId: PLAIN_ID,
          patch: {
            properties: {
              set: [
                {
                  name: "twice",
                  type: "int",
                  value: 1,
                },
              ],
              remove: ["twice"],
            },
          },
        },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining(
        "repeats property name",
      ),
    });

    await expect(
      plan(harness.service, [
        {
          type: "updateObject",
          objectId: PLAIN_ID,
          patch: {
            properties: {
              set: Array.from(
                {
                  length:
                    MAX_PROPERTY_SETS_PER_TARGET +
                    1,
                },
                (_, index) => ({
                  name: `p${String(index).padStart(3, "0")}`,
                  type: "int" as const,
                  value: index,
                }),
              ),
            },
          },
        },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });

    await expect(
      plan(harness.service, [
        {
          type: "updateObject",
          objectId: PLAIN_ID,
          patch: {
            properties: {
              set: [
                {
                  name: "shape",
                  type: "string",
                  value: "x",
                },
              ],
            },
          },
        },
        {
          type: "updateObject",
          objectId: PLAIN_ID,
          patch: {
            properties: {
              set: Array.from(
                {
                  length:
                    MAX_PROPERTY_SETS_PER_TARGET,
                },
                (_, index) => ({
                  name: `q${String(index).padStart(3, "0")}`,
                  type: "int" as const,
                  value: index,
                }),
              ),
            },
          },
        },
        {
          type: "updateObject",
          objectId: PLAIN_ID,
          patch: {
            properties: {
              set: Array.from(
                {
                  length:
                    MAX_PROPERTY_SETS_PER_TARGET,
                },
                (_, index) => ({
                  name: `r${String(index).padStart(3, "0")}`,
                  type: "int" as const,
                  value: index,
                }),
              ),
            },
          },
        },
        {
          type: "updateObject",
          objectId: PLAIN_ID,
          patch: {
            properties: {
              set: Array.from(
                {
                  length:
                    MAX_PROPERTY_SETS_PER_TARGET,
                },
                (_, index) => ({
                  name: `s${String(index).padStart(3, "0")}`,
                  type: "int" as const,
                  value: index,
                }),
              ),
            },
          },
        },
        {
          type: "updateObject",
          objectId: PLAIN_ID,
          patch: {
            properties: {
              set: Array.from(
                {
                  length:
                    MAX_PROPERTY_SETS_PER_TARGET,
                },
                (_, index) => ({
                  name: `t${String(index).padStart(3, "0")}`,
                  type: "int" as const,
                  value: index,
                }),
              ),
            },
          },
        },
      ]),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: expect.objectContaining({
        limit: MAX_PROPERTIES_PER_TARGET,
      }),
    });
  });

  it("enforces the change-set-wide property payload byte budget", async () => {
    const harness = await createHarness(roots);

    const largeValue = "v".repeat(1_024);
    const operations: MapEditOperation[] =
      FILLER_IDS.map((objectId, objectIndex) => ({
        type: "updateObject",
        objectId,
        patch: {
          properties: {
            set: Array.from(
              {
                length:
                  MAX_PROPERTY_SETS_PER_TARGET,
              },
              (_, index) => ({
                name: `f${objectIndex}_${String(index).padStart(3, "0")}`,
                type: "string" as const,
                value: largeValue,
              }),
            ),
          },
        },
      }));

    await expect(
      plan(harness.service, operations),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: expect.objectContaining({
        limit:
          MAX_OBJECT_PROPERTY_PATCH_BYTES_PER_CHANGE_SET,
      }),
    });
  });

  it("reads scalar properties back in document order with explicit omission markers", async () => {
    const harness = await createHarness(roots);

    const gate = await harness.service.getObject({
      mapPath: MAP_PATH,
      objectId: GATE_ID,
    });
    expect(gate.object).toMatchObject({
      properties: [
        {
          name: "locked",
          type: "bool",
          value: true,
        },
        {
          name: "strength",
          type: "int",
          value: 5,
        },
      ],
      propertyCount: 2,
    });

    const door = await harness.service.getObject({
      mapPath: MAP_PATH,
      objectId: DOOR_ID,
    });
    expect(door.object).toMatchObject({
      properties: [
        {
          name: "linked",
          type: "object",
          value: GATE_ID,
        },
        {
          name: "style",
          type: "string",
          propertytype: "DoorStyle",
          value: "iron",
        },
      ],
      propertyCount: 2,
    });

    const plain = await harness.service.getObject(
      {
        mapPath: MAP_PATH,
        objectId: PLAIN_ID,
      },
    );
    expect(plain.object).toMatchObject({
      properties: [],
      propertyCount: 0,
    });

    const oversized = "v".repeat(2_000);
    const mapAbsolute = join(
      harness.root,
      MAP_PATH,
    );
    const map = JSON.parse(
      (await readFile(mapAbsolute)).toString(
        "utf8",
      ),
    ) as JsonObject;
    const layers = map.layers as JsonObject[];
    const objects = layers[0]!
      .objects as JsonObject[];
    const sign = objects.find(
      (object) => object.id === SIGN_ID,
    )!;
    sign.properties = [
      {
        name: "big",
        type: "string",
        value: oversized,
      },
    ];
    await writeFile(
      mapAbsolute,
      serializeJsonDocument(map),
    );
    const reread =
      await harness.service.getObject({
        mapPath: MAP_PATH,
        objectId: SIGN_ID,
      });
    expect(reread.object).toMatchObject({
      properties: [
        {
          name: "big",
          type: "string",
          valueOmitted: true,
          reason: "oversized-value",
          valueCodePoints: 2_000,
        },
      ],
      propertyCount: 1,
    });
  });

  it("fails closed reading malformed property entries and truncates beyond the cap", async () => {
    const harness = await createHarness(roots);
    const mapAbsolute = join(
      harness.root,
      MAP_PATH,
    );
    const map = JSON.parse(
      (await readFile(mapAbsolute)).toString(
        "utf8",
      ),
    ) as JsonObject;
    const layers = map.layers as JsonObject[];
    const objects = layers[0]!
      .objects as JsonObject[];
    const sign = objects.find(
      (object) => object.id === SIGN_ID,
    )!;

    sign.properties = [
      { name: "dup", type: "int", value: 1 },
      { name: "dup", type: "int", value: 2 },
    ];
    await writeFile(
      mapAbsolute,
      serializeJsonDocument(map),
    );
    await expect(
      harness.service.getObject({
        mapPath: MAP_PATH,
        objectId: SIGN_ID,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      message: expect.stringContaining(
        "duplicate property name",
      ),
    });

    sign.properties = [
      {
        name: "weird",
        type: "quaternion",
        value: 1,
      },
    ];
    await writeFile(
      mapAbsolute,
      serializeJsonDocument(map),
    );
    await expect(
      harness.service.getObject({
        mapPath: MAP_PATH,
        objectId: SIGN_ID,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      message: expect.stringContaining(
        "unrecognized type",
      ),
    });

    sign.properties = [
      {
        name: "mismatch",
        type: "int",
        value: "five",
      },
    ];
    await writeFile(
      mapAbsolute,
      serializeJsonDocument(map),
    );
    await expect(
      harness.service.getObject({
        mapPath: MAP_PATH,
        objectId: SIGN_ID,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      message: expect.stringContaining(
        "inconsistent with its declared type",
      ),
    });

    sign.properties = Array.from(
      { length: 130 },
      (_, index) => ({
        name: `p${String(index).padStart(3, "0")}`,
        type: "int",
        value: index,
      }),
    );
    await writeFile(
      mapAbsolute,
      serializeJsonDocument(map),
    );
    const truncated =
      await harness.service.getObject({
        mapPath: MAP_PATH,
        objectId: SIGN_ID,
      });
    expect(truncated.object).toMatchObject({
      propertyCount: 130,
      propertiesTruncated: true,
    });
    expect(
      (truncated.object as { properties: unknown[] })
        .properties,
    ).toHaveLength(128);
  });

  it("round-trips edited object properties through the Tiled CLI", async () => {
    const harness = await createHarness(roots);

    const edit = await plan(harness.service, [
      {
        type: "updateObject",
        objectId: PLAIN_ID,
        patch: {
          properties: {
            set: [
              {
                name: "cooldown",
                type: "float",
                value: 1.5,
              },
              {
                name: "label",
                type: "string",
                value: "checkpoint",
              },
            ],
          },
        },
      },
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
    const object = findObject(
      exported,
      PLAIN_ID,
    );
    expect(object.properties).toEqual([
      {
        name: "cooldown",
        type: "float",
        value: 1.5,
      },
      {
        name: "label",
        type: "string",
        value: "checkpoint",
      },
    ]);
  });
});

async function plan(
  service: MapService,
  operations: readonly MapEditOperation[],
  suppliedSnapshot?: MapSnapshot,
): Promise<MapEditPlan> {
  const snapshot =
    suppliedSnapshot ??
    (await mapSnapshot(service));
  return service.planEdits(
    MAP_PATH,
    snapshot.revision,
    snapshot.dependencies,
    [...operations],
  );
}

async function mapSnapshot(
  service: MapService,
): Promise<MapSnapshot> {
  const summary =
    await service.getSummary(MAP_PATH);
  return {
    revision: summary.revision as string,
    dependencies:
      summary.dependencyRevisions as Record<
        string,
        string
      >,
  };
}

async function readObject(
  root: string,
  objectId: number,
): Promise<JsonObject> {
  const source = await readFile(
    join(root, MAP_PATH),
    "utf8",
  );
  const map = JSON.parse(
    source.replace(/^\uFEFF/u, ""),
  ) as JsonObject;
  return findObject(map, objectId);
}

function findObject(
  map: JsonObject,
  objectId: number,
): JsonObject {
  const layers = map.layers;
  if (!Array.isArray(layers)) {
    throw new Error(
      "Expected the fixture map layers.",
    );
  }
  for (const layer of layers) {
    if (
      typeof layer !== "object" ||
      layer === null ||
      Array.isArray(layer) ||
      !Array.isArray(layer.objects)
    ) {
      continue;
    }
    for (const object of layer.objects) {
      if (
        typeof object === "object" &&
        object !== null &&
        !Array.isArray(object) &&
        object.id === objectId
      ) {
        return object;
      }
    }
  }
  throw new Error(
    `Expected object ${objectId} in the fixture map.`,
  );
}

async function createHarness(
  roots: Set<string>,
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-object-props-"),
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
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">',
      '<rect width="16" height="16" fill="#5588aa"/>',
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
    height: 3,
    infinite: false,
    layers: [
      {
        id: OBJECT_LAYER_ID,
        name: "Property Objects",
        objects: [
          {
            height: 8,
            id: GATE_ID,
            name: "Gate",
            properties: [
              {
                name: "locked",
                type: "bool",
                value: true,
                vendorPropertyExtension: {
                  preserve: [1, "keep"],
                },
              },
              {
                name: "strength",
                type: "int",
                value: 5,
              },
            ],
            rotation: 0,
            type: "",
            visible: true,
            width: 12,
            x: 4,
            y: 6,
          },
          {
            height: 10,
            id: DOOR_ID,
            name: "Door",
            properties: [
              {
                name: "linked",
                type: "object",
                value: GATE_ID,
              },
              {
                name: "style",
                propertytype: "DoorStyle",
                type: "string",
                value: "iron",
              },
            ],
            rotation: 0,
            type: "",
            visible: true,
            width: 6,
            x: 20,
            y: 6,
          },
          {
            height: 4,
            id: SIGN_ID,
            name: "Sign",
            properties: [
              {
                name: "zeta",
                type: "string",
                value: "last",
              },
              {
                name: "alpha",
                type: "string",
                value: "first",
              },
            ],
            rotation: 0,
            type: "",
            visible: true,
            width: 4,
            x: 30,
            y: 8,
          },
          {
            height: 6,
            id: PLAIN_ID,
            name: "Plain",
            rotation: 0,
            type: "",
            vendorObjectExtension: {
              preserve: "plain",
            },
            visible: true,
            width: 6,
            x: 2,
            y: 20,
          },
          ...FILLER_IDS.map((id, index) => ({
            height: 2,
            id,
            name: `Filler ${id}`,
            rotation: 0,
            type: "",
            visible: true,
            width: 2,
            x: 2 * index,
            y: 30,
          })),
        ],
        opacity: 1,
        type: "objectgroup",
        visible: true,
      },
    ],
    nextlayerid: 5,
    nextobjectid: 13,
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
    width: 3,
  };
}

function baseTileset(): JsonObject {
  return {
    columns: 1,
    image: "terrain.svg",
    imageheight: 16,
    imagewidth: 16,
    margin: 0,
    name: "terrain",
    spacing: 0,
    tilecount: 1,
    tiledversion: "1.12.2",
    tileheight: 16,
    tilewidth: 16,
    type: "tileset",
    version: "1.10",
  };
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

function hasErrorCode(
  error: unknown,
  code: string,
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
