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
  readdir,
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
  type JsonValue,
} from "../src/formats/json.js";
import {
  MAX_DUPLICATE_LAYER_BYTES,
  MapService,
} from "../src/maps/mapService.js";
import type {
  DuplicateLayerOperation,
  MapEditOperation,
  MapEditPlan,
} from "../src/maps/types.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/level.tmj";
const TILE_LAYER_ID = 1;
const OBJECT_LAYER_ID = 2;
const EXTERNAL_OBJECT_LAYER_ID = 3;
const IMAGE_LAYER_ID = 4;
const SOURCE_GROUP_ID = 5;
const GROUP_TILE_LAYER_ID = 6;
const NESTED_GROUP_ID = 7;
const GROUP_OBJECT_LAYER_ID = 8;
const GROUP_IMAGE_LAYER_ID = 9;
const TARGET_GROUP_ID = 10;
const LOCKED_TARGET_GROUP_ID = 11;
const TARGET_CHILD_LAYER_ID = 12;
const FIRST_CREATED_LAYER_ID = 20;
const FIRST_CREATED_OBJECT_ID = 30;
const EXTERNAL_OBJECT_ID = 20;
const TRANSFORMED_GID = 0x8000_0002;

interface Harness {
  root: string;
  service: MapService;
}

interface MapSnapshot {
  revision: string;
  dependencies: Record<string, string>;
}

