import { describe, expect, it } from "vitest";

import {
  GID_DIAGONAL_OR_HEX_60,
  GID_FLAGS_MASK,
  GID_FLIP_HORIZONTAL,
  GID_FLIP_VERTICAL,
  GID_HEX_120,
  GID_ID_MASK,
  assertUnsignedGid,
  decodeGid,
  encodeGid,
  type HexagonalTransform,
  type MapOrientation,
  type OrthogonalTransform,
} from "../src/maps/gid.js";

const FLAG_COMBINATIONS = Array.from({ length: 16 }, (_, index) => ({
  index,
  flags: (index * 0x10000000) >>> 0,
}));
const NON_EMPTY_BASE_GID = 0x00abcdef;

describe.each([
  ["orthogonal" as const, "orthogonal" as const],
  ["hexagonal" as const, "hexagonal" as const],
])("%s GID transforms", (orientation, expectedKind) => {
  it.each(FLAG_COMBINATIONS)(
    "decodes and re-encodes all four high-bit combinations ($index)",
    ({ flags }) => {
      const gid = (NON_EMPTY_BASE_GID | flags) >>> 0;
      const decoded = decodeGid(gid, orientation);

      expect(decoded.baseGid).toBe(NON_EMPTY_BASE_GID);
      expect(decoded.transform.kind).toBe(expectedKind);
      expect(decoded.transform.rawFlags).toBe(flags);
      expect(decoded.transform.flipH).toBe(
        (flags & GID_FLIP_HORIZONTAL) !== 0,
      );
      expect(decoded.transform.flipV).toBe(
        (flags & GID_FLIP_VERTICAL) !== 0,
      );
      if (decoded.transform.kind === "hexagonal") {
        expect(decoded.transform.rotate60).toBe(
          (flags & GID_DIAGONAL_OR_HEX_60) !== 0,
        );
        expect(decoded.transform.rotate120).toBe(
          (flags & GID_HEX_120) !== 0,
        );
      } else {
        expect(decoded.transform.flipD).toBe(
          (flags & GID_DIAGONAL_OR_HEX_60) !== 0,
        );
      }
      expect(encodeGid(decoded.baseGid, orientation, decoded.transform)).toBe(
        gid,
      );
    },
  );
});

describe("GID unsigned 32-bit boundaries", () => {
  it("accepts zero and the maximum u32 value losslessly", () => {
    expect(() => assertUnsignedGid(0)).not.toThrow();
    expect(() => assertUnsignedGid(0xffffffff)).not.toThrow();
    expect(decodeGid(0, "orthogonal")).toMatchObject({
      baseGid: 0,
      transform: { rawFlags: 0 },
    });

    const decodedMaximum = decodeGid(0xffffffff, "hexagonal");
    expect(decodedMaximum).toEqual({
      baseGid: GID_ID_MASK,
      transform: {
        kind: "hexagonal",
        flipH: true,
        flipV: true,
        rotate60: true,
        rotate120: true,
        rawFlags: GID_FLAGS_MASK,
      },
    });
    expect(
      encodeGid(
        decodedMaximum.baseGid,
        "hexagonal",
        decodedMaximum.transform,
      ),
    ).toBe(0xffffffff);
  });

  it.each([-1, 0x100000000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects non-u32 input %s",
    (value) => {
      expect(() => assertUnsignedGid(value)).toThrowError(
        expect.objectContaining({ code: "INVALID_GID" }),
      );
      expect(() => decodeGid(value, "orthogonal")).toThrowError(
        expect.objectContaining({ code: "INVALID_GID" }),
      );
    },
  );

  it.each([-1, GID_ID_MASK + 1, 1.5, Number.NaN])(
    "rejects invalid base GID %s",
    (baseGid) => {
      expect(() => encodeGid(baseGid, "orthogonal")).toThrowError(
        expect.objectContaining({ code: "INVALID_GID" }),
      );
    },
  );
});

describe("empty GIDs", () => {
  it("allows only the canonical unflagged empty GID", () => {
    expect(encodeGid(0, "orthogonal")).toBe(0);
    expect(encodeGid(0, "hexagonal")).toBe(0);
  });

  it.each(FLAG_COMBINATIONS.slice(1))(
    "rejects a flagged empty GID ($index)",
    ({ flags }) => {
      expect(() => decodeGid(flags, "orthogonal")).toThrowError(
        expect.objectContaining({ code: "INVALID_GID" }),
      );
      expect(() => decodeGid(flags, "hexagonal")).toThrowError(
        expect.objectContaining({ code: "INVALID_GID" }),
      );

      const orthogonal = transformForFlags(flags, "orthogonal");
      expect(() => encodeGid(0, "orthogonal", orthogonal)).toThrowError(
        expect.objectContaining({ code: "INVALID_GID" }),
      );

      const hexagonal = transformForFlags(flags, "hexagonal");
      expect(() => encodeGid(0, "hexagonal", hexagonal)).toThrowError(
        expect.objectContaining({ code: "INVALID_GID" }),
      );
    },
  );
});

function transformForFlags(
  flags: number,
  orientation: MapOrientation,
): OrthogonalTransform | HexagonalTransform {
  if (orientation === "hexagonal") {
    return {
      kind: "hexagonal",
      flipH: (flags & GID_FLIP_HORIZONTAL) !== 0,
      flipV: (flags & GID_FLIP_VERTICAL) !== 0,
      rotate60: (flags & GID_DIAGONAL_OR_HEX_60) !== 0,
      rotate120: (flags & GID_HEX_120) !== 0,
      rawFlags: flags,
    };
  }
  return {
    kind: "orthogonal",
    flipH: (flags & GID_FLIP_HORIZONTAL) !== 0,
    flipV: (flags & GID_FLIP_VERTICAL) !== 0,
    flipD: (flags & GID_DIAGONAL_OR_HEX_60) !== 0,
    rawFlags: flags,
  };
}
