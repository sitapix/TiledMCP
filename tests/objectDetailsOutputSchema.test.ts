import { describe, expect, it } from "vitest";

import {
  objectDetailsToolOutputSchema,
} from "../src/outputSchemas/read.js";

const REVISION =
  `sha256:${"0".repeat(64)}` as const;

const COMMON_OBJECT = {
  id: 1,
  layerId: 2,
  layerName: "Objects",
  name: "Target",
  className: "Marker",
  x: 10,
  y: -20,
  rotation: 15,
  visible: true,
  opacity: 0.75,
  properties: [
    {
      name: "hostile",
      type: "bool",
      value: true,
    },
    {
      name: "style",
      type: "string",
      propertytype: "MarkerStyle",
      valueOmitted: true,
      reason: "custom-propertytype",
    },
  ],
  propertyCount: 2,
} as const;

function outputFor(
  object: Record<string, unknown>,
): Record<string, unknown> {
  return {
    result: {
      mapPath: "maps/example.tmj",
      revision: REVISION,
      dependencyRevisions: {},
      object,
    },
  };
}

describe("single-object details output schema", () => {
  it.each([
    {
      shape: "rectangle",
      width: 16,
      height: 8,
    },
    {
      shape: "ellipse",
      width: 0,
      height: 8,
    },
    {
      shape: "capsule",
      width: 16,
      height: 0,
    },
    {
      shape: "point",
    },
    {
      shape: "polygon",
      points: [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
        { x: 4, y: 4 },
      ],
    },
    {
      shape: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
      ],
    },
    {
      shape: "text",
      width: 64,
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
  ])("accepts complete $shape details", (specific) => {
    expect(
      objectDetailsToolOutputSchema.safeParse(
        outputFor({
          ...COMMON_OBJECT,
          ...specific,
        }),
      ).success,
    ).toBe(true);
  });

  it("counts bounded display strings by Unicode code points", () => {
    expect(
      objectDetailsToolOutputSchema.safeParse(
        outputFor({
          ...COMMON_OBJECT,
          shape: "point",
          name: "😀".repeat(128),
          nameTruncated: true,
        }),
      ).success,
    ).toBe(true);
    expect(
      objectDetailsToolOutputSchema.safeParse(
        outputFor({
          ...COMMON_OBJECT,
          shape: "point",
          name: "😀".repeat(129),
          nameTruncated: true,
        }),
      ).success,
    ).toBe(false);
  });

  it.each([
    {
      name: "point dimensions",
      object: {
        ...COMMON_OBJECT,
        shape: "point",
        width: 0,
      },
    },
    {
      name: "missing rectangle height",
      object: {
        ...COMMON_OBJECT,
        shape: "rectangle",
        width: 1,
      },
    },
    {
      name: "unbounded polygon",
      object: {
        ...COMMON_OBJECT,
        shape: "polygon",
        points: Array.from(
          { length: 257 },
          (_, index) => ({
            x: index,
            y: -index,
          }),
        ),
      },
    },
    {
      name: "incomplete effective text style",
      object: {
        ...COMMON_OBJECT,
        shape: "text",
        width: 1,
        height: 1,
        text: "missing defaults",
      },
    },
    {
      name: "invalid text control character",
      object: {
        ...COMMON_OBJECT,
        shape: "text",
        width: 1,
        height: 1,
        text: "bad\u0000text",
        fontFamily: "sans-serif",
        pixelSize: 16,
        wrap: false,
        color: "#000000",
        bold: false,
        italic: false,
        underline: false,
        strikeout: false,
        kerning: true,
        horizontalAlignment: "left",
        verticalAlignment: "top",
      },
    },
    {
      name: "unsupported shape",
      object: {
        ...COMMON_OBJECT,
        shape: "tile",
      },
    },
  ])("rejects forged $name", ({ object }) => {
    expect(
      objectDetailsToolOutputSchema.safeParse(
        outputFor(object),
      ).success,
    ).toBe(false);
  });
});
