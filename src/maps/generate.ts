import { TiledMcpError } from "../errors.js";

export const MAX_GENERATE_CELLS = 10_000;
export const MAX_GENERATE_MAPPING_ENTRIES = 16;
export const MAX_CELLULAR_ITERATIONS = 16;
export const MAX_NOISE_SCALE = 256;
export const MAX_DUNGEON_ROOMS = 64;
export const MAX_DUNGEON_ROOM_ATTEMPTS = 256;
export const MAX_DUNGEON_ROOM_SIZE = 64;

export interface GenerateRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GenerateMappingEntry<Tile> {
  /** Inclusive lower bound in [0, 1]. */
  min: number;
  /** Exclusive upper bound in (0, 1]; 1 is treated inclusively. */
  max: number;
  tile: Tile;
}

export type GenerateAlgorithmInput =
  | {
      algorithm: "noise";
      /** Feature size in cells; larger values give smoother noise. */
      scale?: number | undefined;
    }
  | {
      algorithm: "cellular";
      /** Initial wall probability in [0, 1]; default 0.45. */
      fillProbability?: number | undefined;
      /** Smoothing iterations; default 4. */
      iterations?: number | undefined;
      /** Neighbour walls required to stay/become a wall; default 5. */
      birthLimit?: number | undefined;
    }
  | {
      algorithm: "dungeon";
      /** Rooms to keep at most; default 8. */
      maxRooms?: number | undefined;
      /** Bounded room placement attempts; default 64. */
      roomAttempts?: number | undefined;
      /** Smallest room side in cells; default 3. */
      minRoomSize?: number | undefined;
      /** Largest room side in cells; default 7. */
      maxRoomSize?: number | undefined;
    };

/**
 * splitmix32: a small, well-mixed 32-bit hash. Seed and absolute cell
 * coordinates go in, a value in [0, 1) comes out — the same seed and
 * coordinate always produce the same value, with no sequential state, so
 * generation is reproducible and translation-stable by construction.
 * Math.random never appears anywhere in this module.
 */
export function hashToUnit(
  seed: number,
  x: number,
  y: number,
  salt = 0,
): number {
  let h =
    (seed ^
      Math.imul(x, 0x9e3779b9) ^
      Math.imul(y, 0x85ebca6b) ^
      Math.imul(salt + 1, 0xc2b2ae35)) >>>
    0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 0x1_0000_0000;
}

/**
 * Sequential splitmix32 stream for layout algorithms whose output is
 * globally coupled — room placement order matters, so a stateless
 * coordinate hash cannot express it. The same seed always yields the
 * same sequence, and positions are drawn region-relative, so a shifted
 * region reproduces the identical layout at its new location.
 * Math.random never appears anywhere in this module.
 */
export function createUnitStream(
  seed: number,
): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let h = state;
    h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    return h / 0x1_0000_0000;
  };
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Smooth value noise: lattice hashes blended with smoothstep weights. */
export function valueNoise(
  seed: number,
  x: number,
  y: number,
  scale: number,
): number {
  const gridX = Math.floor(x / scale);
  const gridY = Math.floor(y / scale);
  const fractionX = x / scale - gridX;
  const fractionY = y / scale - gridY;
  const topLeft = hashToUnit(seed, gridX, gridY);
  const topRight = hashToUnit(
    seed,
    gridX + 1,
    gridY,
  );
  const bottomLeft = hashToUnit(
    seed,
    gridX,
    gridY + 1,
  );
  const bottomRight = hashToUnit(
    seed,
    gridX + 1,
    gridY + 1,
  );
  const weightX = smoothstep(fractionX);
  const weightY = smoothstep(fractionY);
  const top =
    topLeft + (topRight - topLeft) * weightX;
  const bottom =
    bottomLeft +
    (bottomRight - bottomLeft) * weightX;
  return top + (bottom - top) * weightY;
}

/**
 * Computes the generated value field for one region. Noise yields
 * continuous values in [0, 1); cellular yields exactly 0 (open) or 1
 * (wall) after bounded automaton smoothing with out-of-region neighbours
 * counted as walls (the usual cave-generation convention); dungeon
 * yields exactly 0 (floor) or 1 (wall) from seeded rooms-and-corridors
 * placement.
 */
