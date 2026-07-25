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
  DEFAULT_MAX_PENDING_TEXT_OBJECT_PAYLOAD_BYTES,
  type ChangeSetApplyResult,
} from "../src/changeSets.js";
import {
  stableJson,
  type JsonValue,
} from "../src/formats/json.js";
import {
  measureTextObjectPayloadBytes,
} from "../src/maps/textObjects.js";
import type {
  MapEditOperation,
  MapEditPlan,
} from "../src/maps/types.js";

const MAP_PATH = "maps/text-payload-budget.tmj";
const BASE_REVISION = `sha256:${"0".repeat(64)}`;
const APPLIED_REVISION = `sha256:${"1".repeat(64)}`;

describe("ChangeSetRegistry text-object payload budget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports the bounded pending default", () => {
    expect(
      DEFAULT_MAX_PENDING_TEXT_OBJECT_PAYLOAD_BYTES,
    ).toBe(2_097_152);
  });

  it("accepts the exact byte limit and rejects one byte over it", () => {
    const exactOperation = createText("a");
    const overOperation = createText("aa");
    const exactBytes = textPayloadBytes({
      text: "a",
    });
    expect(
      textPayloadBytes({ text: "aa" }),
    ).toBe(exactBytes + 1);

    expect(() =>
      registryWithTextBudget(exactBytes).put(
        mapEditPlan([exactOperation]),
      ),
    ).not.toThrow();

    expect(() =>
      registryWithTextBudget(exactBytes).put(
        mapEditPlan([overOperation]),
      ),
    ).toThrow(
      expect.objectContaining({
        name: "TiledMcpError",
        code: "CHANGE_SET_LIMIT_EXCEEDED",
        message: expect.stringContaining(
          "text-object payload budget",
        ),
        details: {
          limit: exactBytes,
          pendingTextObjectPayloadBytes: 0,
          requestedTextObjectPayloadBytes:
            exactBytes + 1,
        },
      }),
    );
  });

  it("charges every create and update operation separately", () => {
    const createBytes = textPayloadBytes({
      text: "a",
    });
    const updateBytes = textPayloadBytes({
      bold: true,
    });
    const requestedBytes =
      createBytes + updateBytes;
    const plan = mapEditPlan([
      createText("a"),
      updateText(41, { bold: true }),
    ]);

    expect(() =>
      registryWithTextBudget(
        requestedBytes - 1,
      ).put(plan),
    ).toThrow(
      expect.objectContaining({
        code: "CHANGE_SET_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          pendingTextObjectPayloadBytes: 0,
          requestedTextObjectPayloadBytes:
            requestedBytes,
        }),
      }),
    );
    expect(() =>
      registryWithTextBudget(
        requestedBytes,
      ).put(plan),
    ).not.toThrow();
  });

  it("aggregates the cached byte count across pending entries", () => {
    const firstBytes = textPayloadBytes({
      text: "a",
    });
    const secondBytes = textPayloadBytes({
      italic: true,
    });
    const thirdBytes = textPayloadBytes({
      text: "",
    });
    const registry = registryWithTextBudget(
      firstBytes + secondBytes,
    );

    registry.put(
      mapEditPlan([createText("a")]),
    );
    registry.put(
      mapEditPlan([
        updateText(1, { italic: true }),
      ]),
    );

    expect(() =>
      registry.put(
        mapEditPlan([createText("")]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "CHANGE_SET_LIMIT_EXCEEDED",
        details: {
          limit: firstBytes + secondBytes,
          pendingTextObjectPayloadBytes:
            firstBytes + secondBytes,
          requestedTextObjectPayloadBytes:
            thirdBytes,
        },
      }),
    );
  });

  it("does not charge non-text creates or updates without text fields", () => {
    const operations = [
      {
        type: "createObject",
        layerId: 1,
        object: {
          shape: "rectangle",
          x: 0,
          y: 0,
          text:
            "present but not chargeable without shape=text",
        },
      },
      {
        type: "updateObject",
        objectId: 1,
        patch: {
          x: 4,
          name: "ordinary object metadata",
        },
      },
    ] as unknown as MapEditOperation[];

    expect(() =>
      registryWithTextBudget(0).put(
        mapEditPlan(operations),
      ),
    ).not.toThrow();
  });

  it("does not let source-plan or returned-preview aliases lower the cached charge", () => {
    const bytes = textPayloadBytes({
      text: "retained",
    });
    const registry =
      registryWithTextBudget(bytes);
    const plan = mapEditPlan([
      createText("retained"),
    ]);
    const preview = registry.put(plan);

    (
      plan.operations[0] as unknown as {
        object: { text: string };
      }
    ).object.text = "";
    (
      preview.operations[0] as {
        object: { text: string };
      }
    ).object.text = "";

    expect(() =>
      registry.put(
        mapEditPlan([
          createText("retained"),
        ]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "CHANGE_SET_LIMIT_EXCEEDED",
        details: {
          limit: bytes,
          pendingTextObjectPayloadBytes: bytes,
          requestedTextObjectPayloadBytes: bytes,
        },
      }),
    );
  });

  it("releases bytes after successful apply scrubs the plan", async () => {
    const bytes = textPayloadBytes({
      text: "released",
    });
    const registry =
      registryWithTextBudget(bytes);
    const preview = registry.put(
      mapEditPlan([createText("released")]),
    );

    await applyMapEdit(registry, preview);

    expect(() =>
      registry.put(
        mapEditPlan([
          createText("released"),
        ]),
      ),
    ).not.toThrow();
  });

  it("retains bytes after failed apply and permits a successful retry to release them", async () => {
    const bytes = textPayloadBytes({
      text: "retry",
    });
    const registry =
      registryWithTextBudget(bytes);
    const preview = registry.put(
      mapEditPlan([createText("retry")]),
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
        mapEditPlan([createText("retry")]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "CHANGE_SET_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          pendingTextObjectPayloadBytes: bytes,
        }),
      }),
    );

    await applyMapEdit(registry, preview);
    expect(() =>
      registry.put(
        mapEditPlan([createText("retry")]),
      ),
    ).not.toThrow();
  });

  it("retains bytes while apply is in flight", async () => {
    const bytes = textPayloadBytes({
      text: "in-flight",
    });
    const registry =
      registryWithTextBudget(bytes);
    const preview = registry.put(
      mapEditPlan([
        createText("in-flight"),
      ]),
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

    expect(() =>
      registry.put(
        mapEditPlan([
          createText("in-flight"),
        ]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "CHANGE_SET_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          pendingTextObjectPayloadBytes: bytes,
        }),
      }),
    );

    resolveApply?.(commitResult());
    await applying;
    expect(() =>
      registry.put(
        mapEditPlan([
          createText("in-flight"),
        ]),
      ),
    ).not.toThrow();
  });

  it("releases bytes when an expired entry is pruned", () => {
    vi.useFakeTimers();
    vi.setSystemTime(
      new Date("2026-07-25T00:00:00.000Z"),
    );
    const bytes = textPayloadBytes({
      text: "expired",
    });
    const registry = new ChangeSetRegistry(
      1_000,
      4,
      0,
      0,
      bytes,
    );
    registry.put(
      mapEditPlan([createText("expired")]),
    );

    vi.advanceTimersByTime(1_001);

    expect(() =>
      registry.put(
        mapEditPlan([createText("expired")]),
      ),
    ).not.toThrow();
  });

  it.each([
    {
      name: "invalid text field",
      operation: createText(
        { nested: true } as unknown as string,
      ),
    },
    {
      name: "non-record create draft",
      operation: {
        type: "createObject",
        layerId: 1,
        object: "not-an-object",
      } as unknown as MapEditOperation,
    },
    {
      name: "non-record update patch",
      operation: {
        type: "updateObject",
        objectId: 1,
        patch: "not-an-object",
      } as unknown as MapEditOperation,
    },
    {
      name: "invalid update text field",
      operation: updateText(1, {
        text: null,
      }),
    },
  ])(
    "maps forged $name failures to INVALID_CHANGE_SET",
    ({ operation }) => {
      expect(() =>
        registryWithTextBudget(1_000).put(
          mapEditPlan([operation]),
        ),
      ).toThrow(
        expect.objectContaining({
          name: "TiledMcpError",
          code: "INVALID_CHANGE_SET",
        }),
      );
    },
  );

  it("rejects a forged non-array operation collection with INVALID_CHANGE_SET", () => {
    const malformed = mapEditPlan([]);
    (
      malformed as unknown as {
        operations: unknown;
      }
    ).operations = "not-an-array";
    malformed.id = planId(malformed);

    expect(() =>
      registryWithTextBudget(1_000).put(
        malformed,
      ),
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

function registryWithTextBudget(
  maxPendingTextObjectPayloadBytes: number,
): ChangeSetRegistry {
  return new ChangeSetRegistry(
    60_000,
    16,
    0,
    0,
    maxPendingTextObjectPayloadBytes,
  );
}

function createText(
  text: string,
): MapEditOperation {
  return {
    type: "createObject",
    layerId: 1,
    object: {
      shape: "text",
      x: 0,
      y: 0,
      text,
    },
  } as unknown as MapEditOperation;
}

function updateText(
  objectId: number,
  patch: Record<string, unknown>,
): MapEditOperation {
  return {
    type: "updateObject",
    objectId,
    patch,
  } as unknown as MapEditOperation;
}

function textPayloadBytes(
  payload: Record<string, unknown>,
): number {
  return measureTextObjectPayloadBytes(
    payload,
  );
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
  const updatedObjectIds =
    operations.flatMap((operation) =>
      operation.type === "updateObject"
        ? [operation.objectId]
        : [],
    );
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
      deletedObjectIds: [],
    },
  };
  return {
    ...unsigned,
    id: digest(unsigned),
  };
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

function planId(plan: MapEditPlan): string {
  const { id: _id, ...unsigned } = plan;
  return digest(unsigned);
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
