import { describe, expect, it } from "vitest";

import {
  nativePreviewToolOutputSchema,
} from "../src/outputSchemas/read.js";

const REVISION =
  `sha256:${"0".repeat(64)}` as const;

function validOutput(): Record<string, unknown> {
  return {
    result: {
      mimeType: "image/png",
      pixelSize: { width: 32, height: 32 },
      byteLength: 1,
      sha256: REVISION,
      map: {
        path: "maps/example.tmj",
        revision: REVISION,
      },
      dependencyRevisions: {},
      sources: [],
      tileRegion: {
        x: 4,
        y: 6,
        width: 2,
        height: 2,
      },
      coordinateTransform: {
        tileOrigin: { x: 4, y: 6 },
        pixelOrigin: { x: 0, y: 0 },
        pixelsPerTile: { x: 16, y: 16 },
      },
      contentPixelRect: {
        x: 0,
        y: 0,
        width: 32,
        height: 32,
      },
      layerIds: [],
      layerSelection: "visible",
      omittedLayers: [],
      omittedLayerCount: 0,
      omittedLayersTruncated: false,
      partial: false,
      snapshotConsistency:
        "non-atomic-read-set",
      scale: 1,
      overlays: {
        grid: false,
        coordinates: false,
        highlights: {
          style: "selection-amber-v1",
          entries: [
            {
              sourceIndex: 0,
              requestedTileRect: {
                x: 3,
                y: 6,
                width: 2,
                height: 2,
              },
              renderedTileRect: {
                x: 4,
                y: 6,
                width: 1,
                height: 2,
              },
              clipped: true,
            },
            {
              sourceIndex: 1,
              requestedTileRect: {
                x: 4,
                y: 6,
                width: 2,
                height: 2,
              },
              renderedTileRect: {
                x: 4,
                y: 6,
                width: 2,
                height: 2,
              },
              clipped: false,
            },
          ],
          highlightedTileCount: 4,
          color: {
            r: 250,
            g: 204,
            b: 21,
            a: 96,
          },
          blendMode: "source-over",
          overlapMode: "tile-union",
        },
        objectDebug: {
          profile:
            "explicit-basic-object-geometry-v4",
          style: "geometry-cyan-v1",
          color: {
            r: 34,
            g: 211,
            b: 238,
            a: 255,
          },
          strokeWidth: 1,
          originMarker: "crosshair-5px",
          idLabels: false,
          visibilityPolicy:
            "explicit-ignore-object-and-layer-visibility-opacity",
          drawOrder:
            "after-highlights-and-grid-before-coordinates",
          quantization:
            "round-nearest-output-pixel",
          curveTessellation: {
            algorithm:
              "uniform-angle-output-sagitta-v1",
            maximumChordErrorPixels: 0.25,
            minimumSegments: 12,
            maximumSegmentsPerObject: 4_096,
            maximumAggregateSegments: 65_536,
            segmentMultiple: 4,
            errorSpace:
              "continuous-output-before-quantization",
            overflowPolicy:
              "reject-whole-preview",
            offscreenPolicy:
              "conservative-rotated-bounds-skip-before-tessellation",
            capsuleConstruction:
              "two-semicircles-plus-two-straight-segments",
            degenerateExtent:
              "tiled-1.12-single-zero-line-double-zero-anchor-centered-20-map-pixel-circle",
          },
          tileObjectFrames: {
            source:
              "tiled-1.12-object-outline-rect",
            alignmentResolution:
              "tileset-objectalignment-unspecified-bottom-left",
            tileOffsetScaling:
              "scaled-by-object-over-tile-size",
            missingDimensionDefault:
              "tileset-tile-size",
            flipFlags:
              "image-only-outline-unchanged",
            rotationCenter: "object-anchor",
            danglingGidPolicy: "fail-closed",
            imageRendering: false,
            collisionShapes: "explicit-opt-in",
          },
          tileObjectCollision: {
            source:
              "tiled-1.12-show-tile-collision-shapes",
            selection:
              "explicit-tile-object-selection-opt-in",
            transform:
              "tile-image-fragment-affine-with-inner-shape-rotation",
            flipFlags: "applied-like-tile-image",
            groupMetadata:
              "position-draworder-color-visibility-ignored",
            hiddenCollisionObjects: "drawn",
            markerPrecedence:
              "single-shape-marker-only-fail-closed-on-conflict",
            pointObjects:
              "fixed-5px-output-crosshair",
            curveSegmentPlanning:
              "affine-spectral-norm-output-radius",
            offscreenPolicy:
              "clip-after-tessellation",
            nestedTileOrTemplateObjects:
              "fail-closed",
            fillMode: "stretch-only-fail-closed",
            styling:
              "shared-geometry-cyan-outline-no-fill",
          },
          selectedObjectCount: 0,
          renderedObjectCount: 0,
          entries: [],
        },
      },
      objectLayers: [],
      objectLayerRendering: {
        profile: "base-object-layers-v1",
        colors:
          "group-color-else-gray-class-colors-unsupported",
        fillAlpha: 50,
        shadow: "one-pixel-black-offset",
        stroke: "one-pixel-cosmetic",
        text: "layout-box-only",
        tileObjects: "omitted-counted",
        templates: "omitted-counted",
        pointMarker:
          "tiled-pin-cosmetic-radius-10",
        drawOrder:
          "tiled-topdown-stable-or-index",
        opacity:
          "layer-times-object-source-over",
      },
      renderProfile:
        "finite-orthogonal-static-atlas-tilelayers-v1",
      truncated: false,
    },
  };
}

function resultOf(
  output: Record<string, unknown>,
): Record<string, unknown> {
  return output.result as Record<string, unknown>;
}

function highlightsOf(
  output: Record<string, unknown>,
): Record<string, unknown> {
  const result = resultOf(output);
  const overlays = result.overlays as Record<
    string,
    unknown
  >;
  return overlays.highlights as Record<
    string,
    unknown
  >;
}

function entriesOf(
  output: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return highlightsOf(output).entries as Array<
    Record<string, unknown>
  >;
}

describe("native preview highlight output schema", () => {
  it("accepts ordered clipped metadata and a tile-union count", () => {
    expect(
      nativePreviewToolOutputSchema.safeParse(
        validOutput(),
      ).success,
    ).toBe(true);
  });

  it.each([
    {
      name: "ordered source index",
      mutate(output: Record<string, unknown>) {
        const first = entriesOf(output)[0];
        if (first !== undefined) {
          first.sourceIndex = 1;
        }
      },
    },
    {
      name: "exact rendered intersection",
      mutate(output: Record<string, unknown>) {
        const first = entriesOf(output)[0];
        if (first !== undefined) {
          first.renderedTileRect = {
            x: 4,
            y: 6,
            width: 1,
            height: 1,
          };
        }
      },
    },
    {
      name: "exact clipped flag",
      mutate(output: Record<string, unknown>) {
        const first = entriesOf(output)[0];
        if (first !== undefined) {
          first.clipped = false;
        }
      },
    },
    {
      name: "exact highlighted tile union",
      mutate(output: Record<string, unknown>) {
        highlightsOf(output).highlightedTileCount =
          3;
      },
    },
  ])("rejects a forged $name", ({ mutate }) => {
    const output = validOutput();
    mutate(output);
    expect(
      nativePreviewToolOutputSchema.safeParse(
        output,
      ).success,
    ).toBe(false);
  });
});
