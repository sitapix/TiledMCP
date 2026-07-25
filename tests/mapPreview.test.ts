import sharp from "sharp";
import { describe, expect, it } from "vitest";

import type { AtlasGeometry } from "../src/images/atlas.js";
import {
  MAX_NATIVE_PREVIEW_EDGE,
  MAX_NATIVE_PREVIEW_HIGHLIGHTS,
  MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
  MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS_AGGREGATE,
  MAX_NATIVE_PREVIEW_OBJECTS,
  MAX_NATIVE_PREVIEW_PIXEL_BLENDS,
  MAX_NATIVE_PREVIEW_PIXELS,
  MIN_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
  NATIVE_PREVIEW_HIGHLIGHT_BLEND_MODE,
  NATIVE_PREVIEW_HIGHLIGHT_COLOR,
  NATIVE_PREVIEW_HIGHLIGHT_OVERLAP_MODE,
  NATIVE_PREVIEW_HIGHLIGHT_STYLE,
  NATIVE_PREVIEW_OBJECT_COLOR,
  NATIVE_PREVIEW_OBJECT_CURVE_MAX_ERROR_PIXELS,
  NATIVE_PREVIEW_OBJECT_CURVE_TESSELLATION,
  NATIVE_PREVIEW_OBJECT_DRAW_ORDER,
  NATIVE_PREVIEW_OBJECT_ORIGIN_MARKER,
  NATIVE_PREVIEW_OBJECT_PROFILE,
  NATIVE_PREVIEW_OBJECT_QUANTIZATION,
  NATIVE_PREVIEW_OBJECT_STROKE_WIDTH,
  NATIVE_PREVIEW_OBJECT_STYLE,
  NATIVE_PREVIEW_OBJECT_VISIBILITY_POLICY,
  prepareNativePreviewHighlightOverlay,
  renderNativePreview,
  type NativePreviewAtlas,
  type NativePreviewHighlightInput,
  type NativePreviewObjectInput,
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

  it("renders absolute clipped highlights as an order-independent tile union before grid and coordinates", async () => {
    const atlas = previewAtlas({
      rgba: solidPixels(16, 16, RED),
      imageWidth: 16,
      imageHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
      tileCount: 1,
      columns: 1,
    });
    const highlights = [
      { x: 11, y: 20, width: 1, height: 1 },
      { x: 11, y: 20, width: 1, height: 1 },
      { x: 9, y: 21, width: 2, height: 1 },
    ] satisfies NativePreviewHighlightInput[];
    const render = (ordered: readonly NativePreviewHighlightInput[]) =>
      renderNativePreview({
        tileWidth: 16,
        tileHeight: 16,
        region: { x: 10, y: 20, width: 4, height: 2 },
        layers: [
          tileLayer({
            x: 10,
            y: 20,
            width: 4,
            height: 2,
            data: Array.from({ length: 8 }, () => 1),
          }),
        ],
        atlases: [atlas],
        scale: 1,
        overlays: {
          grid: true,
          coordinates: true,
          highlights: ordered,
        },
      });

    const rendered = await render(highlights);
    const reordered = await render(highlights.toReversed());
    const decoded = await decodeRgba(rendered.png);

    expect(rendered.png).toEqual(reordered.png);
    expect(rendered.highlightOverlay).toEqual({
      style: NATIVE_PREVIEW_HIGHLIGHT_STYLE,
      color: NATIVE_PREVIEW_HIGHLIGHT_COLOR,
      blendMode: NATIVE_PREVIEW_HIGHLIGHT_BLEND_MODE,
      overlapMode: NATIVE_PREVIEW_HIGHLIGHT_OVERLAP_MODE,
      highlightedTileCount: 2,
      entries: [
        {
          sourceIndex: 0,
          requestedTileRect: highlights[0],
          renderedTileRect: highlights[0],
          clipped: false,
        },
        {
          sourceIndex: 1,
          requestedTileRect: highlights[1],
          renderedTileRect: highlights[1],
          clipped: false,
        },
        {
          sourceIndex: 2,
          requestedTileRect: highlights[2],
          renderedTileRect: { x: 10, y: 21, width: 1, height: 1 },
          clipped: true,
        },
      ],
    });

    // The duplicate selection is blended exactly once over the red tile.
    expect(pixel(decoded, 29, 11)).toEqual([253, 77, 8, 255]);
    // Grid is composited after the highlight at the absolute x=11 boundary.
    expect(pixel(decoded, 27, 11)).toEqual([254, 150, 109, 255]);
    // An unselected tile remains unchanged.
    expect(pixel(decoded, 45, 11)).toEqual(RED);
    // The partially clipped third entry still selects its visible tile.
    expect(pixel(decoded, 13, 27)).toEqual([253, 77, 8, 255]);
    // Coordinate glyphs remain above and outside the content overlay.
    expect(pixel(decoded, 32, 2)).toEqual([226, 232, 240, 255]);
  });

  it("normalizes bounded highlight metadata with nonzero region origins", () => {
    expect(
      prepareNativePreviewHighlightOverlay(
        [
          { x: 8, y: 12, width: 4, height: 3 },
          { x: 10, y: 13, width: 2, height: 2 },
        ],
        { x: 10, y: 13, width: 3, height: 2 },
      ),
    ).toEqual({
      style: NATIVE_PREVIEW_HIGHLIGHT_STYLE,
      color: NATIVE_PREVIEW_HIGHLIGHT_COLOR,
      blendMode: NATIVE_PREVIEW_HIGHLIGHT_BLEND_MODE,
      overlapMode: NATIVE_PREVIEW_HIGHLIGHT_OVERLAP_MODE,
      highlightedTileCount: 4,
      entries: [
        {
          sourceIndex: 0,
          requestedTileRect: { x: 8, y: 12, width: 4, height: 3 },
          renderedTileRect: { x: 10, y: 13, width: 2, height: 2 },
          clipped: true,
        },
        {
          sourceIndex: 1,
          requestedTileRect: { x: 10, y: 13, width: 2, height: 2 },
          renderedTileRect: { x: 10, y: 13, width: 2, height: 2 },
          clipped: false,
        },
      ],
    });
    expect(
      prepareNativePreviewHighlightOverlay(
        undefined,
        { x: 10, y: 13, width: 3, height: 2 },
      ),
    ).toEqual({
      style: NATIVE_PREVIEW_HIGHLIGHT_STYLE,
      color: NATIVE_PREVIEW_HIGHLIGHT_COLOR,
      blendMode: NATIVE_PREVIEW_HIGHLIGHT_BLEND_MODE,
      overlapMode: NATIVE_PREVIEW_HIGHLIGHT_OVERLAP_MODE,
      highlightedTileCount: 0,
      entries: [],
    });
  });

  it("renders a fixed amber union over transparent pixels at scale four", async () => {
    const rendered = await renderNativePreview({
      tileWidth: 1,
      tileHeight: 1,
      region: { x: 3, y: 4, width: 1, height: 1 },
      layers: [],
      atlases: [],
      scale: 4,
      overlays: {
        grid: false,
        coordinates: false,
        highlights: [
          { x: 3, y: 4, width: 1, height: 1 },
        ],
      },
    });
    const decoded = await decodeRgba(rendered.png);

    expect(rendered.pixelSize).toEqual({
      width: 4,
      height: 4,
    });
    expect(pixel(decoded, 2, 2)).toEqual([
      NATIVE_PREVIEW_HIGHLIGHT_COLOR.r,
      NATIVE_PREVIEW_HIGHLIGHT_COLOR.g,
      NATIVE_PREVIEW_HIGHLIGHT_COLOR.b,
      NATIVE_PREVIEW_HIGHLIGHT_COLOR.a,
    ]);
  });

  it.each([
    ["an empty list", []],
    [
      "too many rectangles",
      Array.from(
        { length: MAX_NATIVE_PREVIEW_HIGHLIGHTS + 1 },
        () => ({ x: 0, y: 0, width: 1, height: 1 }),
      ),
    ],
    ["a negative coordinate", [{ x: -1, y: 0, width: 2, height: 1 }]],
    [
      "an overflowing extent",
      [{ x: Number.MAX_SAFE_INTEGER, y: 0, width: 1, height: 1 }],
    ],
    ["no region intersection", [{ x: 2, y: 0, width: 1, height: 1 }]],
    [
      "only a half-open boundary touch",
      [{ x: 1, y: 0, width: 1, height: 1 }],
    ],
    [
      "an extra property",
      [{ x: 0, y: 0, width: 1, height: 1, label: "not-supported" }],
    ],
  ])("rejects highlight input with %s", (_label, highlights) => {
    expect(() =>
      prepareNativePreviewHighlightOverlay(
        highlights,
        { x: 0, y: 0, width: 1, height: 1 },
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("counts 64 overlapping rectangles once and aggregates their union into the blend budget", async () => {
    const highlights = Array.from(
      { length: MAX_NATIVE_PREVIEW_HIGHLIGHTS },
      () => ({ x: 0, y: 0, width: 100, height: 100 }),
    );
    const rendered = await renderNativePreview({
      tileWidth: 4,
      tileHeight: 4,
      region: { x: 0, y: 0, width: 100, height: 100 },
      layers: [],
      atlases: [],
      scale: 1,
      overlays: {
        grid: false,
        coordinates: false,
        highlights,
      },
    });

    expect(rendered.highlightOverlay.highlightedTileCount).toBe(10_000);

    const tileWidth = 500;
    const tileHeight = 500;
    const layersAtTileBudget =
      MAX_NATIVE_PREVIEW_PIXEL_BLENDS / (tileWidth * tileHeight);
    await expect(
      renderNativePreview({
        tileWidth,
        tileHeight,
        region: { x: 0, y: 0, width: 1, height: 1 },
        layers: Array.from(
          { length: layersAtTileBudget - 1 },
          (_, index) =>
            tileLayer({
              id: index + 1,
              width: 1,
              height: 1,
              data: [1],
            }),
        ),
        atlases: [],
        scale: 1,
        overlays: {
          grid: false,
          coordinates: false,
          highlights: [
            { x: 0, y: 0, width: 1, height: 1 },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "GID_OUT_OF_RANGE",
    });
    await expect(
      renderNativePreview({
        tileWidth,
        tileHeight,
        region: { x: 0, y: 0, width: 1, height: 1 },
        layers: Array.from(
          { length: layersAtTileBudget },
          (_, index) =>
            tileLayer({
              id: index + 1,
              width: 1,
              height: 1,
              data: [1],
            }),
        ),
        atlases: [],
        scale: 1,
        overlays: {
          grid: false,
          coordinates: false,
          highlights: [{ x: 0, y: 0, width: 1, height: 1 }],
        },
      }),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        tileDraws: layersAtTileBudget,
        pixelsPerTile: tileWidth * tileHeight,
        highlightPixelBlends: tileWidth * tileHeight,
        limit: MAX_NATIVE_PREVIEW_PIXEL_BLENDS,
      },
    });
  });

  it("draws ordered basic object geometry after the grid and reports clipped selections", async () => {
    const objects = [
      {
        sourceIndex: 0,
        objectId: 10,
        layerId: 2,
        shape: "rectangle",
        representation: "geometry-outline",
        x: 2,
        y: 2,
        rotation: 0,
        width: 6,
        height: 4,
      },
      {
        sourceIndex: 1,
        objectId: 11,
        layerId: 2,
        shape: "polyline",
        representation: "geometry-outline",
        x: 10,
        y: 10,
        rotation: 0,
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 0, y: 5 },
        ],
      },
      {
        sourceIndex: 2,
        objectId: 12,
        layerId: 3,
        shape: "text",
        representation: "text-box-only",
        x: 13,
        y: 3,
        rotation: 90,
        width: 4,
        height: 3,
      },
      {
        sourceIndex: 3,
        objectId: 13,
        layerId: 3,
        shape: "point",
        representation: "geometry-outline",
        x: 20,
        y: 20,
        rotation: 45,
      },
    ] satisfies NativePreviewObjectInput[];
    const rendered = await renderNativePreview({
      tileWidth: 8,
      tileHeight: 8,
      region: { x: 0, y: 0, width: 2, height: 2 },
      layers: [],
      atlases: [],
      scale: 1,
      overlays: {
        grid: true,
        coordinates: false,
        objectDebug: objects,
      },
    });
    const decoded = await decodeRgba(rendered.png);
    const cyan = [
      NATIVE_PREVIEW_OBJECT_COLOR.r,
      NATIVE_PREVIEW_OBJECT_COLOR.g,
      NATIVE_PREVIEW_OBJECT_COLOR.b,
      NATIVE_PREVIEW_OBJECT_COLOR.a,
    ] as const;

    // The rectangle's right edge overwrites the previously drawn grid at x=8.
    expect(pixel(decoded, 8, 3)).toEqual(cyan);
    // Positive 90 degrees rotates the text box clockwise in the y-down map.
    expect(pixel(decoded, 10, 7)).toEqual(cyan);
    expect(pixel(decoded, 13, 5)).toEqual(cyan);
    // A polyline stays open; its implicit polygon-closing edge is not drawn.
    expect(pixel(decoded, 10, 14)).toEqual(TRANSPARENT);
    expect(pixel(decoded, 11, 14)).toEqual(cyan);

    expect(rendered.objectDebugOverlay).toEqual({
      profile: NATIVE_PREVIEW_OBJECT_PROFILE,
      style: NATIVE_PREVIEW_OBJECT_STYLE,
      color: NATIVE_PREVIEW_OBJECT_COLOR,
      strokeWidth: NATIVE_PREVIEW_OBJECT_STROKE_WIDTH,
      originMarker: NATIVE_PREVIEW_OBJECT_ORIGIN_MARKER,
      idLabels: false,
      visibilityPolicy:
        NATIVE_PREVIEW_OBJECT_VISIBILITY_POLICY,
      drawOrder: NATIVE_PREVIEW_OBJECT_DRAW_ORDER,
      quantization: NATIVE_PREVIEW_OBJECT_QUANTIZATION,
      curveTessellation: {
        algorithm:
          NATIVE_PREVIEW_OBJECT_CURVE_TESSELLATION,
        maximumChordErrorPixels:
          NATIVE_PREVIEW_OBJECT_CURVE_MAX_ERROR_PIXELS,
        minimumSegments:
          MIN_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
        maximumSegmentsPerObject:
          MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
        maximumAggregateSegments:
          MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS_AGGREGATE,
        segmentMultiple: 4,
        errorSpace:
          "continuous-output-before-quantization",
        overflowPolicy: "reject-whole-preview",
        offscreenPolicy:
          "conservative-rotated-bounds-skip-before-tessellation",
        capsuleConstruction:
          "two-semicircles-plus-two-straight-segments",
        degenerateExtent:
          "tiled-1.12-single-zero-line-double-zero-anchor-centered-20-map-pixel-circle",
      },
      selectedObjectCount: 4,
      renderedObjectCount: 3,
      entries: [
        {
          sourceIndex: 0,
          objectId: 10,
          layerId: 2,
          shape: "rectangle",
          representation: "geometry-outline",
          rendered: true,
          clipped: false,
        },
        {
          sourceIndex: 1,
          objectId: 11,
          layerId: 2,
          shape: "polyline",
          representation: "geometry-outline",
          rendered: true,
          clipped: false,
        },
        {
          sourceIndex: 2,
          objectId: 12,
          layerId: 3,
          shape: "text",
          representation: "text-box-only",
          rendered: true,
          clipped: false,
        },
        {
          sourceIndex: 3,
          objectId: 13,
          layerId: 3,
          shape: "point",
          representation: "geometry-outline",
          rendered: false,
          clipped: true,
        },
      ],
    });
  });

  it("rotates clockwise around the object anchor and clips huge offscreen segments before rasterizing", async () => {
    const rendered = await renderNativePreview({
      tileWidth: 16,
      tileHeight: 16,
      region: { x: 0, y: 0, width: 1, height: 1 },
      layers: [],
      atlases: [],
      scale: 1,
      overlays: {
        grid: false,
        coordinates: false,
        objectDebug: [
          {
            sourceIndex: 0,
            objectId: 1,
            layerId: 2,
            shape: "rectangle",
            representation: "geometry-outline",
            x: 8,
            y: 8,
            rotation: 90,
            width: 4,
            height: 2,
          },
          {
            sourceIndex: 1,
            objectId: 2,
            layerId: 2,
            shape: "polyline",
            representation: "geometry-outline",
            x: -999_999_984,
            y: 4,
            rotation: 0,
            points: [
              { x: 0, y: 0 },
              { x: 1_000_000_000, y: 0 },
            ],
          },
        ],
      },
    });
    const decoded = await decodeRgba(rendered.png);
    const cyan = [
      NATIVE_PREVIEW_OBJECT_COLOR.r,
      NATIVE_PREVIEW_OBJECT_COLOR.g,
      NATIVE_PREVIEW_OBJECT_COLOR.b,
      NATIVE_PREVIEW_OBJECT_COLOR.a,
    ] as const;

    expect(pixel(decoded, 8, 11)).toEqual(cyan);
    expect(pixel(decoded, 6, 11)).toEqual(cyan);
    expect(pixel(decoded, 4, 4)).toEqual(cyan);
    expect(rendered.objectDebugOverlay.entries).toMatchObject([
      { rendered: true, clipped: false },
      { rendered: true, clipped: true },
    ]);

    const renderRotation = (rotation: number) =>
      renderNativePreview({
        tileWidth: 16,
        tileHeight: 16,
        region: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
        layers: [],
        atlases: [],
        scale: 1,
        overlays: {
          grid: false,
          coordinates: false,
          objectDebug: [
            {
              sourceIndex: 0,
              objectId: 3,
              layerId: 2,
              shape: "rectangle",
              representation:
                "geometry-outline",
              x: 8,
              y: 8,
              rotation,
              width: 4,
              height: 2,
            },
          ],
        },
      });
    const hugeRotation =
      await renderRotation(1_000_000_000);
    const normalizedRotation =
      await renderRotation(280);
    expect(hugeRotation.png).toEqual(
      normalizedRotation.png,
    );
  });

  it("draws ellipse, rotated ellipse, and horizontal and vertical capsule geometry", async () => {
    const rendered = await renderNativePreview({
      tileWidth: 40,
      tileHeight: 32,
      region: { x: 0, y: 0, width: 1, height: 1 },
      layers: [],
      atlases: [],
      scale: 1,
      overlays: {
        grid: false,
        coordinates: false,
        objectDebug: [
          curveDebug(0, 1, "ellipse", {
            x: 4,
            y: 4,
            width: 12,
            height: 8,
          }),
          curveDebug(1, 2, "capsule", {
            x: 20,
            y: 4,
            width: 16,
            height: 8,
          }),
          curveDebug(2, 3, "capsule", {
            x: 4,
            y: 16,
            width: 8,
            height: 12,
          }),
          curveDebug(3, 4, "ellipse", {
            x: 24,
            y: 18,
            width: 8,
            height: 4,
            rotation: 90,
          }),
        ],
      },
    });
    const decoded = await decodeRgba(rendered.png);
    const cyan = [
      NATIVE_PREVIEW_OBJECT_COLOR.r,
      NATIVE_PREVIEW_OBJECT_COLOR.g,
      NATIVE_PREVIEW_OBJECT_COLOR.b,
      NATIVE_PREVIEW_OBJECT_COLOR.a,
    ] as const;

    for (const [x, y] of [
      [10, 4],
      [16, 8],
      [10, 12],
      [24, 4],
      [36, 8],
      [28, 12],
      [8, 16],
      [12, 20],
      [8, 28],
      [4, 24],
      [22, 18],
      [24, 22],
      [22, 26],
      [20, 22],
    ] as const) {
      expect(pixel(decoded, x, y)).toEqual(cyan);
    }
    for (const [x, y] of [
      [10, 8],
      [16, 4],
      [28, 8],
      [36, 4],
      [8, 22],
      [12, 16],
      [22, 22],
      [24, 26],
    ] as const) {
      expect(pixel(decoded, x, y)).toEqual(
        TRANSPARENT,
      );
    }
    expect(rendered.objectDebugOverlay.entries).toEqual([
      {
        sourceIndex: 0,
        objectId: 1,
        layerId: 2,
        shape: "ellipse",
        representation: "geometry-outline",
        rendered: true,
        clipped: false,
      },
      {
        sourceIndex: 1,
        objectId: 2,
        layerId: 2,
        shape: "capsule",
        representation: "geometry-outline",
        rendered: true,
        clipped: false,
      },
      {
        sourceIndex: 2,
        objectId: 3,
        layerId: 2,
        shape: "capsule",
        representation: "geometry-outline",
        rendered: true,
        clipped: false,
      },
      {
        sourceIndex: 3,
        objectId: 4,
        layerId: 2,
        shape: "ellipse",
        representation: "geometry-outline",
        rendered: true,
        clipped: false,
      },
    ]);
  });

  it("uses Tiled 1.12 curve fallbacks for zero extents", async () => {
    const rendered = await renderNativePreview({
      tileWidth: 32,
      tileHeight: 32,
      region: { x: 0, y: 0, width: 1, height: 1 },
      layers: [],
      atlases: [],
      scale: 1,
      overlays: {
        grid: false,
        coordinates: false,
        objectDebug: [
          curveDebug(0, 1, "ellipse", {
            x: 4,
            y: 4,
            width: 0,
            height: 8,
          }),
          curveDebug(1, 2, "capsule", {
            x: 12,
            y: 4,
            width: 8,
            height: 0,
            rotation: 90,
          }),
          curveDebug(2, 3, "ellipse", {
            x: 20,
            y: 20,
            width: 0,
            height: 0,
          }),
          curveDebug(3, 4, "capsule", {
            x: 28,
            y: 4,
            width: Number.MIN_VALUE,
            height: 8,
          }),
        ],
      },
    });
    const decoded = await decodeRgba(rendered.png);
    const cyan = [
      NATIVE_PREVIEW_OBJECT_COLOR.r,
      NATIVE_PREVIEW_OBJECT_COLOR.g,
      NATIVE_PREVIEW_OBJECT_COLOR.b,
      NATIVE_PREVIEW_OBJECT_COLOR.a,
    ] as const;

    expect(pixel(decoded, 4, 12)).toEqual(cyan);
    expect(pixel(decoded, 12, 12)).toEqual(cyan);
    expect(pixel(decoded, 20, 10)).toEqual(cyan);
    expect(pixel(decoded, 10, 20)).toEqual(cyan);
    expect(pixel(decoded, 30, 20)).toEqual(cyan);
    expect(pixel(decoded, 20, 30)).toEqual(cyan);
    expect(pixel(decoded, 10, 10)).toEqual(
      TRANSPARENT,
    );
    expect(pixel(decoded, 28, 12)).toEqual(cyan);
    expect(
      rendered.objectDebugOverlay.curveTessellation
        .degenerateExtent,
    ).toBe(
      "tiled-1.12-single-zero-line-double-zero-anchor-centered-20-map-pixel-circle",
    );
  });

  it("renders a square capsule exactly like an ellipse with the same bounds", async () => {
    const renderCurve = async (
      shape: "ellipse" | "capsule",
    ) =>
      renderNativePreview({
        tileWidth: 24,
        tileHeight: 24,
        region: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
        layers: [],
        atlases: [],
        scale: 2,
        overlays: {
          grid: false,
          coordinates: false,
          objectDebug: [
            curveDebug(0, 1, shape, {
              x: 4,
              y: 4,
              width: 8,
              height: 8,
              rotation: 30,
            }),
          ],
        },
      });

    const ellipse = await renderCurve("ellipse");
    const capsule = await renderCurve("capsule");
    expect(capsule.png).toEqual(ellipse.png);
  });

  it("skips huge fully offscreen curves before tessellation and clips long thin capsules", async () => {
    const rendered = await renderNativePreview({
      tileWidth: 16,
      tileHeight: 16,
      region: { x: 0, y: 0, width: 1, height: 1 },
      layers: [],
      atlases: [],
      scale: 1,
      overlays: {
        grid: false,
        coordinates: false,
        objectDebug: [
          curveDebug(0, 1, "ellipse", {
            x: 1_000_000_000,
            y: 1_000_000_000,
            width: 1_000_000_000,
            height: 1_000_000_000,
            rotation: 45,
          }),
          curveDebug(1, 2, "capsule", {
            x: -999_999_985,
            y: 4,
            width: 1_000_000_000,
            height: 4,
          }),
        ],
      },
    });
    const decoded = await decodeRgba(rendered.png);
    const cyan = [
      NATIVE_PREVIEW_OBJECT_COLOR.r,
      NATIVE_PREVIEW_OBJECT_COLOR.g,
      NATIVE_PREVIEW_OBJECT_COLOR.b,
      NATIVE_PREVIEW_OBJECT_COLOR.a,
    ] as const;

    expect(pixel(decoded, 0, 4)).toEqual(cyan);
    expect(pixel(decoded, 15, 6)).toEqual(cyan);
    expect(pixel(decoded, 0, 8)).toEqual(cyan);
    expect(rendered.objectDebugOverlay.entries).toEqual([
      {
        sourceIndex: 0,
        objectId: 1,
        layerId: 2,
        shape: "ellipse",
        representation: "geometry-outline",
        rendered: false,
        clipped: true,
      },
      {
        sourceIndex: 1,
        objectId: 2,
        layerId: 2,
        shape: "capsule",
        representation: "geometry-outline",
        rendered: true,
        clipped: true,
      },
    ]);
  });

  it("rejects curve tessellation overflow per object and in aggregate", async () => {
    const base = {
      tileWidth: 16,
      tileHeight: 16,
      region: { x: 0, y: 0, width: 1, height: 1 },
      layers: [],
      atlases: [],
      scale: 1,
      overlays: {
        grid: false,
        coordinates: false,
      },
    } as const;
    const scaleSensitiveCurve = curveDebug(
      0,
      1,
      "ellipse",
      {
        x: 0,
        y: 0,
        width: 1_000_000,
        height: 1_000_000,
      },
    );
    const scaleOne = await renderNativePreview({
      ...base,
      overlays: {
        ...base.overlays,
        objectDebug: [scaleSensitiveCurve],
      },
    });
    expect(
      scaleOne.objectDebugOverlay.selectedObjectCount,
    ).toBe(1);
    await expect(
      renderNativePreview({
        ...base,
        scale: 2,
        overlays: {
          ...base.overlays,
          objectDebug: [scaleSensitiveCurve],
        },
      }),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        objectId: 1,
        requiredSegments: 4_444,
        limit:
          MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
      },
    });
    await expect(
      renderNativePreview({
        ...base,
        overlays: {
          ...base.overlays,
          objectDebug: [
            curveDebug(0, 1, "ellipse", {
              x: 0,
              y: 0,
              width: 2_000_000,
              height: 2_000_000,
            }),
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        objectId: 1,
        requiredSegments: 4_444,
        limit:
          MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS,
      },
    });

    const aggregateObjects = Array.from(
      { length: MAX_NATIVE_PREVIEW_OBJECTS },
      (_, index) =>
        curveDebug(
          index,
          index + 1,
          "ellipse",
          {
            x: -53_150,
            y: -53_150,
            width: 106_300,
            height: 106_300,
          },
        ),
    );
    await expect(
      renderNativePreview({
        ...base,
        overlays: {
          ...base.overlays,
          objectDebug: aggregateObjects,
        },
      }),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
      details: {
        sourceIndex: 63,
        objectId: 64,
        actual: 65_792,
        limit:
          MAX_NATIVE_PREVIEW_OBJECT_CURVE_SEGMENTS_AGGREGATE,
      },
    });

    const exactBoundary = await renderNativePreview({
      ...base,
      overlays: {
        ...base.overlays,
        objectDebug: Array.from(
          { length: MAX_NATIVE_PREVIEW_OBJECTS },
          (_, index) =>
            curveDebug(
              index,
              index + 1,
              "ellipse",
              {
                x: -53_100,
                y: -53_100,
                width: 106_200,
                height: 106_200,
              },
            ),
        ),
      },
    });
    expect(
      exactBoundary.objectDebugOverlay
        .selectedObjectCount,
    ).toBe(MAX_NATIVE_PREVIEW_OBJECTS);
  });

  it("rejects empty, oversized, duplicate and structurally loose object debug inputs", async () => {
    const base = {
      tileWidth: 8,
      tileHeight: 8,
      region: { x: 0, y: 0, width: 1, height: 1 },
      layers: [],
      atlases: [],
      scale: 1,
    } as const;
    await expect(
      renderNativePreview({
        ...base,
        overlays: {
          grid: false,
          coordinates: false,
          objectDebug: [],
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      renderNativePreview({
        ...base,
        overlays: {
          grid: false,
          coordinates: false,
          objectDebug: Array.from(
            { length: MAX_NATIVE_PREVIEW_OBJECTS + 1 },
            (_, index) => pointDebug(index, index + 1),
          ),
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      renderNativePreview({
        ...base,
        overlays: {
          grid: false,
          coordinates: false,
          objectDebug: [
            pointDebug(0, 1),
            pointDebug(1, 1),
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      renderNativePreview({
        ...base,
        overlays: {
          grid: false,
          coordinates: false,
          objectDebug: [
            {
              ...pointDebug(0, 1),
              label: "not-supported",
            } as NativePreviewObjectInput,
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const missingHeight = curveDebug(
      0,
      1,
      "ellipse",
      {
        x: 0,
        y: 0,
        width: 4,
        height: 4,
      },
    );
    delete missingHeight.height;
    await expect(
      renderNativePreview({
        ...base,
        overlays: {
          grid: false,
          coordinates: false,
          objectDebug: [missingHeight],
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      renderNativePreview({
        ...base,
        overlays: {
          grid: false,
          coordinates: false,
          objectDebug: [
            curveDebug(0, 1, "capsule", {
              x: 0,
              y: 0,
              width: -1,
              height: 4,
            }),
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
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

function pointDebug(
  sourceIndex: number,
  objectId: number,
): NativePreviewObjectInput {
  return {
    sourceIndex,
    objectId,
    layerId: 2,
    shape: "point",
    representation: "geometry-outline",
    x: 4,
    y: 4,
    rotation: 0,
  };
}

function curveDebug(
  sourceIndex: number,
  objectId: number,
  shape: "ellipse" | "capsule",
  geometry: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
  },
): NativePreviewObjectInput {
  return {
    sourceIndex,
    objectId,
    layerId: 2,
    shape,
    representation: "geometry-outline",
    x: geometry.x,
    y: geometry.y,
    rotation: geometry.rotation ?? 0,
    width: geometry.width,
    height: geometry.height,
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
