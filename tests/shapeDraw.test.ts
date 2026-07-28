import { describe, expect, it } from "vitest";

import { computeShapeCells } from "../src/maps/shapeDraw.js";

describe("deterministic shape rasterization", () => {
  it("draws Bresenham lines across octants", () => {
    expect(
      computeShapeCells(
        {
          shape: "line",
          from: { x: 0, y: 0 },
          to: { x: 3, y: 1 },
        },
        8,
        8,
      ),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ]);
    expect(
      computeShapeCells(
        {
          shape: "line",
          from: { x: 2, y: 3 },
          to: { x: 2, y: 0 },
        },
        8,
        8,
      ),
    ).toHaveLength(4);
  });

  it("draws rectangle outlines and fills", () => {
    const outline = computeShapeCells(
      {
        shape: "rectangle",
        x: 1,
        y: 1,
        width: 4,
        height: 3,
        fill: false,
      },
      8,
      8,
    );
    expect(outline).toHaveLength(10);
    expect(outline).not.toContainEqual({
      x: 2,
      y: 2,
    });
    const filled = computeShapeCells(
      {
        shape: "rectangle",
        x: 1,
        y: 1,
        width: 4,
        height: 3,
        fill: true,
      },
      8,
      8,
    );
    expect(filled).toHaveLength(12);
  });

  it("draws symmetric ellipses", () => {
    const filled = computeShapeCells(
      {
        shape: "ellipse",
        x: 0,
        y: 0,
        width: 5,
        height: 5,
        fill: true,
      },
      8,
      8,
    );
    // Circle inscribed in 5x5: symmetric, includes center, excludes corners.
    expect(filled).toContainEqual({ x: 2, y: 2 });
    expect(filled).not.toContainEqual({
      x: 0,
      y: 0,
    });
    const byKey = new Set(
      filled.map((cell) => `${cell.x},${cell.y}`),
    );
    for (const cell of filled) {
      expect(byKey.has(`${4 - cell.x},${cell.y}`)).toBe(
        true,
      );
      expect(byKey.has(`${cell.x},${4 - cell.y}`)).toBe(
        true,
      );
    }
    const outline = computeShapeCells(
      {
        shape: "ellipse",
        x: 0,
        y: 0,
        width: 5,
        height: 5,
        fill: false,
      },
      8,
      8,
    );
    expect(outline.length).toBeLessThan(
      filled.length,
    );
    expect(outline).not.toContainEqual({
      x: 2,
      y: 2,
    });
  });

  it("fails closed on shapes leaving the map and oversized shapes", () => {
    expect(() =>
      computeShapeCells(
        {
          shape: "line",
          from: { x: 0, y: 0 },
          to: { x: 9, y: 0 },
        },
        8,
        8,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
    expect(() =>
      computeShapeCells(
        {
          shape: "rectangle",
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          fill: true,
        },
        500,
        500,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "RESULT_LIMIT_EXCEEDED",
      }),
    );
  });
});
