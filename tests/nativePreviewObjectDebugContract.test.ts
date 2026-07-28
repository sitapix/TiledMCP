import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";

import type {
  TiledCliAdapter,
  TiledCliCapabilities,
} from "../src/adapters/tiledCli.js";
import type { MapService } from "../src/maps/mapService.js";
import {
  nativePreviewToolOutputSchema,
} from "../src/outputSchemas/read.js";
import type { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  TILED_MCP_CORE_TOOL_NAMES,
  createTiledMcpServerFromCapabilitySnapshot,
} from "../src/server.js";
import type { DocumentStore } from "../src/storage/documentStore.js";

const REVISION =
  `sha256:${"0".repeat(64)}` as const;

function validResult(): Record<string, unknown> {
  return {
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
      x: 0,
      y: 0,
      width: 2,
      height: 2,
    },
    coordinateTransform: {
      tileOrigin: { x: 0, y: 0 },
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
        entries: [],
        highlightedTileCount: 0,
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
          overflowPolicy: "reject-whole-preview",
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
          offscreenPolicy: "clip-after-tessellation",
          nestedTileOrTemplateObjects: "fail-closed",
          fillMode: "stretch-only-fail-closed",
          styling:
            "shared-geometry-cyan-outline-no-fill",
        },
        selectedObjectCount: 2,
        renderedObjectCount: 1,
        entries: [
          {
            sourceIndex: 0,
            objectId: 17,
            layerId: 8,
            shape: "rectangle",
            representation:
              "geometry-outline",
            rendered: true,
            clipped: false,
          },
          {
            sourceIndex: 1,
            objectId: 23,
            layerId: 9,
            shape: "text",
            representation: "text-box-only",
            rendered: false,
            clipped: true,
          },
        ],
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
      tileObjects:
        "affine-nearest-neighbor-images",
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
  };
}

function validOutput(): Record<string, unknown> {
  return { result: validResult() };
}

function objectDebugOf(
  output: Record<string, unknown>,
): Record<string, unknown> {
  const result = output.result as Record<
    string,
    unknown
  >;
  const overlays = result.overlays as Record<
    string,
    unknown
  >;
  return overlays.objectDebug as Record<
    string,
    unknown
  >;
}

function entriesOf(
  output: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return objectDebugOf(output).entries as Array<
    Record<string, unknown>
  >;
}

