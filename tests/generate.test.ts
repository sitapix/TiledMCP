import { describe, expect, it } from "vitest";

import {
  computeGeneratedValues,
  hashToUnit,
  mapGeneratedValue,
  validateGenerateMapping,
} from "../src/maps/generate.js";

describe("deterministic procedural generation", () => {
  it("is reproducible and translation-stable", () => {
    expect(hashToUnit(42, 3, 7)).toBe(
      hashToUnit(42, 3, 7),
    );
    expect(hashToUnit(42, 3, 7)).not.toBe(
      hashToUnit(43, 3, 7),
    );
    const region = { x: 4, y: 4, width: 6, height: 6 };
    const first = computeGeneratedValues(
      { algorithm: "noise", scale: 3 },
      42,
      region,
    );
    const second = computeGeneratedValues(
      { algorithm: "noise", scale: 3 },
      42,
      region,
    );
    expect([...first]).toEqual([...second]);
    // Absolute coordinates drive the hash: a shifted region overlapping
    // the same world cells produces the same values there.
    const shifted = computeGeneratedValues(
      { algorithm: "noise", scale: 3 },
      42,
      { x: 5, y: 4, width: 6, height: 6 },
    );
    expect(shifted[0]).toBe(first[1]);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("runs the cellular automaton to binary walls", () => {
    const values = computeGeneratedValues(
      {
        algorithm: "cellular",
        fillProbability: 0.45,
        iterations: 4,
      },
      7,
      { x: 0, y: 0, width: 12, height: 12 },
    );
    const distinct = new Set([...values]);
    for (const value of distinct) {
      expect(value === 0 || value === 1).toBe(true);
    }
    // Border-as-wall convention keeps edges predominantly solid.
    expect(values[0]).toBe(1);
  });

  it("carves a connected rooms-and-corridors dungeon inside a wall ring", () => {
    const region = { x: 3, y: 5, width: 16, height: 12 };
    const first = computeGeneratedValues(
      { algorithm: "dungeon" },
      99,
      region,
    );
    const second = computeGeneratedValues(
      { algorithm: "dungeon" },
      99,
      region,
    );
    expect([...first]).toEqual([...second]);
    expect([...first]).not.toEqual([
      ...computeGeneratedValues(
        { algorithm: "dungeon" },
        100,
        region,
      ),
    ]);
    // Positions are drawn region-relative: a shifted region reproduces
    // the identical layout at its new location.
    expect([
      ...computeGeneratedValues(
        { algorithm: "dungeon" },
        99,
        { ...region, x: 40, y: 1 },
      ),
    ]).toEqual([...first]);

    const { width, height } = region;
    for (const value of first) {
      expect(value === 0 || value === 1).toBe(true);
    }
    // The one-cell border ring is never carved.
    for (let x = 0; x < width; x += 1) {
      expect(first[x]).toBe(1);
      expect(first[(height - 1) * width + x]).toBe(1);
    }
    for (let y = 0; y < height; y += 1) {
      expect(first[y * width]).toBe(1);
      expect(first[y * width + width - 1]).toBe(1);
    }
    // Corridors join consecutive rooms, so the floor is one connected
    // component: flood from any floor cell and expect full coverage.
    const floors = new Set<number>();
    for (let index = 0; index < first.length; index += 1) {
      if (first[index] === 0) {
        floors.add(index);
      }
    }
    expect(floors.size).toBeGreaterThan(0);
    const seedCell = [...floors][0]!;
    const reached = new Set<number>([seedCell]);
    const queue = [seedCell];
    while (queue.length > 0) {
      const index = queue.pop()!;
      const x = index % width;
      const y = (index - x) / width;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        const next = ny * width + nx;
        if (
          nx >= 0 &&
          ny >= 0 &&
          nx < width &&
          ny < height &&
          floors.has(next) &&
          !reached.has(next)
        ) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    expect(reached.size).toBe(floors.size);
  });

  it("fails closed on impossible dungeon regions and invalid room bounds", () => {
    expect(() =>
      computeGeneratedValues(
        { algorithm: "dungeon" },
        1,
        { x: 0, y: 0, width: 4, height: 12 },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
    // A smaller minRoomSize makes the same region viable.
    const tight = computeGeneratedValues(
      { algorithm: "dungeon", minRoomSize: 2 },
      1,
      { x: 0, y: 0, width: 4, height: 12 },
    );
    expect([...tight]).toContain(0);
    expect(() =>
      computeGeneratedValues(
        {
          algorithm: "dungeon",
          minRoomSize: 6,
          maxRoomSize: 4,
        },
        1,
        { x: 0, y: 0, width: 20, height: 20 },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
    expect(() =>
      computeGeneratedValues(
        { algorithm: "dungeon", maxRooms: 0 },
        1,
        { x: 0, y: 0, width: 20, height: 20 },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
    expect(() =>
      computeGeneratedValues(
        {
          algorithm: "dungeon",
          roomAttempts: 1_000,
        },
        1,
        { x: 0, y: 0, width: 20, height: 20 },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  });

  it("maps intervals with an inclusive top and validates bounds", () => {
    const mapping = [
      { min: 0, max: 0.5, tile: "low" },
      { min: 0.5, max: 1, tile: "high" },
    ];
    validateGenerateMapping(mapping);
    expect(mapGeneratedValue(0.2, mapping)).toBe(
      "low",
    );
    expect(mapGeneratedValue(0.5, mapping)).toBe(
      "high",
    );
    expect(mapGeneratedValue(1, mapping)).toBe(
      "high",
    );
    expect(
      mapGeneratedValue(0.7, [
        { min: 0, max: 0.5, tile: "low" },
      ]),
    ).toBeUndefined();
    expect(() =>
      validateGenerateMapping([
        { min: 0.5, max: 0.5, tile: "x" },
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  });
});
