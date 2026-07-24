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
} from "../src/maps/types.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/shapes.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
const OBJECT_LAYER_ID = 7;
const ELLIPSE_ID = 1;
const CAPSULE_ID = 2;

type ExtendedObjectShape = "ellipse" | "capsule";

interface Harness {
  root: string;
  service: MapService;
}

interface MapSnapshot {
  revision: string;
  dependencies: Record<string, string>;
}

describe("ellipse and capsule object editing", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("lists existing ellipse and capsule objects with their exact shapes", async () => {
    const harness = await createHarness(roots);

    const result = await harness.service.listObjects({
      mapPath: MAP_PATH,
    });

    expect(result).toMatchObject({
      mapPath: MAP_PATH,
      revision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
      dependencyRevisions: expect.any(Object),
      total: 2,
      truncated: false,
      objects: [
        {
          id: ELLIPSE_ID,
          layerId: OBJECT_LAYER_ID,
          layerName: "Shape Objects",
          name: "Portal",
          className: "Trigger",
          shape: "ellipse",
          x: 4,
          y: 6,
          width: 12,
          height: 8,
          rotation: 15,
          visible: true,
          opacity: 0.75,
        },
        {
          id: CAPSULE_ID,
          layerId: OBJECT_LAYER_ID,
          layerName: "Shape Objects",
          name: "Player body",
          className: "Collision",
          shape: "capsule",
          x: 24,
          y: 10,
          width: 10,
          height: 18,
          rotation: 0,
          visible: false,
          opacity: 1,
        },
      ],
    });
  });

  it("previews and applies canonical ellipse and capsule creation", async () => {
    const harness = await createHarness(roots);
    const mapPath = join(harness.root, MAP_PATH);
    const before = await readFile(mapPath);
    const operations = [
      createShape("ellipse", {
        x: 40.5,
        y: -3,
        width: 20,
        height: 14,
        name: "Area of effect",
        className: "DamageZone",
        rotation: -12.5,
        visible: false,
        opacity: 0.4,
      }),
      createShape("capsule", {
        x: 70,
        y: 9.25,
        width: 16,
        height: 32,
        name: "NPC body",
        className: "Collision",
      }),
    ];

    const edit = await plan(
      harness.service,
      operations,
    );

    expect(await readFile(mapPath)).toEqual(before);
    expect(edit.operations).toEqual(operations);
    expect(edit.summary).toMatchObject({
      operationCount: 2,
      cellWrites: 0,
      affectedLayerIds: [OBJECT_LAYER_ID],
      affectedTileLayerIds: [],
      affectedObjectLayerIds: [OBJECT_LAYER_ID],
      createdObjectIds: [3, 4],
      updatedObjectIds: [],
      deletedObjectIds: [],
    });

    const preview = new ChangeSetRegistry().put(edit);
    expect(preview.operations).toEqual([
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        shape: "ellipse",
        object: expect.objectContaining({
          shape: "ellipse",
          width: 20,
          height: 14,
        }),
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        shape: "capsule",
        object: expect.objectContaining({
          shape: "capsule",
          width: 16,
          height: 32,
        }),
      },
    ]);

    const result =
      await harness.service.applyEdits(edit);
    expect(result).toMatchObject({
      path: MAP_PATH,
      changed: true,
      beforeRevision: edit.baseRevision,
      revision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
      changeSetId: edit.id,
    });

    const saved = await readMap(harness.root);
    const objects = requireObjects(saved);
    expect(saved.nextobjectid).toBe(5);
    expect(objects[2]).toMatchObject({
      id: 3,
      ellipse: true,
      x: 40.5,
      y: -3,
      width: 20,
      height: 14,
      name: "Area of effect",
      type: "DamageZone",
      rotation: -12.5,
      visible: false,
      opacity: 0.4,
    });
    expect(objects[2]).not.toHaveProperty("capsule");
    expect(objects[2]).not.toHaveProperty("point");
    expect(objects[3]).toMatchObject({
      id: 4,
      capsule: true,
      x: 70,
      y: 9.25,
      width: 16,
      height: 32,
      name: "NPC body",
      type: "Collision",
      rotation: 0,
      visible: true,
    });
    expect(objects[3]).not.toHaveProperty("ellipse");
    expect(objects[3]).not.toHaveProperty("point");
  });

  it("updates common fields and positive dimensions without changing either shape", async () => {
    const harness = await createHarness(roots);
    const operations: MapEditOperation[] = [
      {
        type: "updateObject",
        objectId: ELLIPSE_ID,
        patch: {
          x: -8.5,
          y: 13,
          width: 24,
          height: 16,
          name: "Moved portal",
          className: "Teleporter",
          rotation: 45,
          visible: false,
          opacity: 0.25,
        },
      },
      {
        type: "updateObject",
        objectId: CAPSULE_ID,
        patch: {
          width: 12,
          height: 28,
          name: "Tall player body",
        },
      },
    ];

    const edit = await plan(
      harness.service,
      operations,
    );
    const preview = new ChangeSetRegistry().put(edit);

    expect(edit.summary).toMatchObject({
      affectedLayerIds: [OBJECT_LAYER_ID],
      affectedObjectLayerIds: [OBJECT_LAYER_ID],
      createdObjectIds: [],
      updatedObjectIds: [
        ELLIPSE_ID,
        CAPSULE_ID,
      ],
      deletedObjectIds: [],
    });
    expect(preview.operations).toEqual([
      {
        type: "updateObject",
        objectId: ELLIPSE_ID,
        changedFields: [
          "className",
          "height",
          "name",
          "opacity",
          "rotation",
          "visible",
          "width",
          "x",
          "y",
        ],
        patch: operations[0]?.type ===
          "updateObject"
          ? operations[0].patch
          : {},
      },
      {
        type: "updateObject",
        objectId: CAPSULE_ID,
        changedFields: [
          "height",
          "name",
          "width",
        ],
        patch: operations[1]?.type ===
          "updateObject"
          ? operations[1].patch
          : {},
      },
    ]);

    await harness.service.applyEdits(edit);
    const objects = requireObjects(
      await readMap(harness.root),
    );
    expect(objects[0]).toMatchObject({
      id: ELLIPSE_ID,
      ellipse: true,
      x: -8.5,
      y: 13,
      width: 24,
      height: 16,
      name: "Moved portal",
      type: "Teleporter",
      rotation: 45,
      visible: false,
      opacity: 0.25,
      vendorEllipseExtension: {
        preserve: ["ellipse", 17],
      },
    });
    expect(objects[0]).not.toHaveProperty("capsule");
    expect(objects[1]).toMatchObject({
      id: CAPSULE_ID,
      capsule: true,
      width: 12,
      height: 28,
      name: "Tall player body",
      vendorCapsuleExtension: {
        preserve: { future: true },
      },
    });
    expect(objects[1]).not.toHaveProperty("ellipse");
  });

  it("deletes ellipse and capsule objects and reports a destructive preview", async () => {
    const harness = await createHarness(roots);
    const operation: MapEditOperation = {
      type: "deleteObjects",
      objectIds: [ELLIPSE_ID, CAPSULE_ID],
    };
    const edit = await plan(harness.service, [
      operation,
    ]);

    expect(edit.summary).toMatchObject({
      affectedLayerIds: [OBJECT_LAYER_ID],
      affectedObjectLayerIds: [OBJECT_LAYER_ID],
      createdObjectIds: [],
      updatedObjectIds: [],
      deletedObjectIds: [
        ELLIPSE_ID,
        CAPSULE_ID,
      ],
    });
    expect(
      new ChangeSetRegistry().put(edit)
        .operations[0],
    ).toEqual({
      type: "deleteObjects",
      destructive: true,
      warning: expect.any(String),
      objectCount: 2,
      objectIdSample: [
        ELLIPSE_ID,
        CAPSULE_ID,
      ],
      omittedObjectCount: 0,
    });

    await harness.service.applyEdits(edit);
    const listed =
      await harness.service.listObjects({
        mapPath: MAP_PATH,
      });
    expect(listed).toMatchObject({
      total: 0,
      objects: [],
    });
    expect(
      requireObjects(
        await readMap(harness.root),
      ),
    ).toEqual([]);
  });

  it("accepts omitted and zero dimensions and serializes omitted values as zero", async () => {
    const harness = await createHarness(roots);
    const operations = [
      unsafeOperation({
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "ellipse",
          x: 0,
          y: 0,
          height: 8,
        },
      }),
      unsafeOperation({
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "capsule",
          x: 12,
          y: 0,
          width: 8,
        },
      }),
      createShape("ellipse", {
        x: 24,
        y: 0,
        width: 0,
        height: 0,
      }),
    ];

    const edit = await plan(
      harness.service,
      operations,
    );
    expect(
      new ChangeSetRegistry().put(edit)
        .operations,
    ).toEqual([
      expect.objectContaining({
        type: "createObject",
        shape: "ellipse",
        object: expect.not.objectContaining({
          width: expect.anything(),
        }),
      }),
      expect.objectContaining({
        type: "createObject",
        shape: "capsule",
        object: expect.not.objectContaining({
          height: expect.anything(),
        }),
      }),
      expect.objectContaining({
        type: "createObject",
        shape: "ellipse",
        object: expect.objectContaining({
          width: 0,
          height: 0,
        }),
      }),
    ]);

    await harness.service.applyEdits(edit);
    const objects = requireObjects(
      await readMap(harness.root),
    );
    expect(objects[2]).toMatchObject({
      id: 3,
      ellipse: true,
      width: 0,
      height: 8,
    });
    expect(objects[3]).toMatchObject({
      id: 4,
      capsule: true,
      width: 8,
      height: 0,
    });
    expect(objects[4]).toMatchObject({
      id: 5,
      ellipse: true,
      width: 0,
      height: 0,
    });
  });

  it.each([
    {
      label: "negative width",
      object: {
        shape: "ellipse",
        x: 0,
        y: 0,
        width: -1,
        height: 8,
      },
    },
    {
      label: "negative height",
      object: {
        shape: "capsule",
        x: 0,
        y: 0,
        width: 8,
        height: -1,
      },
    },
    {
      label: "non-finite width",
      object: {
        shape: "ellipse",
        x: 0,
        y: 0,
        width: Number.POSITIVE_INFINITY,
        height: 8,
      },
    },
    {
      label: "non-finite height",
      object: {
        shape: "capsule",
        x: 0,
        y: 0,
        width: 8,
        height: Number.NaN,
      },
    },
  ])(
    "rejects $label when creating an ellipse or capsule",
    async ({ object }) => {
      const harness = await createHarness(roots);
      const before = await readFile(
        join(harness.root, MAP_PATH),
      );

      await expect(
        plan(harness.service, [
          unsafeOperation({
            type: "createObject",
            layerId: OBJECT_LAYER_ID,
            object,
          }),
        ]),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "INVALID_ARGUMENT",
      });
      expect(
        await readFile(
          join(harness.root, MAP_PATH),
        ),
      ).toEqual(before);
    },
  );

  it("enforces strict operation, draft, and patch keys and keeps shape immutable", async () => {
    const harness = await createHarness(roots);
    const validDraft = {
      shape: "ellipse",
      x: 0,
      y: 0,
      width: 8,
      height: 6,
    };
    const invalidOperations = [
      unsafeOperation({
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: validDraft,
        unexpected: true,
      }),
      unsafeOperation({
        type: "createObject",
        layerId: 0,
        object: validDraft,
      }),
      unsafeOperation({
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          ...validDraft,
          unexpected: true,
        },
      }),
      unsafeOperation({
        type: "updateObject",
        objectId: ELLIPSE_ID,
        patch: {
          shape: "capsule",
        },
      }),
      unsafeOperation({
        type: "updateObject",
        objectId: CAPSULE_ID,
        patch: {
          width: 12,
        },
        unexpected: true,
      }),
      unsafeOperation({
        type: "deleteObjects",
        objectIds: [ELLIPSE_ID],
        unexpected: true,
      }),
    ];
    const before = await readFile(
      join(harness.root, MAP_PATH),
    );

    for (const operation of invalidOperations) {
      await expect(
        plan(harness.service, [operation]),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "INVALID_ARGUMENT",
      });
    }
    expect(
      await readFile(join(harness.root, MAP_PATH)),
    ).toEqual(before);
  });

  it("allows updates to zero dimensions while preserving shape markers", async () => {
    const harness = await createHarness(roots);
    const edit = await plan(harness.service, [
      {
        type: "updateObject",
        objectId: ELLIPSE_ID,
        patch: {
          width: 0,
          height: 0,
        },
      },
      {
        type: "updateObject",
        objectId: CAPSULE_ID,
        patch: {
          width: 0,
          height: 0,
        },
      },
    ]);

    await harness.service.applyEdits(edit);
    const objects = requireObjects(
      await readMap(harness.root),
    );
    expect(objects[0]).toMatchObject({
      ellipse: true,
      width: 0,
      height: 0,
    });
    expect(objects[1]).toMatchObject({
      capsule: true,
      width: 0,
      height: 0,
    });
  });

  it.each([
    {
      shape: "ellipse",
      objectId: ELLIPSE_ID,
      patch: { height: -1 },
    },
    {
      shape: "capsule",
      objectId: CAPSULE_ID,
      patch: { width: -1 },
    },
    {
      shape: "ellipse",
      objectId: ELLIPSE_ID,
      patch: {
        width: Number.POSITIVE_INFINITY,
      },
    },
    {
      shape: "capsule",
      objectId: CAPSULE_ID,
      patch: { height: Number.NaN },
    },
  ])(
    "refuses a negative or non-finite $shape dimension update",
    async ({ objectId, patch }) => {
      const harness = await createHarness(roots);
      const mapPath = join(harness.root, MAP_PATH);
      const before = await readFile(mapPath);

      await expect(
        plan(harness.service, [
          {
            type: "updateObject",
            objectId,
            patch,
          },
        ]),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "INVALID_ARGUMENT",
      });
      expect(await readFile(mapPath)).toEqual(
        before,
      );
    },
  );

  it("allows common-field updates to stored zero-size shapes", async () => {
    const harness = await createHarness(roots);
    const map = baseMap();
    const objects = requireObjects(map);
    const ellipse = objects[0];
    const capsule = objects[1];
    if (
      ellipse === undefined ||
      capsule === undefined
    ) {
      throw new Error(
        "Missing zero-size shape fixtures.",
      );
    }
    ellipse.width = 0;
    capsule.height = 0;
    await writeJson(
      join(harness.root, MAP_PATH),
      map,
    );

    const edit = await plan(harness.service, [
      {
        type: "updateObject",
        objectId: ELLIPSE_ID,
        patch: { name: "Flat portal" },
      },
      {
        type: "updateObject",
        objectId: CAPSULE_ID,
        patch: { name: "Flat capsule" },
      },
    ]);
    await harness.service.applyEdits(edit);

    const saved = requireObjects(
      await readMap(harness.root),
    );
    expect(saved[0]).toMatchObject({
      ellipse: true,
      width: 0,
      name: "Flat portal",
    });
    expect(saved[1]).toMatchObject({
      capsule: true,
      height: 0,
      name: "Flat capsule",
    });
  });

  it("treats omitted stored dimensions as zero for update and delete", async () => {
    const harness = await createHarness(roots);
    const map = baseMap();
    const objects = requireObjects(map);
    const ellipse = objects[0];
    const capsule = objects[1];
    if (
      ellipse === undefined ||
      capsule === undefined
    ) {
      throw new Error(
        "Missing omitted-dimension shape fixtures.",
      );
    }
    delete ellipse.width;
    delete ellipse.height;
    delete capsule.width;
    delete capsule.height;
    await writeJson(
      join(harness.root, MAP_PATH),
      map,
    );

    const listed =
      await harness.service.listObjects({
        mapPath: MAP_PATH,
      });
    expect(listed).toMatchObject({
      objects: [
        {
          id: ELLIPSE_ID,
          shape: "ellipse",
          width: 0,
          height: 0,
        },
        {
          id: CAPSULE_ID,
          shape: "capsule",
          width: 0,
          height: 0,
        },
      ],
    });

    const edit = await plan(harness.service, [
      {
        type: "updateObject",
        objectId: ELLIPSE_ID,
        patch: { name: "Implicit zero" },
      },
      {
        type: "deleteObjects",
        objectIds: [CAPSULE_ID],
      },
    ]);
    await harness.service.applyEdits(edit);

    const saved = requireObjects(
      await readMap(harness.root),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      id: ELLIPSE_ID,
      ellipse: true,
      name: "Implicit zero",
    });
    expect(saved[0]).not.toHaveProperty("width");
    expect(saved[0]).not.toHaveProperty("height");
  });

  it.each([
    {
      label: "conflicting markers",
      mutate: (object: JsonObject) => {
        object.capsule = true;
      },
    },
    {
      label: "non-true marker",
      mutate: (object: JsonObject) => {
        object.ellipse = false;
      },
    },
  ])(
    "fails closed on $label in a stored shape",
    async ({ mutate }) => {
      const harness = await createHarness(roots);
      const map = baseMap();
      const ellipse =
        requireObjects(map)[0];
      if (ellipse === undefined) {
        throw new Error(
          "Missing marker-conflict fixture.",
        );
      }
      mutate(ellipse);
      const mapPath = join(
        harness.root,
        MAP_PATH,
      );
      await writeJson(mapPath, map);
      const before = await readFile(mapPath);

      await expect(
        plan(harness.service, [
          {
            type: "updateObject",
            objectId: ELLIPSE_ID,
            patch: { x: 9 },
          },
        ]),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "INVALID_DOCUMENT",
      });
      await expect(
        plan(harness.service, [
          {
            type: "deleteObjects",
            objectIds: [ELLIPSE_ID],
          },
        ]),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "INVALID_DOCUMENT",
      });
      expect(await readFile(mapPath)).toEqual(
        before,
      );
    },
  );

  it("rewrites only objects and nextobjectid in a BOM/CRLF source", async () => {
    const harness = await createHarness(roots);
    const document = baseMap();
    document.vendorRootExtension = {
      preserve: ["root", 23],
    };
    const unusualSource =
      `\uFEFF${JSON.stringify(
        document,
        null,
        "\t",
      )
        .replace(
          '"compressionlevel": -1',
          '"compressionlevel": -1.000e+0',
        )
        .replace(
          '"renderorder": "right-down"',
          '"renderorder": "\\u0072ight-down"',
        )
        .replace(/\n/gu, "\r\n")}\r\n`;
    const mapPath = join(harness.root, MAP_PATH);
    await writeFile(mapPath, unusualSource, "utf8");
    const before = await readFile(mapPath, "utf8");
    const mutablePaths: JSONPath[] = [
      ["layers", 0, "objects"],
      ["nextobjectid"],
    ];
    const edit = await plan(harness.service, [
      createShape("ellipse", {
        x: 80,
        y: 40,
        width: 32,
        height: 12,
      }),
      {
        type: "updateObject",
        objectId: CAPSULE_ID,
        patch: {
          width: 14,
          height: 30,
        },
      },
    ]);

    await harness.service.applyEdits(edit);
    const after = await readFile(mapPath, "utf8");

    expect(
      maskJsonValues(after, mutablePaths),
    ).toBe(maskJsonValues(before, mutablePaths));
    expect(after.startsWith("\uFEFF")).toBe(true);
    expect(after).toContain(
      '"compressionlevel": -1.000e+0',
    );
    expect(after).toContain(
      '"renderorder": "\\u0072ight-down"',
    );
    expect(after).toContain("\r\n");
    const saved = JSON.parse(
      after.slice(1),
    ) as JsonObject;
    expect(saved.nextobjectid).toBe(4);
    expect(requireObjects(saved)[2]).toMatchObject({
      id: 3,
      ellipse: true,
      width: 32,
      height: 12,
    });
  });

  it("rejects tampered, stale-map, and stale-dependency plans without overwriting bytes", async () => {
    const tamperHarness =
      await createHarness(roots);
    const tamperPlan = await plan(
      tamperHarness.service,
      [
        createShape("capsule", {
          x: 8,
          y: 8,
          width: 8,
          height: 16,
        }),
      ],
    );
    const tampered = structuredClone(tamperPlan);
    const tamperedOperation =
      tampered.operations[0];
    if (
      tamperedOperation?.type !== "createObject"
    ) {
      throw new Error(
        "Expected a createObject operation fixture.",
      );
    }
    (
      tamperedOperation.object as unknown as {
        width: number;
      }
    ).width = 9;
    const tamperMapPath = join(
      tamperHarness.root,
      MAP_PATH,
    );
    const beforeTamper = await readFile(
      tamperMapPath,
    );
    await expect(
      tamperHarness.service.applyEdits(tampered),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "CHANGE_SET_TAMPERED",
    });
    expect(
      await readFile(tamperMapPath),
    ).toEqual(beforeTamper);

    const undefinedHarness =
      await createHarness(roots);
    const undefinedPlan = await plan(
      undefinedHarness.service,
      [
        {
          type: "updateObject",
          objectId: ELLIPSE_ID,
          patch: { name: "Safe name" },
        },
      ],
    );
    const undefinedOperation =
      undefinedPlan.operations[0];
    if (
      undefinedOperation?.type !==
      "updateObject"
    ) {
      throw new Error(
        "Expected an updateObject operation fixture.",
      );
    }
    (
      undefinedOperation.patch as {
        width: number | undefined;
      }
    ).width = undefined;
    const undefinedMapPath = join(
      undefinedHarness.root,
      MAP_PATH,
    );
    const beforeUndefinedTamper =
      await readFile(undefinedMapPath);
    await expect(
      undefinedHarness.service.applyEdits(
        undefinedPlan,
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
    });
    expect(
      await readFile(undefinedMapPath),
    ).toEqual(beforeUndefinedTamper);

    const staleMapHarness =
      await createHarness(roots);
    const staleMapPlan = await plan(
      staleMapHarness.service,
      [
        {
          type: "updateObject",
          objectId: ELLIPSE_ID,
          patch: { width: 18 },
        },
      ],
    );
    const staleMapPath = join(
      staleMapHarness.root,
      MAP_PATH,
    );
    const externalMap = baseMap();
    externalMap.externalOwnerField =
      "changed after shape preview";
    await writeJson(staleMapPath, externalMap);
    const externalMapBytes = await readFile(
      staleMapPath,
    );
    await expect(
      staleMapHarness.service.applyEdits(
        staleMapPlan,
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "REVISION_CONFLICT",
    });
    expect(
      await readFile(staleMapPath),
    ).toEqual(externalMapBytes);

    const dependencyHarness =
      await createHarness(roots);
    const dependencyPlan = await plan(
      dependencyHarness.service,
      [
        {
          type: "updateObject",
          objectId: CAPSULE_ID,
          patch: { height: 22 },
        },
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
    const harness = await createHarness(roots);
    const edit = await plan(harness.service, [
      createShape("ellipse", {
        x: 40,
        y: 12,
        width: 18,
        height: 10,
        name: "Round-trip ellipse",
      }),
      createShape("capsule", {
        x: 64,
        y: 20,
        width: 14,
        height: 30,
        name: "Round-trip capsule",
      }),
      {
        type: "updateObject",
        objectId: ELLIPSE_ID,
        patch: {
          width: 22,
          height: 11,
        },
      },
      {
        type: "updateObject",
        objectId: CAPSULE_ID,
        patch: {
          width: 12,
          height: 24,
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
    const objects = requireObjects(exported);
    expect(objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ELLIPSE_ID,
          ellipse: true,
          width: 22,
          height: 11,
        }),
        expect.objectContaining({
          id: CAPSULE_ID,
          capsule: true,
          width: 12,
          height: 24,
        }),
        expect.objectContaining({
          id: 3,
          ellipse: true,
          width: 18,
          height: 10,
        }),
        expect.objectContaining({
          id: 4,
          capsule: true,
          width: 14,
          height: 30,
        }),
      ]),
    );
  }, 40_000);
});