export function computeGeneratedValues(
  input: GenerateAlgorithmInput,
  seed: number,
  region: GenerateRegion,
): Float64Array {
  const { width, height } = region;
  const values = new Float64Array(width * height);
  if (input.algorithm === "noise") {
    const scale = input.scale ?? 4;
    if (
      !Number.isSafeInteger(scale) ||
      scale < 1 ||
      scale > MAX_NOISE_SCALE
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `noise scale must be an integer between 1 and ${MAX_NOISE_SCALE}.`,
        { scale },
      );
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        values[y * width + x] = valueNoise(
          seed,
          region.x + x,
          region.y + y,
          scale,
        );
      }
    }
    return values;
  }

  if (input.algorithm === "dungeon") {
    computeDungeonWalls(input, seed, region, values);
    return values;
  }

  const fillProbability =
    input.fillProbability ?? 0.45;
  const iterations = input.iterations ?? 4;
  const birthLimit = input.birthLimit ?? 5;
  if (
    typeof fillProbability !== "number" ||
    !(fillProbability >= 0) ||
    !(fillProbability <= 1)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "cellular fillProbability must be in [0, 1].",
      { fillProbability },
    );
  }
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < 0 ||
    iterations > MAX_CELLULAR_ITERATIONS
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `cellular iterations must be an integer between 0 and ${MAX_CELLULAR_ITERATIONS}.`,
      { iterations },
    );
  }
  if (
    !Number.isSafeInteger(birthLimit) ||
    birthLimit < 1 ||
    birthLimit > 8
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "cellular birthLimit must be an integer between 1 and 8.",
      { birthLimit },
    );
  }
  let walls = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      walls[y * width + x] =
        hashToUnit(
          seed,
          region.x + x,
          region.y + y,
        ) < fillProbability
          ? 1
          : 0;
    }
  }
  for (
    let iteration = 0;
    iteration < iterations;
    iteration += 1
  ) {
    const next = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let neighbourWalls = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) {
              continue;
            }
            const nx = x + dx;
            const ny = y + dy;
            if (
              nx < 0 ||
              ny < 0 ||
              nx >= width ||
              ny >= height ||
              walls[ny * width + nx] === 1
            ) {
              neighbourWalls += 1;
            }
          }
        }
        next[y * width + x] =
          neighbourWalls >= birthLimit ? 1 : 0;
      }
    }
    walls = next;
  }
  for (let index = 0; index < walls.length; index += 1) {
    values[index] = walls[index]!;
  }
  return values;
}

/**
 * Classic roguelike rooms-and-corridors: non-overlapping rooms are
 * placed inside a one-cell wall ring (with a one-cell gap between
 * rooms), then consecutive rooms are joined by L-shaped corridors
 * between their centres, so every floor cell is reachable from every
 * other. Values are exactly 0 (floor) and 1 (wall) like cellular. A
 * region that cannot fit one minimum-size room plus its ring fails
 * closed; the first placement attempt always succeeds after that, so
 * at least one room is guaranteed.
 */
