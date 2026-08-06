import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TILE_RENDER_COLUMNS,
  DEFAULT_TILE_RENDER_SCALE,
  MAX_TILE_RENDER_BYTES,
  MAX_TILE_RENDER_COLUMNS,
  MAX_TILE_RENDER_EDGE,
  MAX_TILE_RENDER_LOCAL_IDS,
  MAX_TILE_RENDER_PIXELS,
  MAX_TILE_RENDER_SCALE,
  renderTilesetSheet,
  renderTilesetTiles,
  type TilesetSheetInput,
  type TilesetTilesInput,
} from "../src/images/tilesetSheet.js";

const FIXTURE_PATH = "fixtures/mvp/tiles.svg";

describe("renderTilesetSheet", () => {
  it("renders the real SVG atlas in local-ID order with deterministic labels", async () => {
    const imageBytes = await readFile(FIXTURE_PATH);
    const rendered = await renderTilesetSheet(baseInput(imageBytes));

    expect(rendered).toMatchObject({
      mimeType: "image/png",
      pixelSize: { width: 176, height: 70 },
      image: {
        format: "svg",
        pixelSize: { width: 32, height: 32 },
      },
      page: {
        index: 0,
        count: 1,
        requestedSize: 64,
        size: 64,
        adjusted: false,
        tileCount: 4,
        localIdRange: { first: 0, last: 3 },
        columns: 4,
        rows: 1,
      },
      scale: 2,
    });
    expect(rendered.byteLength).toBe(rendered.png.byteLength);
    expect(rendered.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(rendered.png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    const decoded = await decodeRgba(rendered.png);
    expect(pixel(decoded, 28, 28)).toEqual([79, 143, 79, 255]);
    expect(pixel(decoded, 68, 28)).toEqual([143, 107, 63, 255]);
    expect(pixel(decoded, 108, 28)).toEqual([70, 122, 163, 255]);
    expect(pixel(decoded, 148, 28)).toEqual([210, 191, 114, 255]);
    expect(pixel(decoded, 25, 48)).toEqual([226, 232, 240, 255]);
  });

  it("paginates consecutive local IDs and reports a partial last page", async () => {
    const imageBytes = await readFile(FIXTURE_PATH);
    const rendered = await renderTilesetSheet({
      ...baseInput(imageBytes),
      page: 1,
      pageSize: 3,
    });

    expect(rendered.page).toEqual({
      index: 1,
      count: 2,
      requestedSize: 3,
      size: 3,
      adjusted: false,
      tileCount: 1,
      localIdRange: { first: 3, last: 3 },
      columns: 1,
      rows: 1,
    });
    const decoded = await decodeRgba(rendered.png);
    expect(pixel(decoded, 28, 28)).toEqual([210, 191, 114, 255]);
  });

  it("reduces page capacity instead of silently reducing scale", async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#336699"/></svg>',
      "utf8",
    );
    const rendered = await renderTilesetSheet({
      imageBytes: source,
      imagePath: "tiles/large.svg",
      imageWidth: 256,
      imageHeight: 256,
      tileWidth: 64,
      tileHeight: 64,
      tileCount: 16,
      atlasColumns: 4,
      margin: 0,
      spacing: 0,
      page: 0,
      pageSize: 256,
      scale: 4,
    });

    expect(rendered.scale).toBe(4);
    expect(rendered.page).toMatchObject({
      index: 0,
      count: 2,
      requestedSize: 256,
      size: 14,
      adjusted: true,
      tileCount: 14,
      localIdRange: { first: 0, last: 13 },
      columns: 7,
      rows: 2,
    });
    expect(rendered.pixelSize.width).toBeLessThanOrEqual(2_048);
    expect(
      rendered.pixelSize.width * rendered.pixelSize.height,
    ).toBeLessThanOrEqual(1_500_000);
  });

  it("automatically narrows default columns when one wider row would exceed the pixel budget", async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="750"><rect width="1920" height="750" fill="#336699"/></svg>',
      "utf8",
    );
    const rendered = await renderTilesetSheet({
      imageBytes: source,
      imagePath: "tiles/wide-and-tall.svg",
      imageWidth: 1_920,
      imageHeight: 750,
      tileWidth: 240,
      tileHeight: 750,
      tileCount: 8,
      atlasColumns: 8,
      margin: 0,
      spacing: 0,
      page: 0,
      pageSize: 64,
      scale: 1,
    });

    expect(rendered.page).toMatchObject({
      index: 0,
      count: 2,
      requestedSize: 64,
      size: 7,
      adjusted: true,
      tileCount: 7,
      localIdRange: { first: 0, last: 6 },
      columns: 7,
      rows: 1,
    });
    expect(rendered.pixelSize).toEqual({ width: 1_752, height: 788 });
    expect(
      rendered.pixelSize.width * rendered.pixelSize.height,
    ).toBeLessThanOrEqual(1_500_000);
  });

  it("treats explicit sheetColumns as a maximum when the page contains fewer tiles", async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="#336699"/></svg>',
      "utf8",
    );
    const rendered = await renderTilesetSheet({
      imageBytes: source,
      imagePath: "tiles/one-large-tile.svg",
      imageWidth: 1_000,
      imageHeight: 1_000,
      tileWidth: 1_000,
      tileHeight: 1_000,
      tileCount: 1,
      atlasColumns: 1,
      margin: 0,
      spacing: 0,
      page: 0,
      pageSize: 1,
      sheetColumns: 32,
      scale: 1,
    });

    expect(rendered.page).toMatchObject({
      size: 1,
      tileCount: 1,
      columns: 1,
      rows: 1,
    });
  });

  it("uses Tiled's one-sided margin formula with non-zero spacing", async () => {
    const source = Buffer.from(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="7">',
        '<rect x="1" y="1" width="3" height="2" fill="#ff0000"/>',
        '<rect x="5" y="1" width="3" height="2" fill="#00ff00"/>',
        '<rect x="9" y="1" width="3" height="2" fill="#0000ff"/>',
        '<rect x="1" y="4" width="3" height="2" fill="#ffff00"/>',
        '<rect x="5" y="4" width="3" height="2" fill="#00ffff"/>',
        '<rect x="9" y="4" width="3" height="2" fill="#ff00ff"/>',
        "</svg>",
      ].join(""),
      "utf8",
    );
    const rendered = await renderTilesetSheet({
      imageBytes: source,
      imagePath: "tiles/spaced.svg",
      imageWidth: 13,
      imageHeight: 7,
      tileWidth: 3,
      tileHeight: 2,
      tileCount: 6,
      atlasColumns: 3,
      margin: 1,
      spacing: 1,
      page: 0,
      pageSize: 6,
      scale: 2,
    });
    const decoded = await decodeRgba(rendered.png);

    // Six cells are laid out on one row; each tile is 6px wide and centered
    // in a 14px cell.
    expect(pixel(decoded, 15, 14)).toEqual([255, 0, 0, 255]);
    expect(pixel(decoded, 29, 14)).toEqual([0, 255, 0, 255]);
    expect(pixel(decoded, 43, 14)).toEqual([0, 0, 255, 255]);
    expect(pixel(decoded, 57, 14)).toEqual([255, 255, 0, 255]);
    expect(pixel(decoded, 71, 14)).toEqual([0, 255, 255, 255]);
    expect(pixel(decoded, 85, 14)).toEqual([255, 0, 255, 255]);
  });

  it("applies Tiled transparentcolor over the checkerboard", async () => {
    const source = Buffer.from(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2">',
        '<rect x="0" y="0" width="2" height="2" fill="#ff00ff"/>',
        '<rect x="2" y="0" width="2" height="2" fill="#00aa00"/>',
        "</svg>",
      ].join(""),
      "utf8",
    );
    const rendered = await renderTilesetSheet({
      imageBytes: source,
      imagePath: "tiles/transparent.svg",
      imageWidth: 4,
      imageHeight: 2,
      tileWidth: 2,
      tileHeight: 2,
      tileCount: 2,
      atlasColumns: 2,
      margin: 0,
      spacing: 0,
      transparentColor: "#ff00ff",
      page: 0,
      pageSize: 2,
      scale: 1,
    });
    const decoded = await decodeRgba(rendered.png);

    expect(pixel(decoded, 14, 12)).toEqual([75, 85, 99, 255]);
    expect(pixel(decoded, 28, 12)).toEqual([0, 170, 0, 255]);
  });

  it.each(["jpeg", "png", "webp"] as const)(
    "decodes allowlisted %s atlas buffers by content",
    async (format) => {
      const pipeline = sharp({
        create: {
          width: 2,
          height: 2,
          channels: 4,
          background: { r: 20, g: 40, b: 60, alpha: 1 },
        },
      });
      const imageBytes =
        format === "jpeg"
          ? await pipeline.jpeg().toBuffer()
          : format === "png"
            ? await pipeline.png().toBuffer()
            : await pipeline.webp().toBuffer();
      const rendered = await renderTilesetSheet({
        imageBytes,
        imagePath: `tiles/atlas.${format}`,
        imageWidth: 2,
        imageHeight: 2,
        tileWidth: 1,
        tileHeight: 1,
        tileCount: 4,
        atlasColumns: 2,
        margin: 0,
        spacing: 0,
        page: 0,
        pageSize: 4,
        scale: 1,
      });

      expect(rendered.image.format).toBe(format);
    },
  );

  it("rejects out-of-range pages and atlas declarations that do not match the image", async () => {
    const imageBytes = await readFile(FIXTURE_PATH);
    await expect(
      renderTilesetSheet({ ...baseInput(imageBytes), page: 1 }),
    ).rejects.toMatchObject({ code: "PAGE_OUT_OF_RANGE" });
    await expect(
      renderTilesetSheet({
        ...baseInput(imageBytes),
        atlasColumns: 1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TILESET_ATLAS" });
    await expect(
      renderTilesetSheet({
        ...baseInput(imageBytes),
        imageWidth: 31,
      }),
    ).rejects.toMatchObject({
      code: "TILESET_IMAGE_DIMENSION_MISMATCH",
    });
  });

  it("rejects unsafe SVG features before decoding", async () => {
    const unsafe = Buffer.from(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">',
        '<image href="file:///etc/passwd" width="16" height="16"/>',
        "</svg>",
      ].join(""),
      "utf8",
    );
    await expect(
      renderTilesetSheet({
        imageBytes: unsafe,
        imagePath: "tiles/unsafe.svg",
        imageWidth: 16,
        imageHeight: 16,
        tileWidth: 16,
        tileHeight: 16,
        tileCount: 1,
        atlasColumns: 1,
        margin: 0,
        spacing: 0,
        page: 0,
        pageSize: 1,
        scale: 1,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_SVG" });

    const escapedCssUrl = Buffer.from(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">',
        '<rect width="16" height="16" fill="u\\72l(file:///etc/passwd)"/>',
        "</svg>",
      ].join(""),
      "utf8",
    );
    await expect(
      renderTilesetSheet({
        imageBytes: escapedCssUrl,
        imagePath: "tiles/escaped-url.svg",
        imageWidth: 16,
        imageHeight: 16,
        tileWidth: 16,
        tileHeight: 16,
        tileCount: 1,
        atlasColumns: 1,
        margin: 0,
        spacing: 0,
        page: 0,
        pageSize: 1,
        scale: 1,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_SVG" });

    const commentedCssUrl = Buffer.from(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">',
        '<rect width="16" height="16" fill="u/**/rl(file:///etc/passwd)"/>',
        "</svg>",
      ].join(""),
      "utf8",
    );
    await expect(
      renderTilesetSheet({
        imageBytes: commentedCssUrl,
        imagePath: "tiles/commented-url.svg",
        imageWidth: 16,
        imageHeight: 16,
        tileWidth: 16,
        tileHeight: 16,
        tileCount: 1,
        atlasColumns: 1,
        margin: 0,
        spacing: 0,
        page: 0,
        pageSize: 1,
        scale: 1,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_SVG" });
  });

  it("rejects malicious oversized SVG dimensions at metadata preflight", async () => {
    const oversized = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="5000"><rect width="1" height="1"/></svg>',
      "utf8",
    );
    await expect(
      renderTilesetSheet({
        imageBytes: oversized,
        imagePath: "tiles/oversized.svg",
        imageWidth: 5_000,
        imageHeight: 5_000,
        tileWidth: 1,
        tileHeight: 1,
        tileCount: 25_000_000,
        atlasColumns: 5_000,
        margin: 0,
        spacing: 0,
        page: 0,
        pageSize: 1,
        scale: 1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TILESET_IMAGE" });
  });

  it("rejects compressed SVGZ before invoking an image decoder", async () => {
    const compressed = gzipSync(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>',
        "utf8",
      ),
    );
    await expect(
      renderTilesetSheet({
        imageBytes: compressed,
        imagePath: "tiles/compressed.svgz",
        imageWidth: 16,
        imageHeight: 16,
        tileWidth: 16,
        tileHeight: 16,
        tileCount: 1,
        atlasColumns: 1,
        margin: 0,
        spacing: 0,
        page: 0,
        pageSize: 1,
        scale: 1,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE_FORMAT" });
  });
});

describe("renderTilesetTiles", () => {
  it("exports the frozen explicit-selection limits and defaults", () => {
    expect({
      maxLocalIds: MAX_TILE_RENDER_LOCAL_IDS,
      defaultColumns: DEFAULT_TILE_RENDER_COLUMNS,
      maxColumns: MAX_TILE_RENDER_COLUMNS,
      defaultScale: DEFAULT_TILE_RENDER_SCALE,
      maxScale: MAX_TILE_RENDER_SCALE,
      maxBytes: MAX_TILE_RENDER_BYTES,
      maxEdge: MAX_TILE_RENDER_EDGE,
      maxPixels: MAX_TILE_RENDER_PIXELS,
    }).toEqual({
      maxLocalIds: 64,
      defaultColumns: 8,
      maxColumns: 32,
      defaultScale: 2,
      maxScale: 4,
      maxBytes: 7 * 1024 * 1024,
      maxEdge: 2_048,
      maxPixels: 1_500_000,
    });
  });

  it("renders non-consecutive local IDs in exact input row-major order", async () => {
    const imageBytes = await readFile(FIXTURE_PATH);
    const rendered = await renderTilesetTiles({
      ...baseTilesInput(imageBytes),
      localIds: [3, 0, 2],
      columns: 2,
    });

    expect(rendered).toMatchObject({
      mimeType: "image/png",
      pixelSize: { width: 96, height: 124 },
      image: {
        format: "svg",
        pixelSize: { width: 32, height: 32 },
      },
      selection: {
        localIds: [3, 0, 2],
        count: 3,
        order: "input",
        labels: "local-id",
        layout: {
          kind: "row-major",
          requestedColumns: 2,
          columns: 2,
          rows: 2,
          adjusted: false,
        },
      },
      scale: 2,
    });
    expect(rendered.byteLength).toBe(rendered.png.byteLength);
    expect(rendered.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const decoded = await decodeRgba(rendered.png);
    expect(pixel(decoded, 28, 28)).toEqual([210, 191, 114, 255]);
    expect(pixel(decoded, 68, 28)).toEqual([79, 143, 79, 255]);
    expect(pixel(decoded, 28, 82)).toEqual([70, 122, 163, 255]);
  });

  it("expands default layout values and accepts both selection size boundaries", async () => {
    const imageBytes = await readFile(FIXTURE_PATH);
    const single = await renderTilesetTiles({
      ...baseTilesInput(imageBytes),
      localIds: [0],
    });
    expect(single.selection).toEqual({
      localIds: [0],
      count: 1,
      order: "input",
      labels: "local-id",
      layout: {
        kind: "row-major",
        requestedColumns: 8,
        columns: 1,
        rows: 1,
        adjusted: false,
      },
    });
    expect(single.scale).toBe(2);

    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#336699"/></svg>',
      "utf8",
    );
    const localIds = Array.from(
      { length: MAX_TILE_RENDER_LOCAL_IDS },
      (_, index) => index,
    );
    const maximum = await renderTilesetTiles({
      imageBytes: source,
      imagePath: "tiles/sixty-four.svg",
      imageWidth: 8,
      imageHeight: 8,
      tileWidth: 1,
      tileHeight: 1,
      tileCount: 64,
      atlasColumns: 8,
      margin: 0,
      spacing: 0,
      localIds,
    });
    expect(maximum.selection).toEqual({
      localIds,
      count: 64,
      order: "input",
      labels: "local-id",
      layout: {
        kind: "row-major",
        requestedColumns: 8,
        columns: 8,
        rows: 8,
        adjusted: false,
      },
    });
    expect(maximum.pixelSize.width).toBeLessThanOrEqual(
      MAX_TILE_RENDER_EDGE,
    );
    expect(
      maximum.pixelSize.width * maximum.pixelSize.height,
    ).toBeLessThanOrEqual(MAX_TILE_RENDER_PIXELS);
  });

  it("rejects empty, oversized, unsafe and duplicate local-ID selections", async () => {
    const imageBytes = await readFile(FIXTURE_PATH);
    const input = baseTilesInput(imageBytes);
    await expect(
      renderTilesetTiles({ ...input, localIds: [] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      renderTilesetTiles({
        ...input,
        localIds: Array.from({ length: 65 }, (_, index) => index),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      renderTilesetTiles({ ...input, localIds: [-1] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      renderTilesetTiles({
        ...input,
        localIds: [Number.MAX_SAFE_INTEGER + 1],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      renderTilesetTiles({ ...input, localIds: [2, 0, 2] }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: {
        localId: 2,
        firstIndex: 0,
        duplicateIndex: 2,
      },
    });
  });

  it("reports a valid integer outside tileCount as TILE_ID_OUT_OF_RANGE", async () => {
    const imageBytes = await readFile(FIXTURE_PATH);
    await expect(
      renderTilesetTiles({
        ...baseTilesInput(imageBytes),
        localIds: [4],
      }),
    ).rejects.toMatchObject({
      code: "TILE_ID_OUT_OF_RANGE",
      details: {
        path: FIXTURE_PATH,
        localId: 4,
        tileCount: 4,
        index: 0,
      },
    });
  });

  it("automatically narrows omitted columns but rejects the same explicit over-budget columns", async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="100"><rect width="2400" height="100" fill="#336699"/></svg>',
      "utf8",
    );
    const input: TilesetTilesInput = {
      imageBytes: source,
      imagePath: "tiles/wide.svg",
      imageWidth: 2_400,
      imageHeight: 100,
      tileWidth: 300,
      tileHeight: 100,
      tileCount: 8,
      atlasColumns: 8,
      margin: 0,
      spacing: 0,
      localIds: [0, 1, 2, 3, 4, 5, 6, 7],
      scale: 1,
    };
    const rendered = await renderTilesetTiles(input);
    expect(rendered.selection.layout).toEqual({
      kind: "row-major",
      requestedColumns: 8,
      columns: 6,
      rows: 2,
      adjusted: true,
    });
    expect(rendered.scale).toBe(1);

    await expect(
      renderTilesetTiles({ ...input, columns: 8 }),
    ).rejects.toMatchObject({
      code: "IMAGE_DIMENSIONS_EXCEEDED",
      details: {
        requestedColumns: 8,
        effectiveRequestedColumns: 8,
        maximumColumns: 6,
      },
    });
  });

  it("searches narrower implicit columns when a partial final row exceeds the total pixel budget", async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="574" height="1869"><rect width="574" height="1869" fill="#336699"/></svg>',
      "utf8",
    );
    const localIds = Array.from({ length: 49 }, (_, index) => index);
    const input: TilesetTilesInput = {
      imageBytes: source,
      imagePath: "tiles/partial-final-row.svg",
      imageWidth: 574,
      imageHeight: 1_869,
      tileWidth: 82,
      tileHeight: 267,
      tileCount: 49,
      atlasColumns: 7,
      margin: 0,
      spacing: 0,
      localIds,
      scale: 1,
    };

    const rendered = await renderTilesetTiles(input);
    expect(rendered.pixelSize).toEqual({
      width: 646,
      height: 2_039,
    });
    expect(rendered.selection.layout).toEqual({
      kind: "row-major",
      requestedColumns: 8,
      columns: 7,
      rows: 7,
      adjusted: true,
    });
    expect(
      rendered.pixelSize.width * rendered.pixelSize.height,
    ).toBeLessThanOrEqual(MAX_TILE_RENDER_PIXELS);

    await expect(
      renderTilesetTiles({ ...input, columns: 8 }),
    ).rejects.toMatchObject({
      code: "IMAGE_DIMENSIONS_EXCEEDED",
      details: {
        width: 736,
        height: 2_039,
        maxPixels: MAX_TILE_RENDER_PIXELS,
      },
    });
  });

  it("fails the whole selection when every requested tile cannot fit", async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1000"><rect width="2000" height="1000" fill="#336699"/></svg>',
      "utf8",
    );
    await expect(
      renderTilesetTiles({
        imageBytes: source,
        imagePath: "tiles/too-tall.svg",
        imageWidth: 2_000,
        imageHeight: 1_000,
        tileWidth: 1_000,
        tileHeight: 1_000,
        tileCount: 2,
        atlasColumns: 2,
        margin: 0,
        spacing: 0,
        localIds: [0, 1],
        scale: 1,
      }),
    ).rejects.toMatchObject({
      code: "IMAGE_DIMENSIONS_EXCEEDED",
    });
  });

  it("rejects columns and scale outside their frozen bounds", async () => {
    const imageBytes = await readFile(FIXTURE_PATH);
    const input = baseTilesInput(imageBytes);
    await expect(
      renderTilesetTiles({
        ...input,
        localIds: [0],
        columns: MAX_TILE_RENDER_COLUMNS + 1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      renderTilesetTiles({
        ...input,
        localIds: [0],
        scale: MAX_TILE_RENDER_SCALE + 1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

function baseInput(imageBytes: Buffer): TilesetSheetInput {
  return {
    imageBytes,
    imagePath: FIXTURE_PATH,
    imageWidth: 32,
    imageHeight: 32,
    tileWidth: 16,
    tileHeight: 16,
    tileCount: 4,
    atlasColumns: 2,
    margin: 0,
    spacing: 0,
    page: 0,
    pageSize: 64,
    scale: 2,
  };
}

function baseTilesInput(imageBytes: Buffer): Omit<
  TilesetTilesInput,
  "localIds"
> {
  return {
    imageBytes,
    imagePath: FIXTURE_PATH,
    imageWidth: 32,
    imageHeight: 32,
    tileWidth: 16,
    tileHeight: 16,
    tileCount: 4,
    atlasColumns: 2,
    margin: 0,
    spacing: 0,
  };
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