async function createHarness(
  roots: Set<string>,
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-object-shapes-"),
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
      '<rect width="16" height="16" fill="#55aa55"/>',
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
        name: "Shape Objects",
        objects: [
          {
            ellipse: true,
            height: 8,
            id: ELLIPSE_ID,
            name: "Portal",
            opacity: 0.75,
            rotation: 15,
            type: "Trigger",
            vendorEllipseExtension: {
              preserve: ["ellipse", 17],
            },
            visible: true,
            width: 12,
            x: 4,
            y: 6,
          },
          {
            capsule: true,
            height: 18,
            id: CAPSULE_ID,
            name: "Player body",
            rotation: 0,
            type: "Collision",
            vendorCapsuleExtension: {
              preserve: { future: true },
            },
            visible: false,
            width: 10,
            x: 24,
            y: 10,
          },
        ],
        opacity: 1,
        type: "objectgroup",
        vendorObjectLayerExtension: {
          preserve: "object-layer",
        },
        visible: true,
      },
    ],
    nextlayerid: 8,
    nextobjectid: 3,
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
    width: 4,
  };
}

function baseTileset(): JsonObject {
  return {
    columns: 1,
    image: "terrain.svg",
    imageheight: 16,
    imagewidth: 16,
    margin: 0,
    name: "Terrain",
    spacing: 0,
    tilecount: 1,
    tileheight: 16,
    tilewidth: 16,
    tiledversion: "1.12.2",
    type: "tileset",
    version: "1.10",
  };
}