function computeDungeonWalls(
  input: Extract<
    GenerateAlgorithmInput,
    { algorithm: "dungeon" }
  >,
  seed: number,
  region: GenerateRegion,
  values: Float64Array,
): void {
  const { width, height } = region;
  const maxRooms = input.maxRooms ?? 8;
  const roomAttempts = input.roomAttempts ?? 64;
  const minRoomSize = input.minRoomSize ?? 3;
  const maxRoomSize = input.maxRoomSize ?? 7;
  if (
    !Number.isSafeInteger(maxRooms) ||
    maxRooms < 1 ||
    maxRooms > MAX_DUNGEON_ROOMS
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `dungeon maxRooms must be an integer between 1 and ${MAX_DUNGEON_ROOMS}.`,
      { maxRooms },
    );
  }
  if (
    !Number.isSafeInteger(roomAttempts) ||
    roomAttempts < 1 ||
    roomAttempts > MAX_DUNGEON_ROOM_ATTEMPTS
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `dungeon roomAttempts must be an integer between 1 and ${MAX_DUNGEON_ROOM_ATTEMPTS}.`,
      { roomAttempts },
    );
  }
  if (
    !Number.isSafeInteger(minRoomSize) ||
    !Number.isSafeInteger(maxRoomSize) ||
    minRoomSize < 2 ||
    maxRoomSize < minRoomSize ||
    maxRoomSize > MAX_DUNGEON_ROOM_SIZE
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `dungeon room sizes must satisfy 2 <= minRoomSize <= maxRoomSize <= ${MAX_DUNGEON_ROOM_SIZE}.`,
      { minRoomSize, maxRoomSize },
    );
  }
  if (
    width < minRoomSize + 2 ||
    height < minRoomSize + 2
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `dungeon regions must fit one ${minRoomSize}x${minRoomSize} room plus its wall ring; shrink minRoomSize or enlarge the region.`,
      { width, height, minRoomSize },
    );
  }

  const next = createUnitStream(seed);
  const pickInclusive = (
    min: number,
    max: number,
  ): number =>
    min + Math.floor(next() * (max - min + 1));
  const walls = new Uint8Array(
    width * height,
  ).fill(1);
  const rooms: Array<{
    x: number;
    y: number;
    w: number;
    h: number;
  }> = [];
  for (
    let attempt = 0;
    attempt < roomAttempts &&
    rooms.length < maxRooms;
    attempt += 1
  ) {
    const w = pickInclusive(
      minRoomSize,
      Math.min(maxRoomSize, width - 2),
    );
    const h = pickInclusive(
      minRoomSize,
      Math.min(maxRoomSize, height - 2),
    );
    const x = pickInclusive(1, width - 1 - w);
    const y = pickInclusive(1, height - 1 - h);
    // Expanded-by-one intersection keeps a wall between adjacent rooms.
    const overlaps = rooms.some(
      (room) =>
        x <= room.x + room.w &&
        room.x <= x + w &&
        y <= room.y + room.h &&
        room.y <= y + h,
    );
    if (overlaps) {
      continue;
    }
    rooms.push({ x, y, w, h });
  }

  const carve = (x: number, y: number): void => {
    walls[y * width + x] = 0;
  };
  for (const room of rooms) {
    for (let y = room.y; y < room.y + room.h; y += 1) {
      for (let x = room.x; x < room.x + room.w; x += 1) {
        carve(x, y);
      }
    }
  }
  const carveHorizontal = (
    fromX: number,
    toX: number,
    y: number,
  ): void => {
    for (
      let x = Math.min(fromX, toX);
      x <= Math.max(fromX, toX);
      x += 1
    ) {
      carve(x, y);
    }
  };
  const carveVertical = (
    fromY: number,
    toY: number,
    x: number,
  ): void => {
    for (
      let y = Math.min(fromY, toY);
      y <= Math.max(fromY, toY);
      y += 1
    ) {
      carve(x, y);
    }
  };
  for (
    let index = 1;
    index < rooms.length;
    index += 1
  ) {
    const previous = rooms[index - 1]!;
    const current = rooms[index]!;
    const fromX =
      previous.x + Math.floor(previous.w / 2);
    const fromY =
      previous.y + Math.floor(previous.h / 2);
    const toX =
      current.x + Math.floor(current.w / 2);
    const toY =
      current.y + Math.floor(current.h / 2);
    if (next() < 0.5) {
      carveHorizontal(fromX, toX, fromY);
      carveVertical(fromY, toY, toX);
    } else {
      carveVertical(fromY, toY, fromX);
      carveHorizontal(fromX, toX, toY);
    }
  }

  for (
    let index = 0;
    index < walls.length;
    index += 1
  ) {
    values[index] = walls[index]!;
  }
}

/**
 * Maps generated values to tiles: the first entry whose [min, max)
 * interval contains the value wins (max of 1 is inclusive so cellular
 * walls are reachable); unmatched cells are simply skipped, allowing
 * sparse generation.
 */
export function validateGenerateMapping<Tile>(
  mapping: readonly GenerateMappingEntry<Tile>[],
): void {
  if (
    !Array.isArray(mapping) ||
    mapping.length === 0 ||
    mapping.length > MAX_GENERATE_MAPPING_ENTRIES
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `mapping must contain between 1 and ${MAX_GENERATE_MAPPING_ENTRIES} entries.`,
      { limit: MAX_GENERATE_MAPPING_ENTRIES },
    );
  }
  for (const [index, entry] of mapping.entries()) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.min !== "number" ||
      typeof entry.max !== "number" ||
      !(entry.min >= 0) ||
      !(entry.max <= 1) ||
      !(entry.min < entry.max)
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `mapping[${index}] must satisfy 0 <= min < max <= 1.`,
        { index },
      );
    }
  }
}

export function mapGeneratedValue<Tile>(
  value: number,
  mapping: readonly GenerateMappingEntry<Tile>[],
): Tile | undefined {
  for (const entry of mapping) {
    if (
      value >= entry.min &&
      (value < entry.max ||
        (entry.max === 1 && value === 1))
    ) {
      return entry.tile;
    }
  }
  return undefined;
}
