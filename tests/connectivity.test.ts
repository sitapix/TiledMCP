import { describe, expect, it } from "vitest";

import { analyzeConnectivity } from "../src/maps/connectivity.js";

function grid(rows: string[]): {
  passable: Uint8Array;
  width: number;
  height: number;
} {
  const width = rows[0]!.length;
  const height = rows.length;
  const passable = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    [...row].forEach((char, x) => {
      passable[y * width + x] =
        char === "." ? 1 : 0;
    });
  });
  return { passable, width, height };
}

describe("four-way connectivity analysis", () => {
  it("counts components and answers reachability", () => {
    const { passable, width, height } = grid([
      "..#.",
      "..#.",
      "####",
      "....",
    ]);
    const result = analyzeConnectivity(
      passable,
      width,
      height,
    );
    expect(result).toMatchObject({
      passableCellCount: 10,
      blockedCellCount: 6,
      componentCount: 3,
      largestComponentSize: 4,
      componentSamplesTruncated: false,
    });
    expect(result.componentSamples).toHaveLength(
      3,
    );

    const reachable = analyzeConnectivity(
      passable,
      width,
      height,
      { from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
    );
    expect(reachable.reachable).toBe(true);
    const blocked = analyzeConnectivity(
      passable,
      width,
      height,
      { from: { x: 0, y: 0 }, to: { x: 3, y: 0 } },
    );
    expect(blocked.reachable).toBe(false);
    // Diagonal adjacency does not connect.
    const diagonal = analyzeConnectivity(
      passable,
      width,
      height,
      { from: { x: 0, y: 0 }, to: { x: 0, y: 3 } },
    );
    expect(diagonal.reachable).toBe(false);
  });

  it("fails closed on blocked endpoints", () => {
    const { passable, width, height } = grid([
      ".#",
      "..",
    ]);
    expect(() =>
      analyzeConnectivity(
        passable,
        width,
        height,
        {
          from: { x: 1, y: 0 },
          to: { x: 0, y: 0 },
        },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  });
});
