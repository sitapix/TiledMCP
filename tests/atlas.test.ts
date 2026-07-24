import { describe, expect, it } from "vitest";

import {
  blitAtlasTile,
  parseTransparentColor,
  validateAtlasGeometry,
  type AtlasGeometry,
  type AtlasTileTransform,
} from "../src/images/atlas.js";

const RED = [255, 0, 0, 255] as const;
const GREEN = [0, 255, 0, 255] as const;
const BLUE = [0, 0, 255, 255] as const;
const YELLOW = [255, 255, 0, 255] as const;

describe("atlas geometry", () => {
  it("uses Tiled's one-sided trailing-margin rule", () => {
    const geometry: AtlasGeometry = {
      imagePath: "tiles/atlas.png",
      imageWidth: 13,
      imageHeight: 7,
      tileWidth: 3,
      tileHeight: 2,
      tileCount: 6,
      columns: 3,
      margin: 1,
      spacing: 1,
    };

    expect(() => validateAtlasGeometry(geometry)).not.toThrow();
    expect(() =>
      validateAtlasGeometry({ ...geometry, columns: 2 }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TILESET_ATLAS" }));
  });

  it("parses and validates Tiled transparentcolor values", () => {
    expect(parseTransparentColor("#0a7Fc0")).toEqual([10, 127, 192]);
    expect(() => parseTransparentColor("0a7fc0")).toThrowError(
      expect.objectContaining({ code: "INVALID_DOCUMENT" }),
    );
  });
});

describe("blitAtlasTile", () => {
  it.each([
    [{}, [RED, GREEN, BLUE, YELLOW]],
    [{ flipH: true }, [GREEN, RED, YELLOW, BLUE]],
    [{ flipV: true }, [BLUE, YELLOW, RED, GREEN]],
    [
      { flipH: true, flipV: true },
      [YELLOW, BLUE, GREEN, RED],
    ],
    [{ flipD: true }, [RED, BLUE, GREEN, YELLOW]],
    [
      { flipD: true, flipH: true },
      [BLUE, RED, YELLOW, GREEN],
    ],
    [
      { flipD: true, flipV: true },
      [GREEN, YELLOW, RED, BLUE],
    ],
    [
      { flipD: true, flipH: true, flipV: true },
      [YELLOW, GREEN, BLUE, RED],
    ],
  ] satisfies Array<
    [AtlasTileTransform, ReadonlyArray<readonly [number, number, number, number]>]
  >)(
    "applies diagonal first and then H/V for %j",
    (transform, expected) => {
      const destination = Buffer.alloc(2 * 2 * 4);
      const result = blitAtlasTile({
        sourceRgba: rgba([RED, GREEN, BLUE, YELLOW]),
        sourceWidth: 2,
        atlas: squareAtlas(),
        localId: 0,
        destinationRgba: destination,
        destinationWidth: 2,
        destinationLeft: 0,
        destinationTop: 0,
        scale: 1,
        transform,
      });

      expect(result).toEqual({ pixelWidth: 2, pixelHeight: 2 });
      expect(pixels(destination)).toEqual(expected);
    },
  );

  it("swaps rectangular output dimensions for a diagonal transform", () => {
    const source = rgba([RED, GREEN, BLUE, YELLOW, RED, BLUE]);
    const destination = Buffer.alloc(3 * 2 * 4);
    const result = blitAtlasTile({
      sourceRgba: source,
      sourceWidth: 2,
      atlas: {
        imagePath: "tiles/rect.png",
        imageWidth: 2,
        imageHeight: 3,
        tileWidth: 2,
        tileHeight: 3,
        tileCount: 1,
        columns: 1,
        margin: 0,
        spacing: 0,
      },
      localId: 0,
      destinationRgba: destination,
      destinationWidth: 3,
      destinationLeft: 0,
      destinationTop: 0,
      scale: 1,
      transform: { flipD: true },
    });

    expect(result).toEqual({ pixelWidth: 3, pixelHeight: 2 });
    expect(pixels(destination)).toEqual([
      RED,
      BLUE,
      RED,
      GREEN,
      YELLOW,
      BLUE,
    ]);
  });

  it("combines transparentcolor and opacity with RGBA source-over", () => {
    const destination = rgba([BLUE, BLUE]);
    blitAtlasTile({
      sourceRgba: rgba([RED, GREEN]),
      sourceWidth: 2,
      atlas: {
        imagePath: "tiles/colors.png",
        imageWidth: 2,
        imageHeight: 1,
        tileWidth: 2,
        tileHeight: 1,
        tileCount: 1,
        columns: 1,
        margin: 0,
        spacing: 0,
      },
      localId: 0,
      destinationRgba: destination,
      destinationWidth: 2,
      destinationLeft: 0,
      destinationTop: 0,
      scale: 1,
      transparentColor: [0, 255, 0],
      opacity: 0.5,
    });

    expect(pixels(destination)).toEqual([
      [127, 0, 128, 255],
      BLUE,
    ]);
  });

  it("clips scaled output at destination bounds", () => {
    const destination = Buffer.alloc(2 * 2 * 4);
    const result = blitAtlasTile({
      sourceRgba: rgba([RED]),
      sourceWidth: 1,
      atlas: {
        imagePath: "tiles/one.png",
        imageWidth: 1,
        imageHeight: 1,
        tileWidth: 1,
        tileHeight: 1,
        tileCount: 1,
        columns: 1,
        margin: 0,
        spacing: 0,
      },
      localId: 0,
      destinationRgba: destination,
      destinationWidth: 2,
      destinationLeft: -1,
      destinationTop: -1,
      scale: 2,
    });

    expect(result).toEqual({ pixelWidth: 2, pixelHeight: 2 });
    expect(pixels(destination)).toEqual([
      RED,
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
  });
});

function squareAtlas(): AtlasGeometry {
  return {
    imagePath: "tiles/square.png",
    imageWidth: 2,
    imageHeight: 2,
    tileWidth: 2,
    tileHeight: 2,
    tileCount: 1,
    columns: 1,
    margin: 0,
    spacing: 0,
  };
}

function rgba(
  values: ReadonlyArray<readonly [number, number, number, number]>,
): Buffer {
  return Buffer.from(values.flatMap((value) => [...value]));
}

function pixels(
  buffer: Buffer,
): Array<[number, number, number, number]> {
  const result: Array<[number, number, number, number]> = [];
  for (let index = 0; index < buffer.byteLength; index += 4) {
    result.push([
      buffer[index] ?? 0,
      buffer[index + 1] ?? 0,
      buffer[index + 2] ?? 0,
      buffer[index + 3] ?? 0,
    ]);
  }
  return result;
}
