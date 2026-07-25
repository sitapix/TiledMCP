import { describe, expect, it } from "vitest";

import {
  previewEditsToolOutputSchema,
} from "../src/outputSchemas/changeSets.js";

const REVISION =
  `sha256:${"0".repeat(64)}` as const;
const CHANGE_SET_ID =
  `changeset:${"1".repeat(64)}` as const;

function validOutput(): Record<string, unknown> {
  return {
    result: {
      kind: "mapEdit",
      changeSetId: CHANGE_SET_ID,
      planDigest: CHANGE_SET_ID,
      mapPath: "maps/example.tmj",
      expectedRevision: REVISION,
      dependencyRevisions: {},
      operations: [
        {
          type: "createObject",
          layerId: 1,
          shape: "polygon",
          object: {
            shape: "polygon",
            x: 10,
            y: 20,
            points: [
              { x: 0, y: 0 },
              { x: 8, y: -2 },
              { x: 4, y: 6 },
            ],
          },
        },
      ],
      summary: {
        operationCount: 1,
        cellWrites: 0,
        affectedLayerIds: [1],
        affectedTileLayerIds: [],
        affectedObjectLayerIds: [1],
        createdObjectIds: [1],
        updatedObjectIds: [],
        deletedObjectIds: [],
      },
      snapshotConsistency:
        "non-atomic-read-set",
      createdAt: "2026-07-25T00:00:00.000Z",
      expiresAt: "2026-07-25T00:10:00.000Z",
    },
  };
}

function operationOf(
  output: Record<string, unknown>,
): Record<string, unknown> {
  const result = output.result as Record<
    string,
    unknown
  >;
  return (
    result.operations as Array<
      Record<string, unknown>
    >
  )[0] as Record<string, unknown>;
}

function objectOf(
  output: Record<string, unknown>,
): Record<string, unknown> {
  return operationOf(output).object as Record<
    string,
    unknown
  >;
}

function validUpdateOutput(): Record<string, unknown> {
  const output = validOutput();
  const result = output.result as Record<
    string,
    unknown
  >;
  result.operations = [
    {
      type: "updateObject",
      objectId: 7,
      changedFields: ["points"],
      patch: {
        points: [
          { x: 0, y: 0 },
          { x: 8, y: -2 },
        ],
      },
    },
  ];
  const summary = result.summary as Record<
    string,
    unknown
  >;
  summary.createdObjectIds = [];
  summary.updatedObjectIds = [7];
  return output;
}

function patchOf(
  output: Record<string, unknown>,
): Record<string, unknown> {
  return operationOf(output).patch as Record<
    string,
    unknown
  >;
}

describe("polygon/polyline change-set output schema", () => {
  it("accepts a bounded strict path object preview", () => {
    expect(
      previewEditsToolOutputSchema.safeParse(
        validOutput(),
      ).success,
    ).toBe(true);
  });

  it("accepts a bounded strict whole-path update preview", () => {
    expect(
      previewEditsToolOutputSchema.safeParse(
        validUpdateOutput(),
      ).success,
    ).toBe(true);
  });

  it.each([
    {
      name: "outer and object shape mismatch",
      mutate(output: Record<string, unknown>) {
        operationOf(output).shape = "polyline";
      },
    },
    {
      name: "path width injection",
      mutate(output: Record<string, unknown>) {
        objectOf(output).width = 0;
      },
    },
    {
      name: "257-point path",
      mutate(output: Record<string, unknown>) {
        objectOf(output).points = Array.from(
          { length: 257 },
          (_, index) => ({
            x: index,
            y: -index,
          }),
        );
      },
    },
    {
      name: "malformed point",
      mutate(output: Record<string, unknown>) {
        objectOf(output).points = [
          { x: 0, y: 0 },
          { x: 1, y: 0, z: 0 },
          { x: 0, y: 1 },
        ];
      },
    },
  ])("rejects a forged $name", ({ mutate }) => {
    const output = validOutput();
    mutate(output);
    expect(
      previewEditsToolOutputSchema.safeParse(
        output,
      ).success,
    ).toBe(false);
  });

  it.each([
    {
      name: "one-point update",
      mutate(output: Record<string, unknown>) {
        patchOf(output).points = [
          { x: 0, y: 0 },
        ];
      },
    },
    {
      name: "257-point update",
      mutate(output: Record<string, unknown>) {
        patchOf(output).points = Array.from(
          { length: 257 },
          (_, index) => ({
            x: index,
            y: -index,
          }),
        );
      },
    },
    {
      name: "update point with an extra key",
      mutate(output: Record<string, unknown>) {
        patchOf(output).points = [
          { x: 0, y: 0 },
          { x: 1, y: 1, z: 2 },
        ];
      },
    },
  ])("rejects a forged $name", ({ mutate }) => {
    const output = validUpdateOutput();
    mutate(output);
    expect(
      previewEditsToolOutputSchema.safeParse(
        output,
      ).success,
    ).toBe(false);
  });

  it.each([
    {
      name: "missing changed field",
      changedFields: [] as string[],
    },
    {
      name: "duplicate changed field",
      changedFields: [
        "points",
        "points",
      ],
    },
    {
      name: "extra changed field",
      changedFields: ["name", "points"],
    },
  ])(
    "rejects forged $name metadata",
    ({ changedFields }) => {
      const output = validUpdateOutput();
      operationOf(output).changedFields =
        changedFields;
      expect(
        previewEditsToolOutputSchema.safeParse(
          output,
        ).success,
      ).toBe(false);
    },
  );

  it("requires changedFields to use sorted patch-key order", () => {
    const output = validUpdateOutput();
    patchOf(output).name = "Replacement";
    operationOf(output).changedFields = [
      "points",
      "name",
    ];
    expect(
      previewEditsToolOutputSchema.safeParse(
        output,
      ).success,
    ).toBe(false);
    operationOf(output).changedFields = [
      "name",
      "points",
    ];
    expect(
      previewEditsToolOutputSchema.safeParse(
        output,
      ).success,
    ).toBe(true);
  });

  it("rejects a forged create-plus-update aggregate of more than 8,192 individually valid path points", () => {
    const output = validOutput();
    const result = output.result as Record<
      string,
      unknown
    >;
    result.operations = [
      ...Array.from(
        { length: 32 },
        (_, operationIndex) => ({
          type: "createObject",
          layerId: 1,
          shape: "polyline",
          object: {
            shape: "polyline",
            x: operationIndex,
            y: 0,
            points: Array.from(
              { length: 256 },
              (_, pointIndex) => ({
                x: pointIndex,
                y: -pointIndex,
              }),
            ),
          },
        }),
      ),
      {
        type: "updateObject",
        objectId: 7,
        changedFields: ["points"],
        patch: {
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      },
    ];
    const summary = result.summary as Record<
      string,
      unknown
    >;
    summary.operationCount = 33;
    summary.createdObjectIds = Array.from(
      { length: 32 },
      (_, index) => index + 1,
    );
    summary.updatedObjectIds = [7];

    expect(
      previewEditsToolOutputSchema.safeParse(
        output,
      ).success,
    ).toBe(false);
  });
});
