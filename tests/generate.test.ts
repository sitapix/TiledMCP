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
