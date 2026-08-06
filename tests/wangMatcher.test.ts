import { describe, expect, it } from "vitest";

import {
  computeWangCornerPaint,
  parseWangTiles,
  type WangTileEntry,
} from "../src/maps/wangMatcher.js";

/**
 * A complete two-colour corner set: sixteen tiles, one per combination of the
 * four corners being colour 1 or colour 2. Tile ids are the bit pattern in
 * slot order (topLeft, topRight, bottomRight, bottomLeft), which keeps the
 * expectations below readable.
 */
function completeCornerSet(): WangTileEntry[] {
  const tiles: WangTileEntry[] = [];
  for (let mask = 0; mask < 16; mask++) {
    const corner = (bit: number): number =>
      (mask & (1 << bit)) === 0 ? 1 : 2;
    // [top, topRight, right, bottomRight, bottom, bottomLeft, left, topLeft]
    tiles.push({
      tileId: mask,
      wangId: [
        0,
        corner(1),
        0,
        corner(2),
        0,
        corner(3),
        0,
        corner(0),
      ],
    });
  }
  return tiles;
}

const EMPTY = () => null;

describe("native Wang corner matching", () => {
  it("restyles all four cells sharing a painted corner", () => {
    const cells = computeWangCornerPaint({
      width: 4,
      height: 4,
      wangTiles: completeCornerSet(),
      corners: [{ x: 2, y: 2, colorIndex: 2 }],
      currentTileId: EMPTY,
    });
    // The corner at (2,2) is shared by cells (1,1), (2,1), (1,2) and (2,2).
    expect(
      cells.map(({ x, y }) => `${x},${y}`),
    ).toEqual(["1,1", "2,1", "1,2", "2,2"]);
  });

  it("gives each cell the tile whose corner faces the paint", () => {
    const cells = computeWangCornerPaint({
      width: 4,
      height: 4,
      wangTiles: completeCornerSet(),
      corners: [{ x: 2, y: 2, colorIndex: 2 }],
      currentTileId: EMPTY,
    });
    const byCell = new Map(
      cells.map((cell) => [
        `${cell.x},${cell.y}`,
        cell.tileId,
      ]),
    );
    // Cell (1,1) has the paint at its bottomRight -> bit 2 set -> id 4.
    expect(byCell.get("1,1")).toBe(0b0100);
    // Cell (2,1) has it at its bottomLeft -> bit 3 -> id 8.
    expect(byCell.get("2,1")).toBe(0b1000);
    // Cell (1,2) has it at its topRight -> bit 1 -> id 2.
    expect(byCell.get("1,2")).toBe(0b0010);
    // Cell (2,2) has it at its topLeft -> bit 0 -> id 1.
    expect(byCell.get("2,2")).toBe(0b0001);
  });

  it("accumulates several painted corners before choosing a tile", () => {
    // Painting a whole cell's four corners must pick the one tile that has
    // all four, not four separate single-corner decisions.
    const cells = computeWangCornerPaint({
      width: 2,
      height: 2,
      wangTiles: completeCornerSet(),
      corners: [
        { x: 0, y: 0, colorIndex: 2 },
        { x: 1, y: 0, colorIndex: 2 },
        { x: 0, y: 1, colorIndex: 2 },
        { x: 1, y: 1, colorIndex: 2 },
      ],
      currentTileId: EMPTY,
    });
    const cell00 = cells.find(
      ({ x, y }) => x === 0 && y === 0,
    );
    expect(cell00?.tileId).toBe(0b1111);
  });

  it("keeps corners the caller did not paint", () => {
    // Cell (0,0) currently holds tile 15 (all corners colour 2). Painting
    // only its topLeft back to colour 1 must leave the other three alone.
    const cells = computeWangCornerPaint({
      width: 1,
      height: 1,
      wangTiles: completeCornerSet(),
      corners: [{ x: 0, y: 0, colorIndex: 1 }],
      currentTileId: () => 0b1111,
    });
    expect(cells).toEqual([
      { x: 0, y: 0, tileId: 0b1110 },
    ]);
  });

  it("reports no change when the paint already matches", () => {
    const cells = computeWangCornerPaint({
      width: 1,
      height: 1,
      wangTiles: completeCornerSet(),
      corners: [{ x: 0, y: 0, colorIndex: 2 }],
      currentTileId: () => 0b0001,
    });
    expect(cells).toEqual([]);
  });

  it("ignores corners that fall outside the map", () => {
    // The corner grid is one larger than the cell grid, so (0,0) touches
    // only one real cell; the other three are off-map.
    const cells = computeWangCornerPaint({
      width: 3,
      height: 3,
      wangTiles: completeCornerSet(),
      corners: [{ x: 0, y: 0, colorIndex: 2 }],
      currentTileId: EMPTY,
    });
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      x: 0,
      y: 0,
    });
  });

  it("fails closed when the set has no matching tile", () => {
    // A set with only the all-colour-1 tile cannot express a colour-2 corner.
    expect(() =>
      computeWangCornerPaint({
        width: 1,
        height: 1,
        wangTiles: [
          {
            tileId: 0,
            wangId: [0, 1, 0, 1, 0, 1, 0, 1],
          },
        ],
        corners: [
          { x: 0, y: 0, colorIndex: 2 },
        ],
        currentTileId: EMPTY,
      }),
    ).toThrowError(
      /No tile in the Wang set matches/u,
    );
  });

  it("breaks ties deterministically by lowest tile id", () => {
    // Two tiles express the same corner pattern. Tiled would pick randomly
    // by probability; this must always pick the lower id, and must keep
    // picking it across repeated runs.
    const duplicated: WangTileEntry[] = [
      {
        tileId: 9,
        wangId: [0, 1, 0, 1, 0, 1, 0, 2],
      },
      {
        tileId: 4,
        wangId: [0, 1, 0, 1, 0, 1, 0, 2],
      },
    ];
    for (let run = 0; run < 5; run++) {
      const cells = computeWangCornerPaint({
        width: 1,
        height: 1,
        wangTiles: duplicated,
        corners: [
          { x: 0, y: 0, colorIndex: 2 },
        ],
        currentTileId: EMPTY,
      });
      expect(cells[0]?.tileId).toBe(4);
    }
  });

  it("prefers the tile that pins down the most corners", () => {
    const tiles: WangTileEntry[] = [
      // Matches by wildcard only.
      {
        tileId: 1,
        wangId: [0, 0, 0, 0, 0, 0, 0, 0],
      },
      // Actually specifies the painted corner.
      {
        tileId: 7,
        wangId: [0, 0, 0, 0, 0, 0, 0, 2],
      },
    ];
    const cells = computeWangCornerPaint({
      width: 1,
      height: 1,
      wangTiles: tiles,
      corners: [{ x: 0, y: 0, colorIndex: 2 }],
      currentTileId: EMPTY,
    });
    expect(cells[0]?.tileId).toBe(7);
  });
});

describe("wangtiles parsing", () => {
  it("reads a well-formed array", () => {
    expect(
      parseWangTiles(
        [
          {
            tileid: 2,
            wangid: [0, 1, 0, 1, 0, 1, 0, 1],
          },
        ],
        "tileset.wangsets[0]",
      ),
    ).toEqual([
      {
        tileId: 2,
        wangId: [0, 1, 0, 1, 0, 1, 0, 1],
      },
    ]);
  });

  it("rejects a wangid that is not eight slots", () => {
    expect(() =>
      parseWangTiles(
        [{ tileid: 0, wangid: [1, 1, 1, 1] }],
        "tileset.wangsets[0]",
      ),
    ).toThrowError(
      /must be eight nonnegative integers/u,
    );
  });

  it("rejects a negative tileid", () => {
    expect(() =>
      parseWangTiles(
        [
          {
            tileid: -1,
            wangid: [0, 1, 0, 1, 0, 1, 0, 1],
          },
        ],
        "tileset.wangsets[0]",
      ),
    ).toThrowError(
      /must be a nonnegative integer/u,
    );
  });
});
