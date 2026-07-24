import { TiledMcpError } from "../errors.js";

export const GID_FLIP_HORIZONTAL = 0x80000000 >>> 0;
export const GID_FLIP_VERTICAL = 0x40000000 >>> 0;
export const GID_DIAGONAL_OR_HEX_60 = 0x20000000 >>> 0;
export const GID_HEX_120 = 0x10000000 >>> 0;
export const GID_FLAGS_MASK = 0xf0000000 >>> 0;
export const GID_ID_MASK = 0x0fffffff;

export type MapOrientation =
  | "orthogonal"
  | "isometric"
  | "staggered"
  | "oblique"
  | "hexagonal";

export interface OrthogonalTransform {
  kind: "orthogonal";
  flipH: boolean;
  flipV: boolean;
  flipD: boolean;
  rawFlags: number;
}

export interface HexagonalTransform {
  kind: "hexagonal";
  flipH: boolean;
  flipV: boolean;
  rotate60: boolean;
  rotate120: boolean;
  rawFlags: number;
}

export type TileTransform = OrthogonalTransform | HexagonalTransform;

export interface DecodedGid {
  baseGid: number;
  transform: TileTransform;
}

export function decodeGid(gid: number, orientation: MapOrientation): DecodedGid {
  assertUnsignedGid(gid);
  const value = gid >>> 0;
  const rawFlags = (value & GID_FLAGS_MASK) >>> 0;
  const baseGid = (value & GID_ID_MASK) >>> 0;
  if (baseGid === 0 && rawFlags !== 0) {
    throw new TiledMcpError(
      "INVALID_GID",
      "A tile GID with base id 0 must not carry transformation flags.",
      { gid: value, rawFlags },
    );
  }

  if (orientation === "hexagonal") {
    return {
      baseGid,
      transform: {
        kind: "hexagonal",
        flipH: hasFlag(value, GID_FLIP_HORIZONTAL),
        flipV: hasFlag(value, GID_FLIP_VERTICAL),
        rotate60: hasFlag(value, GID_DIAGONAL_OR_HEX_60),
        rotate120: hasFlag(value, GID_HEX_120),
        rawFlags,
      },
    };
  }

  return {
    baseGid,
    transform: {
      kind: "orthogonal",
      flipH: hasFlag(value, GID_FLIP_HORIZONTAL),
      flipV: hasFlag(value, GID_FLIP_VERTICAL),
      flipD: hasFlag(value, GID_DIAGONAL_OR_HEX_60),
      rawFlags,
    },
  };
}

export function encodeGid(
  baseGid: number,
  orientation: MapOrientation,
  transform?: Partial<TileTransform>,
): number {
  if (!Number.isSafeInteger(baseGid) || baseGid < 0 || baseGid > GID_ID_MASK) {
    throw new TiledMcpError("INVALID_GID", `Base GID must be between 0 and ${GID_ID_MASK}.`, {
      baseGid,
    });
  }
  if (!transform) {
    return baseGid >>> 0;
  }

  const rawFlags = readRawFlags(transform.rawFlags);
  let flags = 0;
  if (orientation === "hexagonal") {
    if (transform.kind !== undefined && transform.kind !== "hexagonal") {
      throw new TiledMcpError(
        "INVALID_TILE_TRANSFORM",
        "Hexagonal maps require a hexagonal tile transform.",
      );
    }
    const hex = transform as Partial<HexagonalTransform>;
    flags = combineFlags([
      [hex.flipH, GID_FLIP_HORIZONTAL],
      [hex.flipV, GID_FLIP_VERTICAL],
      [hex.rotate60, GID_DIAGONAL_OR_HEX_60],
      [hex.rotate120, GID_HEX_120],
    ]);
  } else {
    if (transform.kind !== undefined && transform.kind !== "orthogonal") {
      throw new TiledMcpError(
        "INVALID_TILE_TRANSFORM",
        "Non-hexagonal maps require an orthogonal tile transform.",
      );
    }
    const orthogonal = transform as Partial<OrthogonalTransform>;
    flags = combineFlags([
      [orthogonal.flipH, GID_FLIP_HORIZONTAL],
      [orthogonal.flipV, GID_FLIP_VERTICAL],
      [orthogonal.flipD, GID_DIAGONAL_OR_HEX_60],
    ]);
    // 0x10000000 is unused for non-hexagonal maps, but preserving it makes
    // read/write round trips lossless for documents produced by other tools.
    flags = (flags | (rawFlags & GID_HEX_120)) >>> 0;
  }

  if (transform.rawFlags !== undefined && rawFlags !== flags) {
    throw new TiledMcpError(
      "INVALID_TILE_TRANSFORM",
      "rawFlags do not agree with the structured tile transform fields.",
      { rawFlags, structuredFlags: flags >>> 0 },
    );
  }
  if (baseGid === 0 && flags !== 0) {
    throw new TiledMcpError("INVALID_GID", "An empty tile cannot carry transformation flags.");
  }
  return ((baseGid >>> 0) | flags) >>> 0;
}

export function assertUnsignedGid(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new TiledMcpError(
      "INVALID_GID",
      "Tile GID must be an unsigned 32-bit integer.",
      { gid: value },
    );
  }
}

function readRawFlags(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  assertUnsignedGid(value);
  if (((value & GID_ID_MASK) >>> 0) !== 0) {
    throw new TiledMcpError(
      "INVALID_TILE_TRANSFORM",
      "rawFlags may contain only the four high GID flag bits.",
      { rawFlags: value },
    );
  }
  return value >>> 0;
}

function combineFlags(entries: ReadonlyArray<readonly [boolean | undefined, number]>): number {
  let flags = 0;
  for (const [enabled, flag] of entries) {
    if (enabled) {
      flags = (flags | flag) >>> 0;
    }
  }
  return flags >>> 0;
}

function hasFlag(value: number, flag: number): boolean {
  return ((value >>> 0) & flag) !== 0;
}
