import { createHash } from "node:crypto";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  ChangeSetRegistry,
  DEFAULT_MAX_PENDING_OBJECT_SHAPE_POINTS,
  type ChangeSetApplyResult,
} from "../src/changeSets.js";
import {
  stableJson,
  type JsonValue,
} from "../src/formats/json.js";
import type {
  MapEditOperation,
  MapEditPlan,
} from "../src/maps/types.js";

const MAP_PATH = "maps/shape-budget.tmj";
const BASE_REVISION = `sha256:${"0".repeat(64)}`;
const APPLIED_REVISION = `sha256:${"1".repeat(64)}`;

describe("ChangeSetRegistry object shape-point budget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports the bounded pending default", () => {
    expect(
      DEFAULT_MAX_PENDING_OBJECT_SHAPE_POINTS,
    ).toBe(65_536);
  });

  it("accepts the exact limit and rejects one point over it", () => {
    const atLimit = new ChangeSetRegistry(
      60_000,
      4,
      0,
      5,
    );
    expect(() =>
      atLimit.put(
        mapEditPlan([createPath("polygon", 5)]),
      ),
    ).not.toThrow();

    const overLimit = new ChangeSetRegistry(
      60_000,
      4,
      0,
      5,
    );
    expect(() =>
      overLimit.put(
        mapEditPlan([createPath("polygon", 6)]),
      ),
    ).toThrow(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "CHANGE_SET_LIMIT_EXCEEDED",
        message: expect.stringContaining(
          "shape-point budget",
        ),
        details: expect.objectContaining({
          limit: 5,
          pendingObjectShapePoints: 0,
          requestedObjectShapePoints: 6,
        }),
      }),
    );
  });

  it("aggregates points across pending map-edit entries", () => {
    const registry = new ChangeSetRegistry(
      60_000,
      4,
      0,
      5,
    );
    registry.put(
      mapEditPlan([createPath("polygon", 3)]),
    );
    expect(() =>
      registry.put(
        mapEditPlan([createPath("polyline", 2)]),
      ),
    ).not.toThrow();

    expect(() =>
      registry.put(
        mapEditPlan([createPath("polyline", 2)]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "CHANGE_SET_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          limit: 5,
          pendingObjectShapePoints: 5,
          requestedObjectShapePoints: 2,
        }),
      }),
    );
  });

  it("charges update-only point replacements", () => {
    const registry = new ChangeSetRegistry(
      60_000,
      4,
      0,
      2,
    );

    expect(() =>
      registry.put(
        mapEditPlan([updatePath(41, 2)]),
      ),
    ).not.toThrow();
    expect(() =>
      registry.put(
        mapEditPlan([updatePath(42, 2)]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "CHANGE_SET_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          limit: 2,
          pendingObjectShapePoints: 2,
          requestedObjectShapePoints: 2,
        }),
      }),
    );
  });

  it("charges mixed creates and every update without net-state discounts", () => {
    const exact = new ChangeSetRegistry(
      60_000,
      4,
      0,
      5,
    );
    expect(() =>
      exact.put(
        mapEditPlan([
          createPath("polygon", 3),
          updatePath(1, 2),
        ]),
      ),
    ).not.toThrow();

    const noDiscount = new ChangeSetRegistry(
      60_000,
      4,
      0,
      6,
    );
    expect(() =>
      noDiscount.put(
        mapEditPlan([
          createPath("polygon", 3),
          updatePath(1, 2),
          updatePath(1, 2),
          {
            type: "deleteObjects",
            objectIds: [1],
          },
        ]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "CHANGE_SET_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          limit: 6,
          pendingObjectShapePoints: 0,
          requestedObjectShapePoints: 7,
        }),
      }),
    );
  });

  it("rejects a forged mixed plan above the per-change-set point limit before retaining it", () => {
    const fullPayloadCount = 256;
    const operations: MapEditOperation[] = [
      ...Array.from(
        { length: 31 },
        (): MapEditOperation =>
          createPath(
            "polyline",
            fullPayloadCount,
          ),
      ),
      updatePath(1, 255),
      updatePath(1, 2),
    ];
    const registry = new ChangeSetRegistry(
      60_000,
      4,
      0,
      8_193,
    );

    expect(() =>
      registry.put(mapEditPlan(operations)),
    ).toThrow(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "INVALID_CHANGE_SET",
        details: {
          actual: 8_193,
          limit: 8_192,
        },
      }),
    );
    expect(() =>
      registry.put(
        mapEditPlan([updatePath(2, 2)]),
      ),
    ).not.toThrow();
  });

  it("accepts coordinate bounds exactly", () => {
    const operation = updatePath(41, 2);
    const points = (
      operation as unknown as {
        patch: {
          points: Array<{
            x: number;
            y: number;
          }>;
        };
      }
    ).patch.points;
    points[0] = {
      x: -1_000_000_000,
      y: 1_000_000_000,
    };
    points[1] = {
      x: 1_000_000_000,
      y: -1_000_000_000,
    };

    expect(() =>
      new ChangeSetRegistry(
        60_000,
        4,
        0,
        2,
      ).put(mapEditPlan([operation])),
    ).not.toThrow();
  });

  it("does not let source-plan or returned-preview aliases mutate an update charge", () => {
    const registry = new ChangeSetRegistry(
      60_000,
      4,
      0,
      2,
    );
    const plan = mapEditPlan([
      updatePath(41, 2),
    ]);
    const preview = registry.put(plan);
    const sourceOperation = plan
      .operations[0] as unknown as {
      patch: {
        points: Array<{ x: number; y: number }>;
      };
    };
    const previewOperation = preview
      .operations[0] as {
      patch: {
        points: Array<{ x: number; y: number }>;
      };
    };
    sourceOperation.patch.points.length = 0;
    previewOperation.patch.points.length = 0;

    expect(() =>
      registry.put(
        mapEditPlan([updatePath(42, 2)]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "CHANGE_SET_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          limit: 2,
          pendingObjectShapePoints: 2,
          requestedObjectShapePoints: 2,
        }),
      }),
    );
  });

  it("does not let returned create-preview aliases mutate the pending budget", () => {
    const registry = new ChangeSetRegistry(
      60_000,
      4,
      0,
      3,
    );
    const preview = registry.put(
      mapEditPlan([createPath("polygon", 3)]),
    );
    const operation = preview.operations[0] as {
      object: {
        shape: string;
        points: Array<{ x: number; y: number }>;
      };
    };
    operation.object.shape = "rectangle";
    operation.object.points.length = 0;

    expect(() =>
      registry.put(
        mapEditPlan([createPath("polygon", 3)]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "CHANGE_SET_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          limit: 3,
          pendingObjectShapePoints: 3,
          requestedObjectShapePoints: 3,
        }),
      }),
    );
  });

  it("releases points after a successful apply scrubs the plan", async () => {
    const registry = new ChangeSetRegistry(
      60_000,
      4,
      0,
      3,
    );
    const preview = registry.put(
      mapEditPlan([createPath("polygon", 3)]),
    );

    await applyMapEdit(registry, preview);

    expect(() =>
      registry.put(
        mapEditPlan([createPath("polygon", 3)]),
      ),
    ).not.toThrow();
  });

  it("retains update points after failed apply and releases them after a successful retry", async () => {
    const registry = new ChangeSetRegistry(
      60_000,
      4,
      0,
      2,
    );
    const preview = registry.put(
      mapEditPlan([updatePath(41, 2)]),
    );

    await expect(
      registry.apply(
        preview.changeSetId,
        preview.expectedRevision,
        async () => {
          throw new Error("expected failure");
        },
      ),
    ).rejects.toThrow("expected failure");
    expect(() =>
      registry.put(
        mapEditPlan([updatePath(42, 2)]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "CHANGE_SET_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          pendingObjectShapePoints: 2,
        }),
      }),
    );

    await applyMapEdit(registry, preview);
    expect(() =>
      registry.put(
        mapEditPlan([updatePath(42, 2)]),
      ),
    ).not.toThrow();
  });

  it("retains update points while apply is in flight even after its TTL passes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(
      new Date("2026-07-25T00:00:00.000Z"),
    );
    const registry = new ChangeSetRegistry(
      1_000,
      4,
      0,
      2,
    );
    const preview = registry.put(
      mapEditPlan([updatePath(41, 2)]),
    );
    let resolveApply:
      | ((
          result: ChangeSetApplyResult,
        ) => void)
      | undefined;
    const deferred =
      new Promise<ChangeSetApplyResult>(
        (resolve) => {
          resolveApply = resolve;
        },
      );
    const applying = registry.apply(
      preview.changeSetId,
      preview.expectedRevision,
      async () => deferred,
    );

    vi.advanceTimersByTime(1_001);
    expect(() =>
      registry.put(
        mapEditPlan([updatePath(42, 2)]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "CHANGE_SET_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          pendingObjectShapePoints: 2,
        }),
      }),
    );

    resolveApply?.(commitResult());
    await applying;
    expect(() =>
      registry.put(
        mapEditPlan([updatePath(42, 2)]),
      ),
    ).not.toThrow();
  });

  it("releases points when an expired entry is pruned", () => {
    vi.useFakeTimers();
    vi.setSystemTime(
      new Date("2026-07-25T00:00:00.000Z"),
    );
    const registry = new ChangeSetRegistry(
      1_000,
      4,
      0,
      3,
    );
    registry.put(
      mapEditPlan([createPath("polygon", 3)]),
    );

    vi.advanceTimersByTime(1_001);

    expect(() =>
      registry.put(
        mapEditPlan([createPath("polygon", 3)]),
      ),
    ).not.toThrow();
  });

  it("does not charge rectangle, point, ellipse or capsule drafts", () => {
    const registry = new ChangeSetRegistry(
      60_000,
      4,
      0,
      0,
    );
    const operations: MapEditOperation[] = [
      {
        type: "createObject",
        layerId: 1,
        object: {
          shape: "rectangle",
          x: 0,
          y: 0,
        },
      },
      {
        type: "createObject",
        layerId: 1,
        object: {
          shape: "point",
          x: 1,
          y: 1,
        },
      },
      {
        type: "createObject",
        layerId: 1,
        object: {
          shape: "ellipse",
          x: 2,
          y: 2,
        },
      },
      {
        type: "createObject",
        layerId: 1,
        object: {
          shape: "capsule",
          x: 3,
          y: 3,
        },
      },
    ];

    expect(() =>
      registry.put(mapEditPlan(operations)),
    ).not.toThrow();
  });

  it.each([
    {
      name: "non-array create points",
      operation: {
        type: "createObject",
        layerId: 1,
        object: {
          shape: "polygon",
          x: 0,
          y: 0,
          points: "not-an-array",
        },
      },
    },
    {
      name: "polygon with only two points",
      operation: createPath("polygon", 2),
    },
    {
      name: "polyline with only one point",
      operation: createPath("polyline", 1),
    },
    {
      name: "create with more than 256 points",
      operation: createPath("polygon", 257),
    },
    {
      name: "non-path create with points",
      operation: {
        type: "createObject",
        layerId: 1,
        object: {
          shape: "rectangle",
          x: 0,
          y: 0,
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      },
    },
    {
      name: "non-record update patch",
      operation: {
        type: "updateObject",
        objectId: 1,
        patch: "not-an-object",
      },
    },
    {
      name: "non-array update points",
      operation: {
        type: "updateObject",
        objectId: 1,
        patch: {
          points: null,
        },
      },
    },
    {
      name: "update with only one point",
      operation: updatePath(1, 1),
    },
    {
      name: "update with more than 256 points",
      operation: updatePath(1, 257),
    },
    {
      name: "point missing y",
      operation: forgedPointUpdate({
        x: 0,
      }),
    },
    {
      name: "point with an extra key",
      operation: forgedPointUpdate({
        x: 0,
        y: 0,
        z: 0,
      }),
    },
    {
      name: "non-finite point coordinate",
      operation: forgedPointUpdate({
        x: Number.POSITIVE_INFINITY,
        y: 0,
      }),
    },
    {
      name: "out-of-range point coordinate",
      operation: forgedPointUpdate({
        x: 1_000_000_001,
        y: 0,
      }),
    },
    {
      name: "nested point coordinate",
      operation: forgedPointUpdate({
        x: { nested: true },
        y: 0,
      }),
    },
  ])(
    "maps forged $name failures to INVALID_CHANGE_SET",
    ({ operation }) => {
      expect(() =>
        new ChangeSetRegistry(
          60_000,
          4,
          0,
          1_000,
        ).put(
          mapEditPlan([
            operation as unknown as MapEditOperation,
          ]),
        ),
      ).toThrow(
        expect.objectContaining({
          name: "TiledMcpError",
          code: "INVALID_CHANGE_SET",
        }),
      );
    },
  );

  it("rejects forged non-array operations with INVALID_CHANGE_SET", () => {
    const malformed = mapEditPlan([]);
    (
      malformed as unknown as {
        operations: unknown;
      }
    ).operations = "not-an-array";
    malformed.id = planId(malformed);

    expect(() =>
      new ChangeSetRegistry(
        60_000,
        4,
        0,
        1_000,
      ).put(malformed),
    ).toThrow(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "INVALID_CHANGE_SET",
        message: expect.stringContaining(
          "malformed operations",
        ),
      }),
    );
  });
});

