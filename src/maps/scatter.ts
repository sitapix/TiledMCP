import { TiledMcpError } from "../errors.js";
import {
  hashToUnit,
  type GenerateRegion,
} from "./generate.js";

export const MAX_SCATTER_CHOICES = 16;
export const MAX_SCATTER_WEIGHT = 1_000_000;

export interface ScatterChoice<Tile> {
  tile: Tile;
  /** Relative selection weight; positive and bounded. */
  weight: number;
}

export function validateScatterChoices<Tile>(
  choices: readonly ScatterChoice<Tile>[],
): void {
  if (
    !Array.isArray(choices) ||
    choices.length === 0 ||
    choices.length > MAX_SCATTER_CHOICES
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `choices must contain between 1 and ${MAX_SCATTER_CHOICES} entries.`,
      { limit: MAX_SCATTER_CHOICES },
    );
  }
  for (const [index, choice] of choices.entries()) {
    if (
      typeof choice !== "object" ||
      choice === null ||
      typeof choice.weight !== "number" ||
      !Number.isFinite(choice.weight) ||
      !(choice.weight > 0) ||
      choice.weight > MAX_SCATTER_WEIGHT
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `choices[${index}].weight must be a finite number in (0, ${MAX_SCATTER_WEIGHT}].`,
        { index },
      );
    }
  }
}

/**
 * Deterministic density scatter: each cell decides independently from a
 * stateless coordinate hash of the absolute cell position — one salt
 * for the density gate, another for the weighted choice — so the same
 * seed always reproduces the same picks, results are translation-stable,
 * and Math.random is never involved. Returns absolute cell coordinates.
 */
export function computeScatterPicks<Tile>(
  seed: number,
  region: GenerateRegion,
  density: number,
  choices: readonly ScatterChoice<Tile>[],
): Array<{ x: number; y: number; tile: Tile }> {
  if (
    typeof density !== "number" ||
    !(density > 0) ||
    !(density <= 1)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "density must be in (0, 1].",
      { density },
    );
  }
  validateScatterChoices(choices);
  const totalWeight = choices.reduce(
    (sum, choice) => sum + choice.weight,
    0,
  );
  const picks: Array<{
    x: number;
    y: number;
    tile: Tile;
  }> = [];
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      const absoluteX = region.x + x;
      const absoluteY = region.y + y;
      if (
        hashToUnit(seed, absoluteX, absoluteY) >=
        density
      ) {
        continue;
      }
      const roll =
        hashToUnit(seed, absoluteX, absoluteY, 1) *
        totalWeight;
      let cumulative = 0;
      let picked = choices[choices.length - 1]!;
      for (const choice of choices) {
        cumulative += choice.weight;
        if (roll < cumulative) {
          picked = choice;
          break;
        }
      }
      picks.push({
        x: absoluteX,
        y: absoluteY,
        tile: picked.tile,
      });
    }
  }
  return picks;
}
