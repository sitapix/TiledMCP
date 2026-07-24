import sharp from "sharp";
import { describe, expect, it } from "vitest";

import type { AtlasGeometry } from "../src/images/atlas.js";
import {
  MAX_NATIVE_PREVIEW_EDGE,
  MAX_NATIVE_PREVIEW_PIXEL_BLENDS,
  MAX_NATIVE_PREVIEW_PIXELS,
  renderNativePreview,
  type NativePreviewAtlas,
} from "../src/images/mapPreview.js";
import {
  GID_DIAGONAL_OR_HEX_60,
  GID_FLIP_HORIZONTAL,
  GID_FLIP_VERTICAL,
} from "../src/maps/gid.js";
import type {
  PreviewRegion,
  PreviewTileLayer,
} from "../src/maps/previewScene.js";

type Rgba = readonly [number, number, number, number];

const RED = [255, 0, 0, 255] as const;
const GREEN = [0, 255, 0, 255] as const;
const BLUE = [0, 0, 255, 255] as const;
const YELLOW = [255, 255, 0, 255] as const;
const TRANSPARENT = [0, 0, 0, 0] as const;

describe("renderNativePreview", () => {
  it("matches Tiled 1.12.2 for all eight square H/V/D flag combinations", async () => {
    const atlas = previewAtlas({
      rgba: rgba([RED, GREEN, BLUE, YELLOW]),
      imageWidth: 2,
      imageHeight: 2,
      tileWidth: 2,
      tileHeight: 2,
      tileCount: 1,
      columns: 1,
    });
    const cases = [
      [1, [RED, GREEN, BLUE, YELLOW]],
      [
        (GID_FLIP_HORIZONTAL | 1) >>> 0,
        [GREEN, RED, YELLOW, BLUE],
      ],
      [
        (GID_FLIP_VERTICAL | 1) >>> 0,
        [BLUE, YELLOW, RED, GREEN],
      ],
      [
        (GID_DIAGONAL_OR_HEX_60 | 1) >>> 0,
        [RED, BLUE, GREEN, YELLOW],
      ],
      [
        (GID_FLIP_HORIZONTAL | GID_FLIP_VERTICAL | 1) >>> 0,
        [YELLOW, BLUE, GREEN, RED],
      ],
      [
        (GID_FLIP_HORIZONTAL | GID_DIAGONAL_OR_HEX_60 | 1) >>> 0,
        [BLUE, RED, YELLOW, GREEN],
      ],
      [
        (GID_FLIP_VERTICAL | GID_DIAGONAL_OR_HEX_60 | 1) >>> 0,
        [GREEN, YELLOW, RED, BLUE],
      ],
      [
        (
          GID_FLIP_HORIZONTAL |
          GID_FLIP_VERTICAL |
          GID_DIAGONAL_OR_HEX_60 |
          1
        ) >>> 0,
        [YELLOW, GREEN, BLUE, RED],
      ],
    ] satisfies Array<[number, Rgba[]]>;
    const rendered = await renderNativePreview({
      tileWidth: 2,
      tileHeight: 2,
      region: { x: 0, y: 0, width: cases.length, height: 1 },
      layers: [
        tileLayer({
          width: cases.length,
          height: 1,
          data: cases.map(([gid]) => gid),
        }),
      ],
      atlases: [atlas],
      scale: 1,
      overlays: { grid: false, coordinates: false },
    });
    const decoded = await decodeRgba(rendered.png);

    expect(rendered.pixelSize).toEqual({ width: 16, height: 2 });
    for (const [cell, [, expected]] of cases.entries()) {
      // Corner order was independently verified against TmxRasterizer 1.12.2.
      expect([
        pixel(decoded, cell * 2, 0),
        pixel(decoded, cell * 2 + 1, 0),
        pixel(decoded, cell * 2, 1),
        pixel(decoded, cell * 2 + 1, 1),
      ]).toEqual(expected);
    }
  });

  it("composites transparent pixels and layer opacity in Tiled layer order", async () => {
    const atlas = previewAtlas({
      // Tile 0 is an opaque red base. Tile 1 is blue only on its left half.
      rgba: rgba([RED, RED, BLUE, TRANSPARENT]),
      imageWidth: 4,
      imageHeight: 1,
      tileWidth: 2,
      tileHeight: 1,
      tileCount: 2,
      columns: 2,
    });
    const rendered = await renderNativePreview({
      tileWidth: 2,
      tileHeight: 1,
      region: { x: 0, y: 0, width: 1, height: 1 },
      layers: [
        tileLayer({ width: 1, height: 1, data: [1], opacity: 1 }),
        tileLayer({
          id: 2,
          width: 1,
          height: 1,
          data: [2],
          opacity: 0.5,
        }),
      ],
      atlases: [atlas],
      scale: 1,
      overlays: { grid: false, coordinates: false },
    });
    const decoded = await decodeRgba(rendered.png);

    // TmxRasterizer quantizes 255 * 0.5 to alpha 127.
    expect(pixel(decoded, 0, 0)).toEqual([128, 0, 127, 255]);
    expect(pixel(decoded, 1, 0)).toEqual(RED);
  });

  it("crops a global tile region and reports an unambiguous tile-to-pixel transform", async () => {
    const atlas = solidFourTileAtlas();
    const rendered = await renderNativePreview({
      tileWidth: 2,
      tileHeight: 2,
      region: { x: 1, y: 1, width: 2, height: 2 },
      layers: [
        tileLayer({
          width: 4,
          height: 3,
          data: [
            1, 1, 2, 2,
            1, 3, 4, 2,
            3, 3, 4, 4,
          ],
        }),
      ],
      atlases: [atlas],
      scale: 2,
      overlays: { grid: false, coordinates: false },
    });
    const decoded = await decodeRgba(rendered.png);

    expect(rendered).toMatchObject({
      pixelSize: { width: 8, height: 8 },
      contentPixelRect: { x: 0, y: 0, width: 8, height: 8 },
      coordinateTransform: {
        tileOrigin: { x: 1, y: 1 },
        pixelOrigin: { x: 0, y: 0 },
        pixelsPerTile: { x: 4, y: 4 },
      },
    });
    expect(pixel(decoded, 1, 1)).toEqual(BLUE);
    expect(pixel(decoded, 5, 1)).toEqual(YELLOW);
    expect(pixel(decoded, 1, 5)).toEqual(BLUE);
    expect(pixel(decoded, 5, 5)).toEqual(YELLOW);
  });

  it("keeps coordinate gutters separate from content and draws grid at the reported transform", async () => {
    const atlas = previewAtlas({
      rgba: solidPixels(16, 16, RED),
      imageWidth: 16,
      imageHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
      tileCount: 1,
      columns: 1,
    });
    const region = { x: 7, y: 5, width: 2, height: 1 };
    const rendered = await renderNativePreview({
      tileWidth: 16,
      tileHeight: 16,
      region,
      layers: [
        tileLayer({
          x: 7,
          y: 5,
          width: 2,
          height: 1,
          data: [1, 1],
        }),
      ],
      atlases: [atlas],
      scale: 1,
      overlays: { grid: true, coordinates: true },
    });
    const decoded = await decodeRgba(rendered.png);

    expect(rendered).toMatchObject({
      pixelSize: { width: 39, height: 25 },
      contentPixelRect: { x: 7, y: 9, width: 32, height: 16 },
      coordinateTransform: {
        tileOrigin: { x: 7, y: 5 },
        pixelOrigin: { x: 7, y: 9 },
        pixelsPerTile: { x: 16, y: 16 },
      },
    });

    // Absolute X=7 and Y=5 labels use the renderer's deterministic bitmap font.
    expect(pixel(decoded, 13, 2)).toEqual([226, 232, 240, 255]);
    expect(pixel(decoded, 2, 14)).toEqual([226, 232, 240, 255]);
    // Grid is composited over content at x=7 and x=23, while interiors stay red.
    expect(pixel(decoded, 7, 10)).toEqual([255, 104, 104, 255]);
    expect(pixel(decoded, 23, 10)).toEqual([255, 104, 104, 255]);
    expect(pixel(decoded, 8, 10)).toEqual(RED);
  });

  it.each([
    [
      "edge",
      { x: 0, y: 0, width: 129, height: 1 },
      { width: 2_064, height: 16 },
    ],
    [
      "pixel count",
      { x: 0, y: 0, width: 77, height: 77 },
      { width: 1_232, height: 1_232 },
    ],
  ] satisfies Array<
    [string, PreviewRegion, { width: number; height: number }]
  >)(
    "rejects a preview whose %s exceeds the output budget",
    async (_label, region, requestedPixelSize) => {
      await expect(
        renderNativePreview({
          tileWidth: 16,
          tileHeight: 16,
          region,
          layers: [],
          atlases: [],
          scale: 1,
          overlays: { grid: false, coordinates: false },
        }),
      ).rejects.toMatchObject({
        code: "PREVIEW_DIMENSIONS_EXCEEDED",
        details: {
          requestedPixelSize,
          maxEdge: MAX_NATIVE_PREVIEW_EDGE,
          maxPixels: MAX_NATIVE_PREVIEW_PIXELS,
        },
      });
    },
  );

  it("fails closed on a diagonal transform for a non-square tile", async () => {
    const atlas = previewAtlas({
      rgba: rgba([RED, GREEN]),
      imageWidth: 2,
      imageHeight: 1,
      tileWidth: 2,
      tileHeight: 1,
      tileCount: 1,
      columns: 1,
    });

    await expect(
      renderNativePreview({
        tileWidth: 2,
        tileHeight: 1,
        region: { x: 0, y: 0, width: 1, height: 1 },
        layers: [
          tileLayer({
            width: 1,
            height: 1,
            data: [(GID_DIAGONAL_OR_HEX_60 | 1) >>> 0],
          }),
        ],
        atlases: [atlas],
        scale: 1,
        overlays: { grid: false, coordinates: false },
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_RENDER_FEATURE",
      details: {
        feature: "non-square-diagonal-flip",
        tileSize: { width: 2, height: 1 },
      },
    });
  });

  it("bounds pixel compositing work across many overlapping layers", async () => {
    const tileWidth = 500;
    const tileHeight = 500;
    const layerCount =
      Math.floor(
        MAX_NATIVE_PREVIEW_PIXEL_BLENDS /
          (tileWidth * tileHeight),
      ) + 1;
    await expect(
      renderNativePreview({
        tileWidth,
        tileHeight,
        region: { x: 0, y: 0, width: 1, height: 1 },
        layers: Array.from({ length: layerCount }, (_, index) =>
          tileLayer({
            id: index + 1,
            width: 1,
            height: 1,
            data: [1],
          }),
        ),
        atlases: [],
        scale: 1,
        overlays: { grid: false, coordinates: false },
      }),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        tileDraws: layerCount,
        pixelsPerTile: tileWidth * tileHeight,
        limit: MAX_NATIVE_PREVIEW_PIXEL_BLENDS,
      },
    });
  });
});