describe("duplicateLayer", () => {
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
      label: "tile layer",
      layerId: TILE_LAYER_ID,
      type: "tilelayer",
      copiedLayerCount: 1,
      copiedObjectCount: 0,
      nextLayerId: 21,
      nextObjectId: 30,
    },
    {
      label: "object layer",
      layerId: OBJECT_LAYER_ID,
      type: "objectgroup",
      copiedLayerCount: 1,
      copiedObjectCount: 2,
      nextLayerId: 21,
      nextObjectId: 32,
    },
    {
      label: "image layer",
      layerId: IMAGE_LAYER_ID,
      type: "imagelayer",
      copiedLayerCount: 1,
      copiedObjectCount: 0,
      nextLayerId: 21,
      nextObjectId: 30,
    },
    {
      label: "Group subtree",
      layerId: SOURCE_GROUP_ID,
      type: "group",
      copiedLayerCount: 5,
      copiedObjectCount: 2,
      nextLayerId: 25,
      nextObjectId: 32,
    },
  ] as const)(
    "duplicates a $label without changing the source",
    async ({
      layerId,
      type,
      copiedLayerCount,
      copiedObjectCount,
      nextLayerId,
      nextObjectId,
    }) => {
      const harness = await createHarness(roots);
      const sourceBefore = structuredClone(
        requireLayer(await readMap(harness.root), layerId),
      );
      const duplicatePlan = await plan(harness.service, {
        type: "duplicateLayer",
        layerId,
      });

      expect(duplicatePlan.summary.duplicatedLayers).toEqual([
        expect.objectContaining({
          operationIndex: 0,
          sourceLayerId: layerId,
          createdRootLayerId: FIRST_CREATED_LAYER_ID,
          layerType: type,
          copiedLayerCount,
          copiedObjectCount,
          serializedDuplicateBytes: expect.any(Number),
        }),
      ]);
      await harness.service.applyEdits(duplicatePlan);

      const saved = await readMap(harness.root);
      expect(requireLayer(saved, layerId)).toEqual(sourceBefore);
      expect(
        requireLayer(saved, FIRST_CREATED_LAYER_ID).type,
      ).toBe(type);
      expect(saved.nextlayerid).toBe(nextLayerId);
      expect(saved.nextobjectid).toBe(nextObjectId);
    },
  );

  it.each([
    {
      label: "the omitted destination",
      layerId: TILE_LAYER_ID,
      destination: undefined,
      targetParentGroupId: null,
      targetIndex: 1,
      expectedRoot: [
        1, 20, 2, 3, 4, 5, 10, 11,
      ],
      expectedTargetChildren: [12],
    },
    {
      label: "sameParent without an index",
      layerId: GROUP_TILE_LAYER_ID,
      destination: { kind: "sameParent" },
      targetParentGroupId: SOURCE_GROUP_ID,
      targetIndex: 1,
      expectedRoot: [1, 2, 3, 4, 5, 10, 11],
      expectedSourceChildren: [6, 20, 7],
      expectedTargetChildren: [12],
    },
    {
      label: "sameParent at an explicit final index",
      layerId: GROUP_TILE_LAYER_ID,
      destination: { kind: "sameParent", index: 0 },
      targetParentGroupId: SOURCE_GROUP_ID,
      targetIndex: 0,
      expectedRoot: [1, 2, 3, 4, 5, 10, 11],
      expectedSourceChildren: [20, 6, 7],
      expectedTargetChildren: [12],
    },
    {
      label: "root without an index",
      layerId: GROUP_TILE_LAYER_ID,
      destination: { kind: "root" },
      targetParentGroupId: null,
      targetIndex: 7,
      expectedRoot: [
        1, 2, 3, 4, 5, 10, 11, 20,
      ],
      expectedSourceChildren: [6, 7],
      expectedTargetChildren: [12],
    },
    {
      label: "root at an explicit final index",
      layerId: GROUP_TILE_LAYER_ID,
      destination: { kind: "root", index: 1 },
      targetParentGroupId: null,
      targetIndex: 1,
      expectedRoot: [
        1, 20, 2, 3, 4, 5, 10, 11,
      ],
      expectedSourceChildren: [6, 7],
      expectedTargetChildren: [12],
    },
    {
      label: "a Group without an index",
      layerId: TILE_LAYER_ID,
      destination: {
        kind: "group",
        parentGroupId: TARGET_GROUP_ID,
      },
      targetParentGroupId: TARGET_GROUP_ID,
      targetIndex: 1,
      expectedRoot: [1, 2, 3, 4, 5, 10, 11],
      expectedTargetChildren: [12, 20],
    },
    {
      label: "a Group at an explicit final index",
      layerId: TILE_LAYER_ID,
      destination: {
        kind: "group",
        parentGroupId: TARGET_GROUP_ID,
        index: 0,
      },
      targetParentGroupId: TARGET_GROUP_ID,
      targetIndex: 0,
      expectedRoot: [1, 2, 3, 4, 5, 10, 11],
      expectedTargetChildren: [20, 12],
    },
  ] as const)(
    "uses $label with insertion-index semantics",
    async ({
      layerId,
      destination,
      targetParentGroupId,
      targetIndex,
      expectedRoot,
      expectedSourceChildren,
      expectedTargetChildren,
    }) => {
      const harness = await createHarness(roots);
      const duplicatePlan = await plan(harness.service, {
        type: "duplicateLayer",
        layerId,
        ...(destination === undefined
          ? {}
          : { destination }),
      });

      expect(duplicatePlan.summary.duplicatedLayers).toEqual([
        expect.objectContaining({
          sourceLayerId: layerId,
          targetParentGroupId,
          targetIndex,
        }),
      ]);
      await harness.service.applyEdits(duplicatePlan);

      const saved = await readMap(harness.root);
      expect(rootLayerIds(saved)).toEqual(expectedRoot);
      if (expectedSourceChildren !== undefined) {
        expect(
          layerChildIds(saved, SOURCE_GROUP_ID),
        ).toEqual(expectedSourceChildren);
      }
      expect(
        layerChildIds(saved, TARGET_GROUP_ID),
      ).toEqual(expectedTargetChildren);
    },
  );

  it("allocates Group layer and object IDs in preorder from high-water marks with gaps", async () => {
    const harness = await createHarness(roots);
    const duplicatePlan = await plan(harness.service, {
      type: "duplicateLayer",
      layerId: SOURCE_GROUP_ID,
    });

    expect(duplicatePlan.summary).toMatchObject({
      duplicatedLayers: [
        {
          operationIndex: 0,
          sourceLayerId: SOURCE_GROUP_ID,
          createdRootLayerId: 20,
          layerType: "group",
          name: "Gameplay",
          nameTruncated: false,
          sourceParentGroupId: null,
          targetParentGroupId: null,
          sourceIndex: 4,
          targetIndex: 5,
          copiedLayerCount: 5,
          descendantLayerCount: 4,
          copiedObjectCount: 2,
          allocatedCellCount: 4,
          serializedDuplicateBytes: expect.any(Number),
          layerIdMappingSample: [
            { from: 5, to: 20 },
            { from: 6, to: 21 },
            { from: 7, to: 22 },
            { from: 8, to: 23 },
            { from: 9, to: 24 },
          ],
          omittedLayerMappingCount: 0,
          objectIdMappingSample: [
            { from: 12, to: 30 },
            { from: 13, to: 31 },
          ],
          omittedObjectMappingCount: 0,
          remappedInternalObjectReferenceCount: 2,
          retainedExternalObjectReferenceCount:
            expect.any(Number),
          fileReferenceCount: 2,
          tileObjectCount: 1,
          lockedLayerCount: 1,
          effectivelyLockedLayerCount: 5,
          renderOrderMayChange: true,
          renderContextMayChange: false,
          affectsDescendants: true,
        },
      ],
    });

    await harness.service.applyEdits(duplicatePlan);
    const saved = await readMap(harness.root);
    expect(rootLayerIds(saved)).toEqual([
      1, 2, 3, 4, 5, 20, 10, 11,
    ]);
    expect(layerChildIds(saved, 20)).toEqual([21, 22]);
    expect(layerChildIds(saved, 22)).toEqual([23, 24]);
    expect(saved.nextlayerid).toBe(25);
    expect(saved.nextobjectid).toBe(32);
  });

  it("remaps direct and Tiled 1.12 list references inside the copy while retaining external and zero references", async () => {
    const harness = await createHarness(roots);
    const duplicatePlan = await plan(harness.service, {
      type: "duplicateLayer",
      layerId: GROUP_OBJECT_LAYER_ID,
    });
    await harness.service.applyEdits(duplicatePlan);

    const saved = await readMap(harness.root);
    const copiedObjects = requireLayer(
      saved,
      FIRST_CREATED_LAYER_ID,
    ).objects as JsonObject[];
    expect(copiedObjects.map((object) => object.id)).toEqual([
      30, 31,
    ]);
    const properties = copiedObjects[0]
      ?.properties as JsonObject[];
    expect(propertyValue(properties, "partner")).toBe(31);
    expect(propertyValue(properties, "targets")).toEqual([
      { type: "object", value: 30 },
      { type: "object", value: EXTERNAL_OBJECT_ID },
      { type: "object", value: 0 },
    ]);

    const sourceObjects = requireLayer(
      saved,
      GROUP_OBJECT_LAYER_ID,
    ).objects as JsonObject[];
    expect(
      propertyValue(
        sourceObjects[0]?.properties as JsonObject[],
        "partner",
      ),
    ).toBe(13);
  });

  it("rewires layer-level object properties without guessing ordinary integer layer references", async () => {
    const map = baseMap();
    requireLayer(map, SOURCE_GROUP_ID).properties = [
      {
        name: "nestedObject",
        type: "object",
        value: 13,
      },
      {
        name: "mixedTargets",
        type: "list",
        value: [
          { type: "object", value: 12 },
          {
            type: "object",
            value: EXTERNAL_OBJECT_ID,
          },
          { type: "object", value: 0 },
        ],
      },
      {
        name: "ordinaryLayerNumber",
        type: "int",
        value: GROUP_TILE_LAYER_ID,
      },
    ];
    const harness = await createHarness(roots, map);
    const duplicatePlan = await plan(harness.service, {
      type: "duplicateLayer",
      layerId: SOURCE_GROUP_ID,
    });
    await harness.service.applyEdits(duplicatePlan);

    const properties = requireLayer(
      await readMap(harness.root),
      FIRST_CREATED_LAYER_ID,
    ).properties as JsonObject[];
    expect(
      propertyValue(properties, "nestedObject"),
    ).toBe(31);
    expect(
      propertyValue(properties, "mixedTargets"),
    ).toEqual([
      { type: "object", value: 30 },
      { type: "object", value: EXTERNAL_OBJECT_ID },
      { type: "object", value: 0 },
    ]);
    expect(
      propertyValue(
        properties,
        "ordinaryLayerNumber",
      ),
    ).toBe(GROUP_TILE_LAYER_ID);
  });

  it("does not interpret vendor fields named properties as Tiled property containers", async () => {
    const map = baseMap();
    const vendorExtension = {
      properties: [
        {
          type: "object",
          value: 12,
        },
      ],
      nested: {
        properties: {
          opaque: true,
        },
      },
    } satisfies JsonObject;
    requireLayer(map, SOURCE_GROUP_ID).vendorExtension =
      structuredClone(vendorExtension);
    const sourceObject = (
      requireLayer(
        map,
        GROUP_OBJECT_LAYER_ID,
      ).objects as JsonObject[]
    )[0] as JsonObject;
    sourceObject.vendorExtension =
      structuredClone(vendorExtension);
    const harness = await createHarness(roots, map);

    const duplicatePlan = await plan(harness.service, {
      type: "duplicateLayer",
      layerId: SOURCE_GROUP_ID,
    });
    expect(
      duplicatePlan.summary.duplicatedLayers?.[0]
        ?.remappedInternalObjectReferenceCount,
    ).toBe(2);
    await harness.service.applyEdits(duplicatePlan);

    const saved = await readMap(harness.root);
    expect(
      requireLayer(saved, FIRST_CREATED_LAYER_ID)
        .vendorExtension,
    ).toEqual(vendorExtension);
    const copiedObject = (
      requireLayer(saved, 23).objects as JsonObject[]
    )[0] as JsonObject;
    expect(copiedObject.vendorExtension).toEqual(
      vendorExtension,
    );
  });

  it("overrides only the copied root name and accepts an empty name", async () => {
    const harness = await createHarness(roots);
    const duplicatePlan = await plan(harness.service, {
      type: "duplicateLayer",
      layerId: SOURCE_GROUP_ID,
      name: "",
    });
    expect(duplicatePlan.summary.duplicatedLayers).toEqual([
      expect.objectContaining({
        name: "",
        nameTruncated: false,
      }),
    ]);
    await harness.service.applyEdits(duplicatePlan);

    const saved = await readMap(harness.root);
    expect(requireLayer(saved, 20).name).toBe("");
    expect(requireLayer(saved, 21).name).toBe(
      requireLayer(saved, GROUP_TILE_LAYER_ID).name,
    );
    expect(requireLayer(saved, 22).name).toBe(
      requireLayer(saved, NESTED_GROUP_ID).name,
    );
    expect(requireLayer(saved, SOURCE_GROUP_ID).name).toBe(
      "Gameplay",
    );
  });

  it("preserves shared image and file references without copying referenced files", async () => {
    const harness = await createHarness(roots);
    const imageFilesBefore = await readdir(
      join(harness.root, "images"),
    );
    const scriptFilesBefore = await readdir(
      join(harness.root, "scripts"),
    );
    const imageBytesBefore = await readFile(
      join(harness.root, "images", "backdrop.svg"),
    );
    const scriptBytesBefore = await readFile(
      join(harness.root, "scripts", "behavior.lua"),
    );

    const duplicatePlan = await plan(harness.service, {
      type: "duplicateLayer",
      layerId: SOURCE_GROUP_ID,
    });
    await harness.service.applyEdits(duplicatePlan);

    const saved = await readMap(harness.root);
    expect(requireLayer(saved, 24).image).toBe(
      "../images/backdrop.svg",
    );
    const copiedObject = (
      requireLayer(saved, 23).objects as JsonObject[]
    )[0] as JsonObject;
    expect(
      propertyValue(
        copiedObject.properties as JsonObject[],
        "script",
      ),
    ).toBe("../scripts/behavior.lua");
    expect(await readdir(join(harness.root, "images"))).toEqual(
      imageFilesBefore,
    );
    expect(await readdir(join(harness.root, "scripts"))).toEqual(
      scriptFilesBefore,
    );
    expect(
      await readFile(
        join(harness.root, "images", "backdrop.svg"),
      ),
    ).toEqual(imageBytesBefore);
    expect(
      await readFile(
        join(harness.root, "scripts", "behavior.lua"),
      ),
    ).toEqual(scriptBytesBefore);
  });

  it("preserves tile-object transform flags after validating the base GID", async () => {
    const harness = await createHarness(roots);
    const duplicatePlan = await plan(harness.service, {
      type: "duplicateLayer",
      layerId: GROUP_OBJECT_LAYER_ID,
    });
    await harness.service.applyEdits(duplicatePlan);

    const copiedObjects = requireLayer(
      await readMap(harness.root),
      FIRST_CREATED_LAYER_ID,
    ).objects as JsonObject[];
    expect(copiedObjects[1]?.gid).toBe(TRANSFORMED_GID);
  });

  it("rejects dangling object references in the copied subtree", async () => {
    const map = baseMap();
    const object = (
      requireLayer(map, GROUP_OBJECT_LAYER_ID)
        .objects as JsonObject[]
    )[0] as JsonObject;
    object.properties = [
      {
        name: "missing",
        type: "object",
        value: 999,
      },
    ];
    const harness = await createHarness(roots, map);

    await expect(
      plan(harness.service, {
        type: "duplicateLayer",
        layerId: GROUP_OBJECT_LAYER_ID,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "OBJECT_REFERENCE_NOT_FOUND",
      details: {
        objectId: 999,
      },
    });
  });

  it("fails closed on class properties in the copied subtree", async () => {
    const map = baseMap();
    const object = (
      requireLayer(map, GROUP_OBJECT_LAYER_ID)
        .objects as JsonObject[]
    )[0] as JsonObject;
    object.properties = [
      {
        name: "configuration",
        type: "class",
        propertytype: "GameplayConfig",
        value: { target: 13 },
      },
    ];
    const harness = await createHarness(roots, map);

    await expect(
      plan(harness.service, {
        type: "duplicateLayer",
        layerId: GROUP_OBJECT_LAYER_ID,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "UNSUPPORTED_DUPLICATE_REFERENCE_ANALYSIS",
    });
  });

  it("rejects object templates in the copied subtree", async () => {
    const map = baseMap();
    const object = (
      requireLayer(map, GROUP_OBJECT_LAYER_ID)
        .objects as JsonObject[]
    )[0] as JsonObject;
    object.template = "../templates/enemy.tx";
    const harness = await createHarness(roots, map);

    await expect(
      plan(harness.service, {
        type: "duplicateLayer",
        layerId: GROUP_OBJECT_LAYER_ID,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "UNSUPPORTED_DUPLICATE_TEMPLATE",
      details: {
        objectId: 12,
      },
    });
  });

  it("rejects an unresolved transformed tile-object GID", async () => {
    const map = baseMap();
    const objects = requireLayer(
      map,
      GROUP_OBJECT_LAYER_ID,
    ).objects as JsonObject[];
    (objects[1] as JsonObject).gid = 0x8000_0064;
    const harness = await createHarness(roots, map);

    await expect(
      plan(harness.service, {
        type: "duplicateLayer",
        layerId: GROUP_OBJECT_LAYER_ID,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "GID_OUT_OF_RANGE",
      details: {
        gid: 100,
      },
    });
  });

  it("reports direct and inherited locking at the target", async () => {
    const directHarness = await createHarness(roots);
    const groupPlan = await plan(directHarness.service, {
      type: "duplicateLayer",
      layerId: SOURCE_GROUP_ID,
    });
    expect(groupPlan.summary.duplicatedLayers).toEqual([
      expect.objectContaining({
        lockedLayerCount: 1,
        effectivelyLockedLayerCount: 5,
      }),
    ]);

    const inheritedHarness = await createHarness(roots);
    const inheritedPlan = await plan(
      inheritedHarness.service,
      {
        type: "duplicateLayer",
        layerId: TILE_LAYER_ID,
        destination: {
          kind: "group",
          parentGroupId: LOCKED_TARGET_GROUP_ID,
        },
      },
    );
    expect(inheritedPlan.summary.duplicatedLayers).toEqual([
      expect.objectContaining({
        lockedLayerCount: 0,
        effectivelyLockedLayerCount: 1,
        renderContextMayChange: true,
      }),
    ]);
  });

  it.each([
    {
      label: "the source Group itself",
      parentGroupId: SOURCE_GROUP_ID,
    },
    {
      label: "a descendant Group",
      parentGroupId: NESTED_GROUP_ID,
    },
  ])(
    "rejects $label as the duplicate target",
    async ({ parentGroupId }) => {
      const harness = await createHarness(roots);
      await expect(
        plan(harness.service, {
          type: "duplicateLayer",
          layerId: SOURCE_GROUP_ID,
          destination: {
            kind: "group",
            parentGroupId,
          },
        }),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "DUPLICATE_LAYER_TARGET_IN_SOURCE_SUBTREE",
        details: {
          layerId: SOURCE_GROUP_ID,
          parentGroupId,
        },
      });
    },
  );

  it("rejects missing/non-Group targets, out-of-range indices, malformed input and mixed batches", async () => {
    const harness = await createHarness(roots);

    await expect(
      plan(harness.service, {
        type: "duplicateLayer",
        layerId: 999,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_NOT_FOUND",
      details: { layerId: 999 },
    });
    await expect(
      plan(harness.service, {
        type: "duplicateLayer",
        layerId: TILE_LAYER_ID,
        destination: {
          kind: "group",
          parentGroupId: 999,
        },
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_NOT_FOUND",
      details: { layerId: 999, role: "parent" },
    });
    await expect(
      plan(harness.service, {
        type: "duplicateLayer",
        layerId: TILE_LAYER_ID,
        destination: {
          kind: "group",
          parentGroupId: OBJECT_LAYER_ID,
        },
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_TYPE_MISMATCH",
      details: {
        layerId: OBJECT_LAYER_ID,
        role: "parent",
      },
    });
    await expect(
      plan(harness.service, {
        type: "duplicateLayer",
        layerId: TILE_LAYER_ID,
        destination: { kind: "root", index: 8 },
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_INDEX_OUT_OF_RANGE",
      details: {
        index: 8,
        maximumIndex: 7,
        indexSemantics: "final-insertion-index",
      },
    });
    await expect(
      plan(harness.service, {
        type: "duplicateLayer",
        layerId: TILE_LAYER_ID,
        name: "x".repeat(1_025),
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
    });
    await expect(
      plan(
        harness.service,
        {
          type: "duplicateLayer",
          layerId: TILE_LAYER_ID,
          unexpected: true,
        } as unknown as DuplicateLayerOperation,
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
    });
    await expect(
      plan(harness.service, [
        {
          type: "duplicateLayer",
          layerId: TILE_LAYER_ID,
        },
        {
          type: "updateLayer",
          layerId: IMAGE_LAYER_ID,
          patch: { visible: false },
        },
      ]),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_ARGUMENT",
    });
  });

  it("rejects a duplicate whose resulting depth would exceed 64", async () => {
    const harness = await createHarness(
      roots,
      depthBoundaryMap(),
    );
    await expect(
      plan(harness.service, {
        type: "duplicateLayer",
        layerId: 1,
        destination: {
          kind: "group",
          parentGroupId: 163,
        },
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

  it("rejects duplication beyond the 10,000-layer map limit", async () => {
    const map = boundaryMap();
    map.layers = Array.from(
      { length: 10_000 },
      (_, index): JsonObject => ({
        id: index + 1,
        layers: [],
        name: `Layer ${index + 1}`,
        opacity: 1,
        type: "group",
        visible: true,
        x: 0,
        y: 0,
      }),
    );
    map.nextlayerid = 10_001;
    const harness = await createHarness(roots, map);

    await expect(
      plan(harness.service, {
        type: "duplicateLayer",
        layerId: 1,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_LIMIT_EXCEEDED",
      details: {
        limit: 10_000,
      },
    });
  });

  it("rejects duplication beyond the 100,000-object map limit", async () => {
    const map = boundaryMap();
    map.layers = [
      objectLayer(1, "Source", [
        rectangleObject(1, "Source object"),
      ]),
      objectLayer(
        2,
        "Existing objects",
        Array.from(
          { length: 99_999 },
          (_, index) =>
            rectangleObject(
              index + 2,
              `Object ${index + 2}`,
            ),
        ),
      ),
    ];
    map.nextlayerid = 3;
    map.nextobjectid = 100_001;
    const harness = await createHarness(roots, map);

    await expect(
      plan(harness.service, {
        type: "duplicateLayer",
        layerId: 1,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "OBJECT_LIMIT_EXCEEDED",
      details: {
        limit: 100_000,
      },
    });
  });

  it("bounds the number of objects copied by one operation", async () => {
    const map = boundaryMap();
    map.layers = [
      objectLayer(
        1,
        "Source",
        Array.from(
          { length: 10_001 },
          (_, index) =>
            rectangleObject(
              index + 1,
              `Object ${index + 1}`,
            ),
        ),
      ),
    ];
    map.nextlayerid = 2;
    map.nextobjectid = 10_002;
    const harness = await createHarness(roots, map);

    await expect(
      plan(harness.service, {
        type: "duplicateLayer",
        layerId: 1,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        actual: 10_001,
        limit: 10_000,
      },
    });
  });

  it("rejects exhausted layer and object ID high-water marks", async () => {
    const layerMap = baseMap();
    layerMap.nextlayerid = 0x7fff_ffff;
    const layerHarness = await createHarness(roots, layerMap);
    await expect(
      plan(layerHarness.service, {
        type: "duplicateLayer",
        layerId: TILE_LAYER_ID,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "LAYER_ID_EXHAUSTED",
    });

    const objectMap = baseMap();
    objectMap.nextobjectid = 0x7fff_ffff;
    const objectHarness = await createHarness(roots, objectMap);
    await expect(
      plan(objectHarness.service, {
        type: "duplicateLayer",
        layerId: OBJECT_LAYER_ID,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "OBJECT_ID_EXHAUSTED",
    });
  });

  it("rejects a tile-layer copy over the cell allocation limit", async () => {
    const map = baseMap();
    const layer = requireLayer(map, TILE_LAYER_ID);
    layer.width = 100_001;
    layer.height = 1;
    layer.data = Array.from({ length: 100_001 }, () => 0);
    map.width = 100_001;
    map.height = 1;
    const harness = await createHarness(roots, map);

    await expect(
      plan(harness.service, {
        type: "duplicateLayer",
        layerId: TILE_LAYER_ID,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        limit: 100_000,
        actual: 100_001,
      },
    });
  });

  it("rejects a serialized duplicate over the byte limit", async () => {
    const map = baseMap();
    requireLayer(map, TILE_LAYER_ID).vendorPadding =
      "x".repeat(MAX_DUPLICATE_LAYER_BYTES);
    const harness = await createHarness(roots, map);

    await expect(
      plan(harness.service, {
        type: "duplicateLayer",
        layerId: TILE_LAYER_ID,
      }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        limit: MAX_DUPLICATE_LAYER_BYTES,
      },
    });
  });

  it("bounds layer and object ID mapping samples independently", async () => {
    const map = baseMap();
    const group = requireLayer(map, SOURCE_GROUP_ID);
    group.name = `${"🧩".repeat(128)}extra`;
    group.layers = Array.from(
      { length: 40 },
      (_, index): JsonObject => ({
        draworder: "topdown",
        id: 100 + index,
        name: `Objects ${index}`,
        objects: [
          rectangleObject(1_000 + index, `Object ${index}`),
        ],
        opacity: 1,
        type: "objectgroup",
        visible: true,
        x: 0,
        y: 0,
      }),
    );
    map.nextlayerid = 200;
    map.nextobjectid = 2_000;
    const harness = await createHarness(roots, map);

    const duplicatePlan = await plan(harness.service, {
      type: "duplicateLayer",
      layerId: SOURCE_GROUP_ID,
    });
    const duplicate =
      duplicatePlan.summary.duplicatedLayers?.[0];
    expect(duplicate).toMatchObject({
      name: "🧩".repeat(128),
      nameTruncated: true,
      copiedLayerCount: 41,
      descendantLayerCount: 40,
      copiedObjectCount: 40,
      omittedLayerMappingCount: 9,
      omittedObjectMappingCount: 8,
    });
    expect(duplicate?.layerIdMappingSample).toHaveLength(32);
    expect(duplicate?.objectIdMappingSample).toHaveLength(32);
    expect(duplicate?.layerIdMappingSample[0]).toEqual({
      from: SOURCE_GROUP_ID,
      to: 200,
    });
    expect(duplicate?.objectIdMappingSample[0]).toEqual({
      from: 1_000,
      to: 2_000,
    });
  });

  it("preserves existing BOM/CRLF/unknown lexemes and inserts a compact semantic copy", async () => {
    const harness = await createHarness(roots);
    const absolutePath = join(harness.root, MAP_PATH);
    const lexicalMap = baseMap();
    requireLayer(
      lexicalMap,
      TILE_LAYER_ID,
    ).vendorFutureNumber = 100;
    const source =
      `\uFEFF${serializeJsonDocument(lexicalMap)
        .toString("utf8")
        .replace(
          '"vendorFutureNumber": 100',
          '"vendorFutureNumber": 1e+2',
        )
        .replace(/\n/gu, "\r\n")}`;
    await writeFile(absolutePath, source, "utf8");
    const beforeMap = JSON.parse(
      source.replace(/^\uFEFF/u, ""),
    ) as JsonObject;
    const sourceLayerBefore = sourceValueAt(
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

    const duplicatePlan = await plan(harness.service, {
      type: "duplicateLayer",
      layerId: TILE_LAYER_ID,
    });
    await harness.service.applyEdits(duplicatePlan);

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
    ).toBe(sourceLayerBefore);
    expect(
      sourceValueAt(
        after,
        requireLayerPath(afterMap, OBJECT_LAYER_ID),
      ),
    ).toBe(siblingBefore);
    expect(
      sourceValueAt(after, ["vendorRootExtension"]),
    ).toBe(rootExtensionBefore);

    const inserted = sourceValueAt(
      after,
      requireLayerPath(afterMap, FIRST_CREATED_LAYER_ID),
    );
    expect(inserted).toBe(
      JSON.stringify(
        requireLayer(afterMap, FIRST_CREATED_LAYER_ID),
      ),
    );
    expect(inserted).not.toContain("\r\n");
    expect(inserted).toContain('"vendorFutureNumber":100');
    expect(sourceLayerBefore).toContain(
      '"vendorFutureNumber": 1e+2',
    );
  });

  it("rejects tampered, stale-map and stale-dependency plans without changing map bytes", async () => {
    const tamperHarness = await createHarness(roots);
    const tampered = structuredClone(
      await plan(tamperHarness.service, {
        type: "duplicateLayer",
        layerId: TILE_LAYER_ID,
      }),
    );
    (
      tampered.operations[0] as DuplicateLayerOperation
    ).name = "Tampered";
    const tamperPath = join(tamperHarness.root, MAP_PATH);
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
      type: "duplicateLayer",
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
    expect(await readFile(stalePath)).toEqual(externalBytes);

    const dependencyHarness = await createHarness(roots);
    const dependencyPlan = await plan(
      dependencyHarness.service,
      {
        type: "duplicateLayer",
        layerId: GROUP_OBJECT_LAYER_ID,
      },
    );
    const dependencyMapPath = join(
      dependencyHarness.root,
      MAP_PATH,
    );
    const beforeDependencyChange = await readFile(
      dependencyMapPath,
    );
    const changedTileset = tileset();
    changedTileset.vendorExternalEdit = true;
    await writeJson(
      join(
        dependencyHarness.root,
        "tiles",
        "terrain.tsj",
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
    expect(await readFile(dependencyMapPath)).toEqual(
      beforeDependencyChange,
    );
  });

  it.skipIf(!hasTiledCli)("survives a real Tiled 1.12 JSON export round-trip when the CLI is available", async () => {
    const harness = await createHarness(roots);
    const duplicatePlan = await plan(harness.service, {
      type: "duplicateLayer",
      layerId: SOURCE_GROUP_ID,
      name: "Gameplay Copy",
    });
    await harness.service.applyEdits(duplicatePlan);

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
    expect(requireLayer(exported, 20).name).toBe(
      "Gameplay Copy",
    );
    expect(layerChildIds(exported, 20)).toEqual([21, 22]);
    expect(layerChildIds(exported, 22)).toEqual([23, 24]);
    const copiedObjects = requireLayer(
      exported,
      23,
    ).objects as JsonObject[];
    expect(copiedObjects.map((object) => object.id)).toEqual([
      30, 31,
    ]);
    expect(
      propertyValue(
        copiedObjects[0]?.properties as JsonObject[],
        "partner",
      ),
    ).toBe(31);
    expect(copiedObjects[1]?.gid).toBe(TRANSFORMED_GID);
    expect(exported.nextlayerid).toBe(25);
    expect(exported.nextobjectid).toBe(32);
  }, 40_000);
});

async function createHarness(
  roots: Set<string>,
  map: JsonObject = baseMap(),
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-duplicate-layer-"),
  );
  roots.add(root);
  await Promise.all(
    ["maps", "tiles", "images", "scripts"].map(
      async (directory) => {
        await mkdir(join(root, directory));
      },
    ),
  );
  await writeJson(join(root, MAP_PATH), map);
  await writeJson(
    join(root, "tiles", "terrain.tsj"),
    tileset(),
  );
  await writeFile(
    join(root, "images", "tiles.svg"),
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">',
      '<rect width="16" height="16" fill="#557755"/>',
      '<rect x="16" width="16" height="16" fill="#775555"/>',
      '<rect y="16" width="16" height="16" fill="#555577"/>',
      '<rect x="16" y="16" width="16" height="16" fill="#777755"/>',
      "</svg>",
    ].join(""),
    "utf8",
  );
  await writeFile(
    join(root, "images", "backdrop.svg"),
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16">',
      '<rect width="32" height="16" fill="#334455"/>',
      "</svg>",
    ].join(""),
    "utf8",
  );
  await writeFile(
    join(root, "scripts", "behavior.lua"),
    "return { enabled = true }\n",
    "utf8",
  );
  const resolver = await ProjectPathResolver.create(root);
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
      tileLayer(TILE_LAYER_ID, "Ground", [1, 0, 2, 0]),
      objectLayer(OBJECT_LAYER_ID, "Actors", [
        referencedObject(10, 11),
        tileObject(11),
      ]),
      objectLayer(
        EXTERNAL_OBJECT_LAYER_ID,
        "External objects",
        [rectangleObject(EXTERNAL_OBJECT_ID, "External")],
      ),
      imageLayer(IMAGE_LAYER_ID, "Backdrop"),
      {
        id: SOURCE_GROUP_ID,
        layers: [
          tileLayer(
            GROUP_TILE_LAYER_ID,
            "Gameplay tiles",
            [0, 1, 0, 2],
          ),
          {
            id: NESTED_GROUP_ID,
            layers: [
              objectLayer(
                GROUP_OBJECT_LAYER_ID,
                "Gameplay objects",
                [
                  referencedObject(12, 13, true),
                  tileObject(13),
                ],
              ),
              imageLayer(
                GROUP_IMAGE_LAYER_ID,
                "Group backdrop",
              ),
            ],
            name: "Nested gameplay",
            opacity: 1,
            type: "group",
            visible: true,
            x: 0,
            y: 0,
          },
        ],
        locked: true,
        name: "Gameplay",
        opacity: 1,
        type: "group",
        visible: true,
        x: 0,
        y: 0,
      },
      {
        id: TARGET_GROUP_ID,
        layers: [
          tileLayer(
            TARGET_CHILD_LAYER_ID,
            "Target child",
            [0, 0, 0, 0],
          ),
        ],
        name: "Target",
        opacity: 1,
        type: "group",
        visible: true,
        x: 0,
        y: 0,
      },
      {
        id: LOCKED_TARGET_GROUP_ID,
        layers: [],
        locked: true,
        name: "Locked target",
        opacity: 1,
        type: "group",
        visible: true,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: FIRST_CREATED_LAYER_ID,
    nextobjectid: FIRST_CREATED_OBJECT_ID,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [
      { firstgid: 1, source: "../tiles/terrain.tsj" },
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

function tileLayer(
  id: number,
  name: string,
  data: number[],
): JsonObject {
  return {
    data,
    height: 2,
    id,
    name,
    opacity: 1,
    type: "tilelayer",
    vendorTileExtension: {
      preserve: ["tile", id],
    },
    visible: true,
    width: 2,
    x: 0,
    y: 0,
  };
}

function objectLayer(
  id: number,
  name: string,
  objects: JsonObject[],
): JsonObject {
  return {
    draworder: "topdown",
    id,
    name,
    objects,
    opacity: 1,
    type: "objectgroup",
    visible: true,
    x: 0,
    y: 0,
  };
}

function imageLayer(id: number, name: string): JsonObject {
  return {
    id,
    image: "../images/backdrop.svg",
    name,
    opacity: 1,
    type: "imagelayer",
    visible: true,
    x: 0,
    y: 0,
  };
}

function rectangleObject(
  id: number,
  name: string,
): JsonObject {
  return {
    height: 8,
    id,
    name,
    rotation: 0,
    type: "",
    visible: true,
    width: 8,
    x: id,
    y: id,
  };
}

function referencedObject(
  id: number,
  partnerId: number,
  withFile = false,
): JsonObject {
  const object = rectangleObject(id, `Referenced ${id}`);
  object.properties = [
    {
      name: "partner",
      type: "object",
      value: partnerId,
    },
    {
      name: "targets",
      type: "list",
      value: [
        { type: "object", value: id },
        {
          type: "object",
          value: EXTERNAL_OBJECT_ID,
        },
        { type: "object", value: 0 },
      ],
    },
    ...(withFile
      ? [
          {
            name: "script",
            type: "file",
            value: "../scripts/behavior.lua",
          },
        ]
      : []),
  ];
  return object;
}

function tileObject(id: number): JsonObject {
  return {
    gid: TRANSFORMED_GID,
    height: 16,
    id,
    name: `Tile ${id}`,
    rotation: 0,
    type: "",
    visible: true,
    width: 16,
    x: 16,
    y: 16,
  };
}

function tileset(): JsonObject {
  return {
    columns: 2,
    image: "../images/tiles.svg",
    imageheight: 32,
    imagewidth: 32,
    margin: 0,
    name: "Terrain",
    spacing: 0,
    tilecount: 4,
    tiledversion: "1.12.2",
    tileheight: 16,
    tilewidth: 16,
    type: "tileset",
    version: "1.10",
  };
}

function depthBoundaryMap(): JsonObject {
  const movable: JsonObject = {
    id: 1,
    layers: [
      {
        id: 2,
        layers: [],
        name: "Movable child",
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

function boundaryMap(): JsonObject {
  return {
    compressionlevel: -1,
    height: 1,
    infinite: false,
    layers: [],
    nextlayerid: 1,
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
    | DuplicateLayerOperation
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

function propertyValue(
  properties: JsonObject[],
  name: string,
): JsonValue | undefined {
  return properties.find(
    (property) => property.name === name,
  )?.value;
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