function createShape(
  shape: ExtendedObjectShape,
  object: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    className?: string;
    rotation?: number;
    visible?: boolean;
    opacity?: number;
  },
): MapEditOperation {
  return unsafeOperation({
    type: "createObject",
    layerId: OBJECT_LAYER_ID,
    object: {
      shape,
      ...object,
    },
  });
}

function unsafeOperation(
  operation: unknown,
): MapEditOperation {
  return operation as MapEditOperation;
}

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

async function readMap(
  root: string,
): Promise<JsonObject> {
  const source = await readFile(
    join(root, MAP_PATH),
    "utf8",
  );
  return JSON.parse(
    source.replace(/^\uFEFF/u, ""),
  ) as JsonObject;
}

function requireObjects(
  map: JsonObject,
): JsonObject[] {
  const layers = map.layers;
  if (!Array.isArray(layers)) {
    throw new Error(
      "Expected the fixture map layers.",
    );
  }
  const layer = layers.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      candidate.id === OBJECT_LAYER_ID,
  );
  if (
    typeof layer !== "object" ||
    layer === null ||
    Array.isArray(layer) ||
    !Array.isArray(layer.objects)
  ) {
    throw new Error(
      "Expected the fixture object layer.",
    );
  }
  return layer.objects as JsonObject[];
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
  const hasBom =
    source.charCodeAt(0) === 0xfeff;
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
    const node = findNodeAtLocation(
      tree,
      path,
    );
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