function previewAtlas(
  input: {
    rgba: Buffer;
    imageWidth: number;
    imageHeight: number;
    tileWidth: number;
    tileHeight: number;
    tileCount: number;
    columns: number;
  },
): NativePreviewAtlas {
  const geometry: AtlasGeometry = {
    imagePath: "tiles/test.png",
    imageWidth: input.imageWidth,
    imageHeight: input.imageHeight,
    tileWidth: input.tileWidth,
    tileHeight: input.tileHeight,
    tileCount: input.tileCount,
    columns: input.columns,
    margin: 0,
    spacing: 0,
  };
  return {
    assetId: "asset_test",
    firstGid: 1,
    tileCount: input.tileCount,
    rgba: input.rgba,
    format: "png",
    geometry,
  };
}

function solidFourTileAtlas(): NativePreviewAtlas {
  const source: Rgba[] = [];
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      source.push(
        y < 2
          ? x < 2
            ? RED
            : GREEN
          : x < 2
            ? BLUE
            : YELLOW,
      );
    }
  }
  return previewAtlas({
    rgba: rgba(source),
    imageWidth: 4,
    imageHeight: 4,
    tileWidth: 2,
    tileHeight: 2,
    tileCount: 4,
    columns: 2,
  });
}

function tileLayer(
  input: Partial<PreviewTileLayer> &
    Pick<PreviewTileLayer, "width" | "height" | "data">,
): PreviewTileLayer {
  return {
    id: input.id ?? 1,
    name: input.name ?? `Layer ${input.id ?? 1}`,
    x: input.x ?? 0,
    y: input.y ?? 0,
    width: input.width,
    height: input.height,
    data: input.data,
    opacity: input.opacity ?? 1,
  };
}

function rgba(values: readonly Rgba[]): Buffer {
  return Buffer.from(values.flatMap((value) => [...value]));
}

function solidPixels(width: number, height: number, color: Rgba): Buffer {
  return rgba(Array.from({ length: width * height }, () => color));
}

async function decodeRgba(
  png: Buffer,
): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function pixel(
  decoded: { data: Buffer; width: number; height: number },
  x: number,
  y: number,
): [number, number, number, number] {
  expect(x).toBeGreaterThanOrEqual(0);
  expect(y).toBeGreaterThanOrEqual(0);
  expect(x).toBeLessThan(decoded.width);
  expect(y).toBeLessThan(decoded.height);
  const index = (y * decoded.width + x) * 4;
  return [
    decoded.data[index] ?? -1,
    decoded.data[index + 1] ?? -1,
    decoded.data[index + 2] ?? -1,
    decoded.data[index + 3] ?? -1,
  ];
}
