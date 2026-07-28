import { TiledMcpError } from "../errors.js";

export const MAX_SHAPE_CELLS = 10_000;

export type ShapeDrawInput =
  | {
      shape: "line";
      from: { x: number; y: number };
      to: { x: number; y: number };
    }
  | {
      shape: "rectangle";
      x: number;
      y: number;
      width: number;
      height: number;
      fill: boolean;
    }
  | {
      shape: "ellipse";
      x: number;
      y: number;
      width: number;
      height: number;
      fill: boolean;
    };

/**
 * Deterministic tile-grid geometry: Bresenham lines, rectangle outlines
 * and fills, and midpoint ellipses rasterized over the ellipse inscribed
 * in the given bounding rectangle. Cells are deduplicated in stable
 * first-visit order; every cell must land inside the map, and the total
 * is bounded — no clipping, no approximation.
 */
export function computeShapeCells(
  input: ShapeDrawInput,
  mapWidth: number,
  mapHeight: number,
): Array<{ x: number; y: number }> {
  const seen = new Set<string>();
  const cells: Array<{ x: number; y: number }> =
    [];
  const push = (x: number, y: number): void => {
    if (
      x < 0 ||
      y < 0 ||
      x >= mapWidth ||
      y >= mapHeight
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `The shape reaches cell (${x}, ${y}), outside the ${mapWidth}x${mapHeight} map.`,
        { x, y, mapWidth, mapHeight },
      );
    }
    const key = `${x},${y}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    cells.push({ x, y });
    if (cells.length > MAX_SHAPE_CELLS) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `The shape covers more than ${MAX_SHAPE_CELLS} cells.`,
        { limit: MAX_SHAPE_CELLS },
      );
    }
  };

  if (input.shape === "line") {
    assertCell(input.from, "from");
    assertCell(input.to, "to");
    // Classic integer Bresenham across all octants.
    let x = input.from.x;
    let y = input.from.y;
    const deltaX = Math.abs(input.to.x - x);
    const deltaY = -Math.abs(input.to.y - y);
    const stepX = x < input.to.x ? 1 : -1;
    const stepY = y < input.to.y ? 1 : -1;
    let error = deltaX + deltaY;
    for (;;) {
      push(x, y);
      if (x === input.to.x && y === input.to.y) {
        break;
      }
      const doubled = 2 * error;
      if (doubled >= deltaY) {
        error += deltaY;
        x += stepX;
      }
      if (doubled <= deltaX) {
        error += deltaX;
        y += stepY;
      }
    }
    return cells;
  }

  assertRect(input);
  if (input.shape === "rectangle") {
    const right = input.x + input.width - 1;
    const bottom = input.y + input.height - 1;
    for (let y = input.y; y <= bottom; y += 1) {
      for (let x = input.x; x <= right; x += 1) {
        if (
          input.fill ||
          x === input.x ||
          x === right ||
          y === input.y ||
          y === bottom
        ) {
          push(x, y);
        }
      }
    }
    return cells;
  }

  // Ellipse inscribed in the bounding rectangle, rasterized by testing
  // cell centers against the standard ellipse equation — deterministic
  // and symmetric for both outline and fill.
  const radiusX = input.width / 2;
  const radiusY = input.height / 2;
  const centerX = input.x + radiusX - 0.5;
  const centerY = input.y + radiusY - 0.5;
  const inside = (
    x: number,
    y: number,
  ): boolean => {
    const normalizedX = (x - centerX) / radiusX;
    const normalizedY = (y - centerY) / radiusY;
    return (
      normalizedX * normalizedX +
        normalizedY * normalizedY <=
      1
    );
  };
  const right = input.x + input.width - 1;
  const bottom = input.y + input.height - 1;
  for (let y = input.y; y <= bottom; y += 1) {
    for (let x = input.x; x <= right; x += 1) {
      if (!inside(x, y)) {
        continue;
      }
      if (input.fill) {
        push(x, y);
        continue;
      }
      // Outline: an inside cell with at least one outside 4-neighbour.
      if (
        !inside(x - 1, y) ||
        !inside(x + 1, y) ||
        !inside(x, y - 1) ||
        !inside(x, y + 1)
      ) {
        push(x, y);
      }
    }
  }
  return cells;
}

function assertCell(
  value: { x: number; y: number },
  label: string,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isSafeInteger(value.x) ||
    !Number.isSafeInteger(value.y)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${label} must be an integer cell coordinate.`,
    );
  }
}

function assertRect(value: {
  x: number;
  y: number;
  width: number;
  height: number;
}): void {
  if (
    !Number.isSafeInteger(value.x) ||
    !Number.isSafeInteger(value.y) ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    value.width < 1 ||
    value.height < 1
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "The shape rectangle must use integer coordinates and positive dimensions.",
    );
  }
}
