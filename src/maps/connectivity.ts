import { TiledMcpError } from "../errors.js";

export const MAX_CONNECTIVITY_CELLS = 1_000_000;
export const MAX_CONNECTIVITY_COMPONENT_SAMPLES = 32;
export const MAX_PASSABLE_TILE_SELECTORS = 64;

export interface ConnectivityResult {
  passableCellCount: number;
  blockedCellCount: number;
  componentCount: number;
  largestComponentSize: number;
  /**
   * One representative cell per component, ordered by descending
   * component size then first-visit order, bounded by the sample cap.
   */
  componentSamples: Array<{
    x: number;
    y: number;
    size: number;
  }>;
  componentSamplesTruncated: boolean;
  reachable?: boolean;
}

/**
 * Bounded four-way connectivity analysis over one passability grid.
 * Purely combinatorial — the caller decides which cells are passable;
 * this routine only floods components and answers reachability.
 */
export function analyzeConnectivity(
  passable: Uint8Array,
  width: number,
  height: number,
  endpoints?: {
    from: { x: number; y: number };
    to: { x: number; y: number };
  },
): ConnectivityResult {
  if (
    width < 1 ||
    height < 1 ||
    passable.length !== width * height ||
    width * height > MAX_CONNECTIVITY_CELLS
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `Connectivity analysis covers at most ${MAX_CONNECTIVITY_CELLS} cells.`,
      { limit: MAX_CONNECTIVITY_CELLS },
    );
  }
  const componentOf = new Int32Array(
    width * height,
  ).fill(-1);
  const componentSizes: number[] = [];
  const componentSeeds: Array<{
    x: number;
    y: number;
  }> = [];
  let passableCellCount = 0;

  const stack: number[] = [];
  for (
    let start = 0;
    start < passable.length;
    start += 1
  ) {
    if (passable[start] === 0) {
      continue;
    }
    passableCellCount += 1;
    if (componentOf[start] !== -1) {
      continue;
    }
    const component = componentSizes.length;
    componentSeeds.push({
      x: start % width,
      y: Math.floor(start / width),
    });
    let size = 0;
    stack.push(start);
    componentOf[start] = component;
    while (stack.length > 0) {
      const index = stack.pop()!;
      size += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1,
      ];
      for (const neighbour of neighbours) {
        if (
          neighbour >= 0 &&
          passable[neighbour] === 1 &&
          componentOf[neighbour] === -1
        ) {
          componentOf[neighbour] = component;
          stack.push(neighbour);
        }
      }
    }
    componentSizes.push(size);
  }

  // passableCellCount double-counted flood seeds above; recompute simply.
  passableCellCount = 0;
  for (const value of passable) {
    if (value === 1) {
      passableCellCount += 1;
    }
  }

  const ranked = componentSizes
    .map((size, component) => ({
      component,
      size,
    }))
    .sort(
      (left, right) =>
        right.size - left.size ||
        left.component - right.component,
    );
  const componentSamples = ranked
    .slice(0, MAX_CONNECTIVITY_COMPONENT_SAMPLES)
    .map(({ component, size }) => ({
      ...componentSeeds[component]!,
      size,
    }));

  const result: ConnectivityResult = {
    passableCellCount,
    blockedCellCount:
      width * height - passableCellCount,
    componentCount: componentSizes.length,
    largestComponentSize:
      ranked[0]?.size ?? 0,
    componentSamples,
    componentSamplesTruncated:
      componentSizes.length >
      MAX_CONNECTIVITY_COMPONENT_SAMPLES,
  };

  if (endpoints !== undefined) {
    const fromIndex =
      endpoints.from.y * width + endpoints.from.x;
    const toIndex =
      endpoints.to.y * width + endpoints.to.x;
    const fromComponent = componentOf[fromIndex];
    const toComponent = componentOf[toIndex];
    if (
      passable[fromIndex] !== 1 ||
      passable[toIndex] !== 1
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "Both endpoints must be passable cells.",
        {
          from: endpoints.from,
          to: endpoints.to,
        },
      );
    }
    result.reachable =
      fromComponent === toComponent;
  }
  return result;
}