function createPath(
  shape: "polygon" | "polyline",
  pointCount: number,
): MapEditOperation {
  return {
    type: "createObject",
    layerId: 1,
    object: {
      shape,
      x: 0,
      y: 0,
      points: Array.from(
        { length: pointCount },
        (_, index) => ({ x: index, y: -index }),
      ),
    },
  };
}

function updatePath(
  objectId: number,
  pointCount: number,
): MapEditOperation {
  return {
    type: "updateObject",
    objectId,
    patch: {
      points: Array.from(
        { length: pointCount },
        (_, index) => ({
          x: index,
          y: -index,
        }),
      ),
    },
  };
}

function forgedPointUpdate(
  point: Record<string, unknown>,
): MapEditOperation {
  return {
    type: "updateObject",
    objectId: 1,
    patch: {
      points: [
        point,
        { x: 1, y: 1 },
      ],
    },
  } as unknown as MapEditOperation;
}

function mapEditPlan(
  operations: MapEditOperation[],
): MapEditPlan {
  const createdObjectIds =
    operations.flatMap((operation, index) =>
      operation.type === "createObject"
        ? [index + 1]
        : [],
    );
  const updatedObjectIds = [
    ...new Set(
      operations.flatMap((operation) =>
        operation.type === "updateObject"
          ? [operation.objectId]
          : [],
      ),
    ),
  ];
  const deletedObjectIds = [
    ...new Set(
      operations.flatMap((operation) =>
        operation.type === "deleteObjects"
          ? operation.objectIds
          : [],
      ),
    ),
  ];
  const unsigned: Omit<MapEditPlan, "id"> = {
    kind: "mapEdit",
    version: 1,
    mapPath: MAP_PATH,
    baseRevision: BASE_REVISION,
    dependencyRevisions: {},
    operations,
    summary: {
      operationCount: operations.length,
      cellWrites: 0,
      affectedLayerIds: [1],
      affectedTileLayerIds: [],
      affectedObjectLayerIds: [1],
      createdObjectIds,
      updatedObjectIds,
      deletedObjectIds,
    },
  };
  return {
    ...unsigned,
    id: digest(unsigned),
  };
}

function planId(plan: MapEditPlan): string {
  const { id: _id, ...unsigned } = plan;
  return digest(unsigned);
}

function digest(
  unsigned: Omit<MapEditPlan, "id">,
): string {
  return `changeset:${createHash("sha256")
    .update(
      stableJson(
        unsigned as unknown as JsonValue,
      ),
    )
    .digest("hex")}`;
}

async function applyMapEdit(
  registry: ChangeSetRegistry,
  preview: {
    changeSetId: string;
    expectedRevision: string;
  },
): Promise<void> {
  await registry.apply(
    preview.changeSetId,
    preview.expectedRevision,
    async () => commitResult(),
  );
}

function commitResult(): ChangeSetApplyResult {
  return {
    path: MAP_PATH,
    beforeRevision: BASE_REVISION,
    revision: APPLIED_REVISION,
    checkpointId: null,
    changed: true,
    changeSetId: "operation-result",
  };
}
