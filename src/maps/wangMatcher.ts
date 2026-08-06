import { TiledMcpError } from "../errors.js";

/**
 * Native corner Wang matching, so that painting terrain does not require the
 * Tiled CLI to be installed.
 *
 * The CLI path (`terrainPaint.ts`) drives Tiled's own `TileLayer.wangEdit()`
 * and is the parity reference. This module reimplements the corner case of
 * that matcher in-process, which is what walls need: paint the corners of a
 * region and let each cell pick the tile whose corner colours agree with its
 * neighbours.
 *
 * ## The one deliberate divergence
 *
 * Tiled's `WangFiller` chooses *randomly*, weighted by `probability`, among
 * tiles that match a pattern equally well. This server forbids `Math.random`
 * and wall-clock in generators -- the same input must always produce the same
 * bytes -- so where Tiled would roll a die, this picks the lowest local tile
 * id. The result is always a tile Tiled would consider valid for that corner
 * pattern; on a set with several equally-good candidates it is not necessarily
 * the same one a given CLI run produced.
 *
 * ## What it refuses
 *
 * Where no tile in the set matches a required corner pattern, this fails
 * closed and names the cell, rather than approximating with a near-match.
 * That is the house stance and it matters more here than usual: a silently
 * wrong wall tile is exactly the kind of defect that survives review.
 */

/**
 * `wangid` slots run clockwise from the top, alternating edges and corners:
 * `[top, topRight, right, bottomRight, bottom, bottomLeft, left, topLeft]`.
 * A slot value of 0 means unset; anything else is a 1-based colour index.
 */
export const WANG_SLOT_TOP_RIGHT = 1;
export const WANG_SLOT_BOTTOM_RIGHT = 3;
export const WANG_SLOT_BOTTOM_LEFT = 5;
export const WANG_SLOT_TOP_LEFT = 7;

/** The four corner slots, in the order this module reports them. */
export const WANG_CORNER_SLOTS = [
  WANG_SLOT_TOP_LEFT,
  WANG_SLOT_TOP_RIGHT,
  WANG_SLOT_BOTTOM_RIGHT,
  WANG_SLOT_BOTTOM_LEFT,
] as const;

export interface WangTileEntry {
  /** Local tile id within the tileset. */
  tileId: number;
  /** Exactly eight slots, clockwise from the top. */
  wangId: readonly number[];
}

export interface WangCornerAssignment {
  /** Corner-grid x, in `[0, width]`. */
  x: number;
  /** Corner-grid y, in `[0, height]`. */
  y: number;
  /** 1-based Wang colour index. */
  colorIndex: number;
}

export interface WangPaintCell {
  x: number;
  y: number;
  /** The chosen local tile id. */
  tileId: number;
}

export interface WangPaintInput {
  width: number;
  height: number;
  wangTiles: readonly WangTileEntry[];
  corners: readonly WangCornerAssignment[];
  /**
   * The local tile id currently in a cell, or `null` where the cell is empty
   * or holds a tile from a different tileset. An unknown current tile simply
   * contributes no known corners.
   */
  currentTileId: (x: number, y: number) => number | null;
}

/**
 * The four cells that share a corner-grid position, with the slot that corner
 * occupies in each. Painting one corner therefore restyles up to four cells --
 * which is the whole point: it is what makes a junction agree with itself.
 */
function cellsTouchingCorner(
  cornerX: number,
  cornerY: number,
): ReadonlyArray<{
  x: number;
  y: number;
  slot: number;
}> {
  return [
    {
      x: cornerX - 1,
      y: cornerY - 1,
      slot: WANG_SLOT_BOTTOM_RIGHT,
    },
    {
      x: cornerX,
      y: cornerY - 1,
      slot: WANG_SLOT_BOTTOM_LEFT,
    },
    {
      x: cornerX - 1,
      y: cornerY,
      slot: WANG_SLOT_TOP_RIGHT,
    },
    {
      x: cornerX,
      y: cornerY,
      slot: WANG_SLOT_TOP_LEFT,
    },
  ];
}

function cornerSignature(
  desired: ReadonlyArray<number>,
): string {
  return WANG_CORNER_SLOTS.map(
    (slot) => desired[slot] ?? 0,
  ).join(",");
}

/**
 * Chooses the tile for one desired corner pattern.
 *
 * A desired slot of 0 is a wildcard: the cell has no opinion about that
 * corner, which happens when the cell's current tile is not part of the Wang
 * set. Candidates are ranked by how many corners they pin down exactly, then
 * by lowest tile id, so the choice is total and stable.
 */
