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

  it("does not let returned preview aliases mutate the pending budget", () => {
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

  it("rejects malformed path points without throwing a runtime TypeError", () => {
    const malformed = mapEditPlan([
      createPath("polygon", 3),
    ]);
    (
      malformed.operations[0] as unknown as {
        object: { points: unknown };
      }
    ).object.points = "not-an-array";
    malformed.id = planId(malformed);

    expect(() =>
      new ChangeSetRegistry(
        60_000,
        4,
        0,
        3,
      ).put(malformed),
    ).toThrow(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "INVALID_CHANGE_SET",
        message: expect.stringContaining(
          "malformed shape points",
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

function mapEditPlan(
  operations: MapEditOperation[],
): MapEditPlan {
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
      createdObjectIds: operations.map(
        (_, index) => index + 1,
      ),
      updatedObjectIds: [],
      deletedObjectIds: [],
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
    async (plan) => {
      if (plan.kind !== "mapEdit") {
        throw new Error(
          "Expected a map-edit plan fixture.",
        );
      }
      return {
        path: plan.mapPath,
        beforeRevision: plan.baseRevision,
        revision: APPLIED_REVISION,
        checkpointId: null,
        changed: true,
        changeSetId: plan.id,
      };
    },
  );
}