describe("native preview object debug output contract", () => {
  it("accepts the fixed metadata and ordered basic-object entries", () => {
    expect(
      nativePreviewToolOutputSchema.safeParse(
        validOutput(),
      ).success,
    ).toBe(true);
  });

  it.each(["ellipse", "capsule"] as const)(
    "accepts a %s geometry-outline entry",
    (shape) => {
      const output = validOutput();
      const first = entriesOf(output)[0];
      if (first === undefined) {
        throw new Error("Missing object debug entry.");
      }
      first.shape = shape;
      expect(
        nativePreviewToolOutputSchema.safeParse(
          output,
        ).success,
      ).toBe(true);
    },
  );

  it("accepts a tile entry only with its tile-frame-only representation", () => {
    const output = validOutput();
    const first = entriesOf(output)[0];
    if (first === undefined) {
      throw new Error("Missing object debug entry.");
    }
    first.shape = "tile";
    expect(
      nativePreviewToolOutputSchema.safeParse(
        output,
      ).success,
    ).toBe(false);
    first.representation = "tile-frame-only";
    expect(
      nativePreviewToolOutputSchema.safeParse(
        output,
      ).success,
    ).toBe(true);
  });

  it("rejects a fixed tile-object frame contract drift", () => {
    const output = validOutput();
    const frames = objectDebugOf(output)
      .tileObjectFrames as Record<string, unknown>;
    frames.flipFlags = "geometry-follows-flips";
    expect(
      nativePreviewToolOutputSchema.safeParse(
        output,
      ).success,
    ).toBe(false);
  });

  it.each([
    {
      name: "object debug extension field",
      mutate(output: Record<string, unknown>) {
        objectDebugOf(output).extra = true;
      },
    },
    {
      name: "entry extension field",
      mutate(output: Record<string, unknown>) {
        const first = entriesOf(output)[0];
        if (first !== undefined) {
          first.extra = true;
        }
      },
    },
    {
      name: "fixed profile",
      mutate(output: Record<string, unknown>) {
        objectDebugOf(output).profile =
          "other-profile";
      },
    },
    {
      name: "fixed curve tessellation",
      mutate(output: Record<string, unknown>) {
        const curve =
          objectDebugOf(output)
            .curveTessellation as Record<
            string,
            unknown
          >;
        curve.maximumChordErrorPixels = 1;
      },
    },
    {
      name: "curve tessellation extension field",
      mutate(output: Record<string, unknown>) {
        const curve =
          objectDebugOf(output)
            .curveTessellation as Record<
            string,
            unknown
          >;
        curve.extra = true;
      },
    },
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
      name: "selected object count",
      mutate(output: Record<string, unknown>) {
        objectDebugOf(output).selectedObjectCount =
          1;
      },
    },
    {
      name: "unique object IDs",
      mutate(output: Record<string, unknown>) {
        const entries = entriesOf(output);
        const first = entries[0];
        const second = entries[1];
        if (first !== undefined && second !== undefined) {
          second.objectId = first.objectId;
        }
      },
    },
    {
      name: "rendered object count",
      mutate(output: Record<string, unknown>) {
        objectDebugOf(output).renderedObjectCount =
          2;
      },
    },
    {
      name: "shape representation",
      mutate(output: Record<string, unknown>) {
        const second = entriesOf(output)[1];
        if (second !== undefined) {
          second.representation =
            "geometry-outline";
        }
      },
    },
    {
      name: "non-rendered clipping",
      mutate(output: Record<string, unknown>) {
        const second = entriesOf(output)[1];
        if (second !== undefined) {
          second.clipped = false;
        }
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

interface RegisteredTool {
  inputSchema?: ZodType;
}

interface ToolResponse {
  content: Array<{
    type: string;
    text?: string;
  }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

describe("native preview object debug server contract", () => {
  let client: Client;
  let server: McpServer;
  let registeredTools: string[];
  let previewInputSchema: ZodType;
  const renderPreview = vi.fn(
    async (input: unknown) => ({
      png: Buffer.from([0]),
      result: validResult(),
      input,
    }),
  );

  beforeAll(async () => {
    const maps = {
      initializeAssetRegistry:
        vi.fn(async () => undefined),
      renderPreview,
    } as unknown as MapService;
    const store = {
      checkpoints: {
        maxBytes: 64 * 1024 * 1024,
        maxEntries: 1_024,
        retainCommittedPerTarget:
          undefined,
      },
    } as unknown as DocumentStore;
    const cliCapabilities: TiledCliCapabilities = {
      tiled: {
        executable: "tiled",
        available: false,
        version: null,
        mapExportFormats: [],
        tilesetExportFormats: [],
        issues: [],
      },
      rasterizer: {
        executable: "tmxrasterizer",
        available: false,
        version: null,
        issues: [],
      },
    };
    const created =
      await createTiledMcpServerFromCapabilitySnapshot(
        {
          resolver:
            {} as ProjectPathResolver,
          store,
          maps,
          cli: {} as TiledCliAdapter,
        },
        cliCapabilities,
      );
    server = created.server;
    registeredTools = created.registeredTools;
    const registration = (
      server as unknown as {
        _registeredTools: Record<
          string,
          RegisteredTool
        >;
      }
    )._registeredTools.tiled_render_preview;
    if (registration?.inputSchema === undefined) {
      throw new Error(
        "Missing native preview input schema",
      );
    }
    previewInputSchema = registration.inputSchema;

    client = new Client(
      {
        name: "object-debug-contract-test",
        version: "0.0.0",
      },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });

  it("keeps the tool set stable and advertises the object debug limits", async () => {
    expect(registeredTools).toEqual([
      ...TILED_MCP_CORE_TOOL_NAMES,
    ]);
    expect(registeredTools).toHaveLength(42);

    const response = (await client.callTool({
      name: "tiled_get_capabilities",
      arguments: {},
    })) as ToolResponse;
    expect(response.isError).not.toBe(true);
    const capabilities = (
      response.structuredContent as {
        result: {
          nativePreviewCapabilities: {
            overlays: string[];
            objectDebug: Record<
              string,
              unknown
            >;
          };
          limits: Record<string, unknown>;
        };
      }
    ).result;
    expect(
      capabilities.nativePreviewCapabilities
        .overlays,
    ).toContain("objectIds");
    expect(
      capabilities.nativePreviewCapabilities
        .objectDebug,
    ).toMatchObject({
      selection: "explicit-object-ids",
      maxObjects: 64,
      maxAggregatePoints: 8_192,
      duplicateObjectIds: "reject",
      supportedShapes: [
        "rectangle",
        "point",
        "ellipse",
        "capsule",
        "polygon",
        "polyline",
        "text",
        "tile",
      ],
      representations: [
        "geometry-outline",
        "text-box-only",
        "tile-frame-only",
        "tile-frame-and-collision",
      ],
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
        overflowPolicy: "reject-whole-preview",
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
        offscreenPolicy: "clip-after-tessellation",
        nestedTileOrTemplateObjects: "fail-closed",
        fillMode: "stretch-only-fail-closed",
        styling:
          "shared-geometry-cyan-outline-no-fill",
      },
      workBudget:
        "included-in-native-preview-pixel-blend-limit",
      limitations: [
        "explicit-selection-only",
        "tile-frame-only-no-image-or-collision-rendering",
        "text-box-only-no-glyph-rendering",
        "template-objects-unsupported",
        "non-default-selected-layer-or-ancestor-positioning-unsupported",
      ],
    });
    expect(
      capabilities.limits
        .maxNativePreviewObjects,
    ).toBe(64);
    expect(capabilities.limits).toMatchObject({
      maxNativePreviewObjectCurveSegments:
        4_096,
      maxNativePreviewObjectCurveSegmentsAggregate:
        65_536,
    });
  });

  it("accepts one through sixty-four unique positive safe object IDs", () => {
    expect(
      previewInputSchema.safeParse({
        mapPath: "maps/example.tmj",
        overlays: { objectIds: [1] },
      }).success,
    ).toBe(true);
    expect(
      previewInputSchema.safeParse({
        mapPath: "maps/example.tmj",
        overlays: {
          objectIds: Array.from(
            { length: 64 },
            (_, index) => index + 1,
          ),
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    {
      name: "empty selection",
      objectIds: [],
    },
    {
      name: "too many IDs",
      objectIds: Array.from(
        { length: 65 },
        (_, index) => index + 1,
      ),
    },
    {
      name: "duplicate IDs",
      objectIds: [1, 1],
    },
    {
      name: "zero ID",
      objectIds: [0],
    },
    {
      name: "fractional ID",
      objectIds: [1.5],
    },
    {
      name: "unsafe ID",
      objectIds: [
        Number.MAX_SAFE_INTEGER + 1,
      ],
    },
  ])("rejects $name", ({ objectIds }) => {
    expect(
      previewInputSchema.safeParse({
        mapPath: "maps/example.tmj",
        overlays: { objectIds },
      }).success,
    ).toBe(false);
  });

  it("passes object IDs to MapService in input order", async () => {
    renderPreview.mockClear();
    const response = (await client.callTool({
      name: "tiled_render_preview",
      arguments: {
        mapPath: "maps/example.tmj",
        scale: 1,
        overlays: {
          objectIds: [23, 17],
        },
      },
    })) as ToolResponse;
    expect(response.isError).not.toBe(true);
    expect(renderPreview).toHaveBeenCalledWith({
      mapPath: "maps/example.tmj",
      scale: 1,
      overlays: {
        objectIds: [23, 17],
      },
    });
  });
});
