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
          shape: "text",
          object: {
            shape: "text",
            x: 10,
            y: 20,
            width: 80,
            height: 24,
            text: "Hello\t世界\n",
            fontFamily: "Noto Sans",
            pixelSize: 20,
            wrap: true,
            color: "#ff00aa80",
            bold: true,
            italic: false,
            underline: true,
            strikeout: false,
            kerning: true,
            horizontalAlignment: "center",
            verticalAlignment: "bottom",
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

function resultOf(
  output: Record<string, unknown>,
): Record<string, unknown> {
  return output.result as Record<string, unknown>;
}

function operationOf(
  output: Record<string, unknown>,
): Record<string, unknown> {
  return (
    resultOf(output).operations as Array<
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

describe("text-object change-set output schema", () => {
  it("accepts a strict flat text create preview", () => {
    expect(
      previewEditsToolOutputSchema.safeParse(
        validOutput(),
      ).success,
    ).toBe(true);
  });

  it("accepts a partial flat text update preview", () => {
    const output = validOutput();
    resultOf(output).operations = [
      {
        type: "updateObject",
        objectId: 1,
        changedFields: [
          "bold",
          "color",
          "fontFamily",
          "horizontalAlignment",
          "italic",
          "kerning",
          "pixelSize",
          "strikeout",
          "text",
          "underline",
          "verticalAlignment",
          "wrap",
        ],
        patch: {
          text: "",
          fontFamily: "serif",
          pixelSize: 999,
          wrap: false,
          color: "#AABBCC",
          bold: false,
          italic: true,
          underline: false,
          strikeout: true,
          kerning: false,
          horizontalAlignment: "justify",
          verticalAlignment: "top",
        },
      },
    ];
    const summary = resultOf(output)
      .summary as Record<string, unknown>;
    summary.createdObjectIds = [];
    summary.updatedObjectIds = [1];

    expect(
      previewEditsToolOutputSchema.safeParse(
        output,
      ).success,
    ).toBe(true);
  });

  it.each([
    {
      name: "missing required text",
      mutate(output: Record<string, unknown>) {
        delete objectOf(output).text;
      },
    },
    {
      name: "outer and object shape mismatch",
      mutate(output: Record<string, unknown>) {
        operationOf(output).shape = "rectangle";
      },
    },
    {
      name: "nested TMJ text object",
      mutate(output: Record<string, unknown>) {
        objectOf(output).textData = {
          text: "not flat",
        };
      },
    },
    {
      name: "unpaired surrogate",
      mutate(output: Record<string, unknown>) {
        objectOf(output).text = "\ud800";
      },
    },
    {
      name: "forbidden content control",
      mutate(output: Record<string, unknown>) {
        objectOf(output).text = "bad\u007ftext";
      },
    },
    {
      name: "forbidden font-family control",
      mutate(output: Record<string, unknown>) {
        objectOf(output).fontFamily =
          "bad\nfamily";
      },
    },
    {
      name: "pixel size above Tiled limit",
      mutate(output: Record<string, unknown>) {
        objectOf(output).pixelSize = 1_000;
      },
    },
    {
      name: "4,097-code-point content",
      mutate(output: Record<string, unknown>) {
        objectOf(output).text = "a".repeat(
          4_097,
        );
      },
    },
  ])("rejects forged $name", ({ mutate }) => {
    const output = validOutput();
    mutate(output);
    expect(
      previewEditsToolOutputSchema.safeParse(
        output,
      ).success,
    ).toBe(false);
  });

  it("rejects a forged empty update patch", () => {
    const output = validOutput();
    resultOf(output).operations = [
      {
        type: "updateObject",
        objectId: 1,
        changedFields: [],
        patch: {},
      },
    ];
    const summary = resultOf(output)
      .summary as Record<string, unknown>;
    summary.createdObjectIds = [];
    summary.updatedObjectIds = [1];

    expect(
      previewEditsToolOutputSchema.safeParse(
        output,
      ).success,
    ).toBe(false);
  });

  it("rejects more than 262,144 canonical text-field bytes across valid operations", () => {
    const output = validOutput();
    const content = "😀".repeat(4_096);
    resultOf(output).operations = Array.from(
      { length: 17 },
      (_, index) => ({
        type: "createObject",
        layerId: 1,
        shape: "text",
        object: {
          shape: "text",
          x: index,
          y: 0,
          text: content,
        },
      }),
    );
    const summary = resultOf(output)
      .summary as Record<string, unknown>;
    summary.operationCount = 17;
    summary.createdObjectIds = Array.from(
      { length: 17 },
      (_, index) => index + 1,
    );

    expect(
      previewEditsToolOutputSchema.safeParse(
        output,
      ).success,
    ).toBe(false);
  });
});
