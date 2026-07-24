import { describe, expect, it } from "vitest";

import {
  decodeSafeImage,
  encodeRgbaPng,
  inspectSafeImage,
} from "../src/images/safeImage.js";

const SIMPLE_SVG = Buffer.from(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1">',
    '<rect width="1" height="1" fill="#ff0000"/>',
    '<rect x="1" width="1" height="1" fill="#00ff00"/>',
    "</svg>",
  ].join(""),
  "utf8",
);

describe("safe image codec", () => {
  it("decodes a declared simple SVG and encodes the exact RGBA surface", async () => {
    const decoded = await decodeSafeImage({
      bytes: SIMPLE_SVG,
      path: "tiles/simple.svg",
      declaredWidth: 2,
      declaredHeight: 1,
    });

    expect(decoded).toMatchObject({
      format: "svg",
      pixelSize: { width: 2, height: 1 },
    });
    expect([...decoded.rgba]).toEqual([
      255, 0, 0, 255,
      0, 255, 0, 255,
    ]);

    const png = await encodeRgbaPng(
      decoded.rgba,
      2,
      1,
      "test surface",
    );
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    await expect(
      inspectSafeImage({
        bytes: png,
        path: "tiles/renamed.bin",
        limits: {
          maxInputBytes: 1_024,
          maxInputPixels: 4,
          maxInputEdge: 2,
        },
      }),
    ).resolves.toEqual({ format: "png", width: 2, height: 1 });
  });

  it("binds decoded pixels to the TSJ-declared dimensions", async () => {
    await expect(
      decodeSafeImage({
        bytes: SIMPLE_SVG,
        path: "tiles/simple.svg",
        declaredWidth: 1,
        declaredHeight: 2,
      }),
    ).rejects.toMatchObject({
      code: "TILESET_IMAGE_DIMENSION_MISMATCH",
      details: {
        actual: { width: 2, height: 1 },
        declared: { width: 1, height: 2 },
      },
    });
  });

  it("rejects active SVG content before decode", async () => {
    const unsafe = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="file:///etc/passwd"/></svg>',
      "utf8",
    );
    await expect(
      decodeSafeImage({
        bytes: unsafe,
        path: "tiles/unsafe.svg",
        declaredWidth: 1,
        declaredHeight: 1,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_SVG" });
  });

  it("rejects malformed RGBA geometry before PNG encoding", async () => {
    await expect(
      encodeRgbaPng({
        rgba: Buffer.alloc(7),
        width: 2,
        height: 1,
      }),
    ).rejects.toMatchObject({ code: "IMAGE_ENCODING_FAILED" });
  });
});