function selectTile(
  desired: ReadonlyArray<number>,
  wangTiles: readonly WangTileEntry[],
): number | undefined {
  let best: WangTileEntry | undefined;
  let bestSpecificity = -1;
  for (const candidate of wangTiles) {
    let matches = true;
    let specificity = 0;
    for (const slot of WANG_CORNER_SLOTS) {
      const want = desired[slot] ?? 0;
      const have = candidate.wangId[slot] ?? 0;
      if (want !== 0 && have !== want) {
        matches = false;
        break;
      }
      if (want !== 0) {
        specificity += 1;
      }
    }
    if (!matches) {
      continue;
    }
    if (
      best === undefined ||
      specificity > bestSpecificity ||
      (specificity === bestSpecificity &&
        candidate.tileId < best.tileId)
    ) {
      best = candidate;
      bestSpecificity = specificity;
    }
  }
  return best?.tileId;
}

/**
 * Computes the cells a corner paint changes.
 *
 * Returns only cells whose tile actually differs from what is already there,
 * in row-major order, so the caller can hand the result straight to a
 * `setTiles` operation and a no-op paint is visibly empty.
 */
export function computeWangCornerPaint(
  input: WangPaintInput,
): WangPaintCell[] {
  const {
    width,
    height,
    wangTiles,
    corners,
    currentTileId,
  } = input;

  const byTileId = new Map<
    number,
    WangTileEntry
  >();
  for (const entry of wangTiles) {
    byTileId.set(entry.tileId, entry);
  }

  // Accumulate the desired corner colours per affected cell. A cell touched
  // by several painted corners collects all of them before any tile is chosen,
  // so the choice sees the whole pattern rather than one corner at a time.
  const desiredByCell = new Map<
    string,
    { x: number; y: number; desired: number[] }
  >();
  for (const corner of corners) {
    for (const touched of cellsTouchingCorner(
      corner.x,
      corner.y,
    )) {
      if (
        touched.x < 0 ||
        touched.y < 0 ||
        touched.x >= width ||
        touched.y >= height
      ) {
        continue;
      }
      const key = `${touched.x},${touched.y}`;
      let entry = desiredByCell.get(key);
      if (entry === undefined) {
        // Seed from the cell's current tile so corners nobody painted keep
        // whatever they already agreed on.
        const current = currentTileId(
          touched.x,
          touched.y,
        );
        const existing =
          current === null
            ? undefined
            : byTileId.get(current);
        entry = {
          x: touched.x,
          y: touched.y,
          desired: [
            ...(existing?.wangId ?? [
              0, 0, 0, 0, 0, 0, 0, 0,
            ]),
          ],
        };
        desiredByCell.set(key, entry);
      }
      entry.desired[touched.slot] =
        corner.colorIndex;
    }
  }

  const cells: WangPaintCell[] = [];
  const ordered = [...desiredByCell.values()].sort(
    (a, b) => a.y - b.y || a.x - b.x,
  );
  for (const entry of ordered) {
    const tileId = selectTile(
      entry.desired,
      wangTiles,
    );
    if (tileId === undefined) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        `No tile in the Wang set matches the corner pattern [${cornerSignature(entry.desired)}] required at cell (${entry.x}, ${entry.y}); add the missing Wang tile rather than accepting an approximation.`,
        {
          x: entry.x,
          y: entry.y,
          corners: WANG_CORNER_SLOTS.map(
            (slot) => entry.desired[slot] ?? 0,
          ),
        },
      );
    }
    if (
      currentTileId(entry.x, entry.y) === tileId
    ) {
      continue;
    }
    cells.push({
      x: entry.x,
      y: entry.y,
      tileId,
    });
  }
  return cells;
}

/**
 * Reads a Tiled `wangsets[].wangtiles` array into {@link WangTileEntry}s,
 * failing closed on anything that is not exactly eight integer slots.
 */
export function parseWangTiles(
  value: unknown,
  context: string,
): WangTileEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((raw, index) => {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw)
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        `${context}.wangtiles[${index}] must be an object.`,
      );
    }
    const entry = raw as {
      tileid?: unknown;
      wangid?: unknown;
    };
    const tileId = entry.tileid;
    const wangId = entry.wangid;
    if (
      !Number.isSafeInteger(tileId) ||
      (tileId as number) < 0
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        `${context}.wangtiles[${index}].tileid must be a nonnegative integer.`,
      );
    }
    if (
      !Array.isArray(wangId) ||
      wangId.length !== 8 ||
      wangId.some(
        (slot) =>
          !Number.isSafeInteger(slot) ||
          (slot as number) < 0,
      )
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        `${context}.wangtiles[${index}].wangid must be eight nonnegative integers.`,
      );
    }
    return {
      tileId: tileId as number,
      wangId: wangId as number[],
    };
  });
}
