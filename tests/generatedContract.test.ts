import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { beforeAll, describe, expect, it } from "vitest";

import {
  APPLICATION_ERRORS_RELATIVE_PATH,
  generateMcpContractArtifacts,
  MCP_CONTRACT_RELATIVE_PATH,
  MCP_REFERENCE_RELATIVE_PATH,
  type GeneratedMcpContractArtifacts,
} from "../scripts/generate-mcp-contract.js";
import {
  TILED_MCP_APPLICATION_ERROR_CODES,
  TILED_MCP_APPLICATION_ERROR_REGISTRY,
  TILED_MCP_CAPABILITY_ISSUE_CODES,
} from "../src/errorRegistry.js";
import {
  TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT,
} from "../src/filesystemThreatModelContract.js";
import {
  APPLICATION_ERROR_RESOURCE_META,
  APPLICATION_ERROR_RESOURCE_MIME_TYPE,
  APPLICATION_ERROR_RESOURCE_REVISION,
  APPLICATION_ERROR_RESOURCE_SIZE,
  APPLICATION_ERROR_RESOURCE_URI,
} from "../src/resources/applicationErrors.js";
import {
  CHECKPOINT_STORAGE_POLICY,
} from "../src/storage/checkpoints.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ANNOTATION_KEYS = [
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
  "readOnlyHint",
  "title",
] as const;
const BOOLEAN_ANNOTATION_KEYS = [
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
  "readOnlyHint",
] as const;
const EXPECTED_TEXT_OBJECT_CAPABILITIES = {
  wireLayout:
    "flat-on-create-object-and-update-patch",
  fields: [
    "text",
    "fontFamily",
    "pixelSize",
    "wrap",
    "color",
    "bold",
    "italic",
    "underline",
    "strikeout",
    "kerning",
    "horizontalAlignment",
    "verticalAlignment",
  ],
  dimensions:
    "optional-nonnegative-default-zero",
  content: {
    field: "text",
    required: true,
    emptyAllowed: true,
    lengthUnit: "unicode-code-points",
    maximum: 4_096,
    maximumUtf8Bytes: 16_384,
    unicode:
      "well-formed-no-unpaired-surrogates",
    allowedControlCodePoints: [
      "U+0009",
      "U+000A",
      "U+000D",
    ],
  },
  fontFamily: {
    minimum: 1,
    maximum: 256,
    maximumUtf8Bytes: 1_024,
    lengthUnit: "unicode-code-points",
    default: "sans-serif",
    unicode:
      "well-formed-no-unpaired-surrogates",
    allowedControlCodePoints: [],
  },
  pixelSize: {
    integer: true,
    minimum: 1,
    maximum: 999,
    default: 16,
  },
  color: {
    formats: ["#RRGGBB", "#AARRGGBB"],
    default: "#000000",
  },
  horizontalAlignment: {
    values: [
      "left",
      "center",
      "right",
      "justify",
    ],
    default: "left",
  },
  verticalAlignment: {
    values: ["top", "center", "bottom"],
    default: "top",
  },
  booleanDefaults: {
    wrap: false,
    bold: false,
    italic: false,
    underline: false,
    strikeout: false,
    kerning: true,
  },
  payloadBudget: {
    measure: "canonical-json-utf8-bytes",
    scope:
      "all-present-flat-text-fields-per-operation-summed",
    maximumPerChangeSet: 262_144,
  },
  updates:
    "common-fields-dimensions-and-partial-flat-text-fields",
  serialization:
    "nested-tmj-text-with-tiled-default-elision",
} as const;

describe("generated MCP contract", () => {
  let generated: GeneratedMcpContractArtifacts;
  let generatedAgain: GeneratedMcpContractArtifacts;
  let committedApplicationErrors: Buffer;
  let committedContract: Buffer;
  let committedReference: Buffer;
  let contract: Record<string, unknown>;

  beforeAll(async () => {
    [generated, generatedAgain] = [
      await generateMcpContractArtifacts(),
      await generateMcpContractArtifacts(),
    ];
    [
      committedApplicationErrors,
      committedContract,
      committedReference,
    ] =
      await Promise.all([
        readFile(
          resolve(
            REPOSITORY_ROOT,
            APPLICATION_ERRORS_RELATIVE_PATH,
          ),
        ),
        readFile(
          resolve(
            REPOSITORY_ROOT,
            MCP_CONTRACT_RELATIVE_PATH,
          ),
        ),
        readFile(
          resolve(
            REPOSITORY_ROOT,
            MCP_REFERENCE_RELATIVE_PATH,
          ),
        ),
      ]);
    contract = asRecord(
      JSON.parse(generated.contractJson) as unknown,
      "contract",
    );
  }, 20_000);

  it("matches the committed artifacts and is deterministic", () => {
    expect(
      Buffer.from(
        generated.applicationErrorsJson,
        "utf8",
      ),
    ).toEqual(committedApplicationErrors);
    expect(
      Buffer.from(generated.contractJson, "utf8"),
    ).toEqual(committedContract);
    expect(
      Buffer.from(generated.referenceMarkdown, "utf8"),
    ).toEqual(committedReference);
    expect(generatedAgain).toEqual(generated);
  });

  it("describes the exact core and rasterizer tool surfaces", () => {
    expect(contract.format).toBe(
      "tiled-mcp-discovery-contract",
    );
    expect(contract.formatVersion).toBe(1);

    const profiles = asRecord(
      contract.profiles,
      "contract.profiles",
    );
    const coreTools = asStringArray(
      asRecord(
        profiles.core,
        "contract.profiles.core",
      ).toolOrder,
      "contract.profiles.core.toolOrder",
    );
    const fullTools = asStringArray(
      asRecord(
        profiles["with-tmxrasterizer"],
        "contract.profiles.with-tmxrasterizer",
      ).toolOrder,
      "contract.profiles.with-tmxrasterizer.toolOrder",
    );

    expect(coreTools).toHaveLength(26);
    expect(fullTools).toHaveLength(27);
    expect(new Set(coreTools).size).toBe(26);
    expect(new Set(fullTools).size).toBe(27);
    expect(
      fullTools.filter(
        (name) => !new Set(coreTools).has(name),
      ),
    ).toEqual(["tiled_render_map"]);
    expect(
      coreTools.filter(
        (name) => !new Set(fullTools).has(name),
      ),
    ).toEqual([]);

    const toolDefinitions = asRecordArray(
      contract.toolDefinitions,
      "contract.toolDefinitions",
    );
    const toolNames = toolDefinitions.map((tool, index) =>
      asString(
        tool.name,
        `contract.toolDefinitions[${index}].name`,
      ),
    );

    expect(toolDefinitions).toHaveLength(27);
    expect(new Set(toolNames).size).toBe(27);
    expect([...toolNames].sort()).toEqual(
      [...fullTools].sort(),
    );

    for (const [index, tool] of toolDefinitions.entries()) {
      const label = `contract.toolDefinitions[${index}]`;
      expectClosedRootObjectSchema(
        tool.inputSchema,
        `${label}.inputSchema`,
      );
      expectClosedRootObjectSchema(
        tool.outputSchema,
        `${label}.outputSchema`,
      );
      expect(
        countExactEnums(
          tool.outputSchema,
          TILED_MCP_APPLICATION_ERROR_CODES,
        ),
        `${label}.outputSchema application error enum`,
      ).toBe(1);

      const annotations = asRecord(
        tool.annotations,
        `${label}.annotations`,
      );
      expect(Object.keys(annotations).sort()).toEqual(
        [...ANNOTATION_KEYS].sort(),
      );
      expect(
        asString(
          annotations.title,
          `${label}.annotations.title`,
        ).length,
      ).toBeGreaterThan(0);
      for (const key of BOOLEAN_ANNOTATION_KEYS) {
        expect(
          typeof annotations[key],
          `${label}.annotations.${key}`,
        ).toBe("boolean");
      }
    }

    const capabilitiesIndex =
      toolNames.indexOf("tiled_get_capabilities");
    expect(capabilitiesIndex).toBeGreaterThanOrEqual(0);
    const capabilitiesTool =
      toolDefinitions[capabilitiesIndex];
    if (capabilitiesTool === undefined) {
      throw new Error(
        "Missing tiled_get_capabilities definition",
      );
    }
    const capabilitiesLabel =
      `contract.toolDefinitions[${capabilitiesIndex}]`;
    const capabilitySuccessSchema =
      findCapabilitySuccessSchema(
        capabilitiesTool.outputSchema,
        `${capabilitiesLabel}.outputSchema`,
      );
    const cliSchema = schemaProperty(
      capabilitySuccessSchema,
      "cli",
      `${capabilitiesLabel} capability result`,
    );
    for (const toolKind of [
      "tiled",
      "rasterizer",
    ] as const) {
      const toolSchema = schemaProperty(
        cliSchema,
        toolKind,
        `${capabilitiesLabel} cli`,
      );
      const issuesSchema = schemaProperty(
        toolSchema,
        "issues",
        `${capabilitiesLabel} cli.${toolKind}`,
      );
      const issueSchema = asRecord(
        issuesSchema.items,
        `${capabilitiesLabel} cli.${toolKind}.issues.items`,
      );
      const codeSchema = schemaProperty(
        issueSchema,
        "code",
        `${capabilitiesLabel} cli.${toolKind}.issues item`,
      );
      expect(
        asStringArray(
          codeSchema.enum,
          `${capabilitiesLabel} cli.${toolKind}.issues code enum`,
        ),
      ).toEqual(TILED_MCP_CAPABILITY_ISSUE_CODES);
    }
    expect(
      countExactEnums(
        capabilitiesTool.outputSchema,
        TILED_MCP_CAPABILITY_ISSUE_CODES,
      ),
    ).toBe(2);

    const nativePreviewCapabilitiesSchema =
      schemaProperty(
        capabilitySuccessSchema,
        "nativePreviewCapabilities",
        `${capabilitiesLabel} capability result`,
      );
    expectExactLiteralSchema(
      schemaProperty(
        nativePreviewCapabilitiesSchema,
        "highlightRectangles",
        `${capabilitiesLabel} nativePreviewCapabilities`,
      ),
      {
        coordinateSpace: "absolute-map-tiles",
        maxRectangles: 64,
        intersectionPolicy:
          "require-intersection-and-clip-to-tile-region",
        style: "selection-amber-v1",
        color: { r: 250, g: 204, b: 21, a: 96 },
        blendMode: "source-over",
        overlapMode: "tile-union",
        border: "none",
        drawOrder:
          "after-tile-layers-before-grid-and-coordinates",
        workBudget:
          "included-in-native-preview-pixel-blend-limit",
      },
      `${capabilitiesLabel} native preview highlights`,
    );
    expectExactLiteralSchema(
      schemaProperty(
        nativePreviewCapabilitiesSchema,
        "overlays",
        `${capabilitiesLabel} nativePreviewCapabilities`,
      ),
      [
        "grid",
        "coordinates",
        "highlights",
        "objectIds",
        "tileObjectCollision",
      ],
      `${capabilitiesLabel} native preview overlays`,
    );
    expectExactLiteralSchema(
      schemaProperty(
        nativePreviewCapabilitiesSchema,
        "objectDebug",
        `${capabilitiesLabel} nativePreviewCapabilities`,
      ),
      {
        selection: "explicit-object-ids",
        maxObjects: 64,
        maxAggregatePoints: 8_192,
        pointBudget:
          "selected-polygon-and-polyline-points",
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
      },
      `${capabilitiesLabel} native preview object debug`,
    );
    expectExactLiteralSchema(
      schemaProperty(
        capabilitySuccessSchema,
        "tileRenderCapabilities",
        `${capabilitiesLabel} capability result`,
      ),
      {
        locator:
          "map-path-plus-tileset-asset-id",
        renderProfile:
          "explicit-local-id-atlas-selection-v1",
        atlasProfile:
          "root-atlas-no-per-tile-images",
        supportedFormats: [
          "png",
          "jpeg",
          "webp",
          "simple-svg",
        ],
        selection: "explicit-local-ids",
        localIdOrder: "input-preserved",
        duplicateLocalIds: "reject",
        selectionReduction: "never",
        layout: "row-major",
        columnsSemantics: "maximum-per-row",
        labels: "local-id",
        defaultColumns: 8,
        defaultScale: 2,
        revisionPins: "independent-optional",
        animation: false,
        wangGrouping: false,
        semanticNames: false,
      },
      `${capabilitiesLabel} selected tile renderer`,
    );
    const nativePreviewLimitsSchema =
      schemaProperty(
        capabilitySuccessSchema,
        "limits",
        `${capabilitiesLabel} capability result`,
      );
    expect(
      schemaProperty(
        nativePreviewLimitsSchema,
        "maxNativePreviewHighlights",
        `${capabilitiesLabel} limits`,
      ).const,
    ).toBe(64);
    expect(
      schemaProperty(
        nativePreviewLimitsSchema,
        "maxNativePreviewObjects",
        `${capabilitiesLabel} limits`,
      ).const,
    ).toBe(64);
    expect(
      schemaProperty(
        nativePreviewLimitsSchema,
        "maxNativePreviewObjectCurveSegments",
        `${capabilitiesLabel} limits`,
      ).const,
    ).toBe(4_096);
    expect(
      schemaProperty(
        nativePreviewLimitsSchema,
        "maxNativePreviewObjectCurveSegmentsAggregate",
        `${capabilitiesLabel} limits`,
      ).const,
    ).toBe(65_536);
    expect(
      schemaProperty(
        nativePreviewLimitsSchema,
        "maxPendingObjectShapePoints",
        `${capabilitiesLabel} limits`,
      ).const,
    ).toBe(65_536);
    expect(
      schemaProperty(
        nativePreviewLimitsSchema,
        "maxPendingTextObjectPayloadBytes",
        `${capabilitiesLabel} limits`,
      ).const,
    ).toBe(2_097_152);
    for (const [name, expected] of [
      ["maxTileRenderLocalIds", 64],
      ["maxTileRenderColumns", 32],
      ["maxTileRenderScale", 4],
      ["maxTileRenderBytes", 8 * 1024 * 1024],
      ["maxTileRenderEdge", 2_048],
      ["maxTileRenderPixels", 1_500_000],
    ] as const) {
      expect(
        schemaProperty(
          nativePreviewLimitsSchema,
          name,
          `${capabilitiesLabel} limits`,
        ).const,
      ).toBe(expected);
    }

    const objectShapeCapabilitiesSchema =
      schemaProperty(
        capabilitySuccessSchema,
        "objectShapeCapabilities",
        `${capabilitiesLabel} capability result`,
      );
    expectExactLiteralSchema(
      schemaProperty(
        objectShapeCapabilitiesSchema,
        "polygonAndPolylinePoints",
        `${capabilitiesLabel} objectShapeCapabilities`,
      ),
      {
        coordinateSpace:
          "object-local-pixels-relative-to-x-y",
        polygonMinimum: 3,
        polylineMinimum: 2,
        maximum: 256,
        maximumPerChangeSet: 8_192,
        replacement: "whole-array",
        budgetScope:
          "create-and-update-points-per-operation-summed",
        order: "preserved",
        polygonClosure: "implicit",
        polylineClosure: "open",
      },
      `${capabilitiesLabel} polygon/polyline points`,
    );
    expect(
      schemaProperty(
        objectShapeCapabilitiesSchema,
        "polygonAndPolylineUpdates",
        `${capabilitiesLabel} objectShapeCapabilities`,
      ).const,
    ).toBe(
      "common-fields-and-complete-points-replacement-no-dimensions",
    );
    expectExactLiteralSchema(
      schemaProperty(
        objectShapeCapabilitiesSchema,
        "textObject",
        `${capabilitiesLabel} objectShapeCapabilities`,
      ),
      EXPECTED_TEXT_OBJECT_CAPABILITIES,
      `${capabilitiesLabel} text object capabilities`,
    );

    const previewEditsIndex =
      toolNames.indexOf("tiled_preview_edits");
    expect(previewEditsIndex).toBeGreaterThanOrEqual(
      0,
    );
    const previewEditsTool =
      toolDefinitions[previewEditsIndex];
    if (previewEditsTool === undefined) {
      throw new Error(
        "Missing tiled_preview_edits definition",
      );
    }
    expect(
      countExactConst(
        previewEditsTool.inputSchema,
        "polygon",
      ),
    ).toBe(1);
    expect(
      countExactConst(
        previewEditsTool.inputSchema,
        "polyline",
      ),
    ).toBe(1);
    expect(
      countExactConst(
        previewEditsTool.outputSchema,
        "polygon",
      ),
    ).toBe(2);
    expect(
      countExactConst(
        previewEditsTool.inputSchema,
        "text",
      ),
    ).toBe(1);
    expect(
      countExactConst(
        previewEditsTool.outputSchema,
        "text",
      ),
    ).toBe(2);
    for (const [
      direction,
      schema,
    ] of [
      [
        "input",
        previewEditsTool.inputSchema,
      ],
      [
        "output",
        previewEditsTool.outputSchema,
      ],
    ] as const) {
      const updateSchemas =
        findObjectSchemasWithPropertyConst(
          schema,
          "type",
          "updateObject",
        );
      expect(
        updateSchemas,
        `tiled_preview_edits ${direction} updateObject branches`,
      ).toHaveLength(1);
      const updateSchema = updateSchemas[0];
      if (updateSchema === undefined) {
        throw new Error(
          `Missing tiled_preview_edits ${direction} updateObject branch`,
        );
      }
      const patchSchema = schemaProperty(
        updateSchema,
        "patch",
        `tiled_preview_edits ${direction} updateObject`,
      );
      const pointsSchema = schemaProperty(
        patchSchema,
        "points",
        `tiled_preview_edits ${direction} updateObject patch`,
      );
      expect(pointsSchema.type).toBe("array");
      expect(pointsSchema.minItems).toBe(2);
      expect(pointsSchema.maxItems).toBe(256);
      const pointSchema = asRecord(
        pointsSchema.items,
        `tiled_preview_edits ${direction} updateObject patch points.items`,
      );
      expect(
        pointSchema.additionalProperties,
      ).toBe(false);
      expect(
        Object.keys(
          asRecord(
            pointSchema.properties,
            `tiled_preview_edits ${direction} updateObject patch point properties`,
          ),
        ).sort(),
      ).toEqual(["x", "y"]);
      if (direction === "output") {
        const changedFieldsSchema =
          schemaProperty(
            updateSchema,
            "changedFields",
            "tiled_preview_edits output updateObject",
          );
        const changedFieldItems = asRecord(
          changedFieldsSchema.items,
          "tiled_preview_edits output updateObject changedFields.items",
        );
        expect(
          asStringArray(
            changedFieldItems.enum,
            "tiled_preview_edits output updateObject changedFields enum",
          ),
        ).toContain("points");
      }
    }

    const getObjectIndex =
      toolNames.indexOf("tiled_get_object");
    expect(getObjectIndex).toBeGreaterThanOrEqual(
      0,
    );
    const getObjectTool =
      toolDefinitions[getObjectIndex];
    if (getObjectTool === undefined) {
      throw new Error(
        "Missing tiled_get_object definition",
      );
    }
    expect(
      countExactConst(
        getObjectTool.outputSchema,
        "text",
      ),
    ).toBe(1);
    expect(
      countExactConst(
        previewEditsTool.outputSchema,
        "polyline",
      ),
    ).toBe(2);

    const tileRenderIndex =
      toolNames.indexOf("tiled_render_tiles");
    expect(tileRenderIndex).toBeGreaterThanOrEqual(
      0,
    );
    expect(
      fullTools.indexOf("tiled_render_tiles"),
    ).toBe(
      fullTools.indexOf(
        "tiled_render_tileset_sheet",
      ) + 1,
    );
    const tileRenderTool =
      toolDefinitions[tileRenderIndex];
    if (tileRenderTool === undefined) {
      throw new Error(
        "Missing tiled_render_tiles definition",
      );
    }
    const tileRenderLabel =
      `contract.toolDefinitions[${tileRenderIndex}]`;
    const tileRenderInput = asRecord(
      tileRenderTool.inputSchema,
      `${tileRenderLabel}.inputSchema`,
    );
    const localIdsInput = schemaProperty(
      tileRenderInput,
      "localIds",
      `${tileRenderLabel}.inputSchema`,
    );
    expect(localIdsInput.type).toBe("array");
    expect(localIdsInput.minItems).toBe(1);
    expect(localIdsInput.maxItems).toBe(64);
    expect(localIdsInput.uniqueItems).toBe(true);
    expect(
      asRecord(
        localIdsInput.items,
        `${tileRenderLabel}.inputSchema.localIds.items`,
      ),
    ).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 0x0fffffff,
    });
    expect(
      schemaProperty(
        tileRenderInput,
        "columns",
        `${tileRenderLabel}.inputSchema`,
      ),
    ).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 32,
    });
    expect(
      schemaProperty(
        tileRenderInput,
        "scale",
        `${tileRenderLabel}.inputSchema`,
      ),
    ).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 4,
      default: 2,
    });
    expect(
      asStringArray(
        tileRenderInput.required,
        `${tileRenderLabel}.inputSchema.required`,
      ).sort(),
    ).toEqual(
      [
        "localIds",
        "mapPath",
        "tilesetAssetId",
      ].sort(),
    );

    const tileRenderSuccess =
      findResultBranchWithProperty(
        tileRenderTool.outputSchema,
        "renderProfile",
        `${tileRenderLabel}.outputSchema`,
      );
    expect(
      schemaProperty(
        tileRenderSuccess,
        "renderProfile",
        `${tileRenderLabel} success result`,
      ).const,
    ).toBe(
      "explicit-local-id-atlas-selection-v1",
    );
    expect(
      schemaProperty(
        tileRenderSuccess,
        "snapshotConsistency",
        `${tileRenderLabel} success result`,
      ).const,
    ).toBe("non-atomic-read-set");
    expect(
      schemaProperty(
        tileRenderSuccess,
        "truncated",
        `${tileRenderLabel} success result`,
      ).const,
    ).toBe(false);
    expect(
      asRecord(
        tileRenderSuccess.properties,
        `${tileRenderLabel} success properties`,
      ),
    ).not.toHaveProperty("page");
    const selectionSchema = schemaProperty(
      tileRenderSuccess,
      "selection",
      `${tileRenderLabel} success result`,
    );
    const selectionDescription = asString(
      selectionSchema.description,
      `${tileRenderLabel} selection description`,
    );
    for (const invariant of [
      "count equals localIds.length",
      "layout.rows equals ceil(count / layout.columns)",
      "layout.adjusted exactly reports",
      "adjusted=true requires requestedColumns=8",
    ]) {
      expect(selectionDescription).toContain(
        invariant,
      );
    }
    expect(
      Object.keys(
        asRecord(
          selectionSchema.properties,
          `${tileRenderLabel} selection properties`,
        ),
      ).sort(),
    ).toEqual(
      [
        "count",
        "labels",
        "layout",
        "localIds",
        "order",
      ].sort(),
    );
    const layoutSchema = schemaProperty(
      selectionSchema,
      "layout",
      `${tileRenderLabel} selection`,
    );
    const selectionLocalIdsSchema =
      schemaProperty(
        selectionSchema,
        "localIds",
        `${tileRenderLabel} selection`,
      );
    expect(
      selectionLocalIdsSchema.uniqueItems,
    ).toBe(true);
    expect(
      Object.keys(
        asRecord(
          layoutSchema.properties,
          `${tileRenderLabel} layout properties`,
        ),
      ).sort(),
    ).toEqual(
      [
        "adjusted",
        "columns",
        "kind",
        "requestedColumns",
        "rows",
      ].sort(),
    );
    expect(
      asString(
        schemaProperty(
          tileRenderSuccess,
          "pixelSize",
          `${tileRenderLabel} success result`,
        ).description,
        `${tileRenderLabel} pixelSize description`,
      ),
    ).toContain(
      "width * height <= 1500000",
    );
    expect(
      asString(
        tileRenderSuccess.description,
        `${tileRenderLabel} success description`,
      ),
    ).toContain(
      "selection.localIds entry is less than tileset.tileCount",
    );

    const inputValidator =
      new AjvJsonSchemaValidator().getValidator(
        tileRenderTool.inputSchema as JsonSchemaType,
      );
    expect(
      inputValidator({
        mapPath: "maps/example.tmj",
        tilesetAssetId:
          "asset_0123456789abcdef01234567",
        localIds: [1, 1],
      }).valid,
    ).toBe(false);
    const outputValidator =
      new AjvJsonSchemaValidator().getValidator(
        tileRenderTool.outputSchema as JsonSchemaType,
      );
    expect(
      outputValidator(
        tileRenderOutputEnvelope([1, 1]),
      ).valid,
    ).toBe(false);

    const nativePreviewIndex =
      toolNames.indexOf("tiled_render_preview");
    expect(nativePreviewIndex).toBeGreaterThanOrEqual(
      0,
    );
    const nativePreviewTool =
      toolDefinitions[nativePreviewIndex];
    if (nativePreviewTool === undefined) {
      throw new Error(
        "Missing tiled_render_preview definition",
      );
    }
    const nativePreviewLabel =
      `contract.toolDefinitions[${nativePreviewIndex}]`;
    const nativePreviewInputSchema = asRecord(
      nativePreviewTool.inputSchema,
      `${nativePreviewLabel}.inputSchema`,
    );
    const highlightInputSchema = schemaProperty(
      schemaProperty(
        nativePreviewInputSchema,
        "overlays",
        `${nativePreviewLabel}.inputSchema`,
      ),
      "highlights",
      `${nativePreviewLabel}.inputSchema.overlays`,
    );
    expect(highlightInputSchema.minItems).toBe(1);
    expect(highlightInputSchema.maxItems).toBe(64);
    expectClosedRootObjectSchema(
      highlightInputSchema.items,
      `${nativePreviewLabel}.inputSchema.overlays.highlights.items`,
    );
    const objectIdsInputSchema = schemaProperty(
      schemaProperty(
        nativePreviewInputSchema,
        "overlays",
        `${nativePreviewLabel}.inputSchema`,
      ),
      "objectIds",
      `${nativePreviewLabel}.inputSchema.overlays`,
    );
    expect(objectIdsInputSchema.minItems).toBe(1);
    expect(objectIdsInputSchema.maxItems).toBe(64);
    expect(objectIdsInputSchema.uniqueItems).toBe(true);

    const nativePreviewSuccessSchema =
      findResultBranchWithProperty(
        nativePreviewTool.outputSchema,
        "mimeType",
        `${nativePreviewLabel}.outputSchema`,
      );
    const highlightOutputSchema = schemaProperty(
      schemaProperty(
        nativePreviewSuccessSchema,
        "overlays",
        `${nativePreviewLabel} success result`,
      ),
      "highlights",
      `${nativePreviewLabel} success result overlays`,
    );
    expect(
      Object.keys(
        asRecord(
          highlightOutputSchema.properties,
          `${nativePreviewLabel} highlight output properties`,
        ),
      ).sort(),
    ).toEqual(
      [
        "blendMode",
        "color",
        "entries",
        "highlightedTileCount",
        "overlapMode",
        "style",
      ].sort(),
    );
    const highlightEntriesSchema = schemaProperty(
      highlightOutputSchema,
      "entries",
      `${nativePreviewLabel} highlight output`,
    );
    expect(highlightEntriesSchema.maxItems).toBe(64);
    const objectDebugOutputSchema = schemaProperty(
      schemaProperty(
        nativePreviewSuccessSchema,
        "overlays",
        `${nativePreviewLabel} success result`,
      ),
      "objectDebug",
      `${nativePreviewLabel} success result overlays`,
    );
    expectClosedRootObjectSchema(
      objectDebugOutputSchema,
      `${nativePreviewLabel} object debug output`,
    );
    const objectDebugEntriesSchema = schemaProperty(
      objectDebugOutputSchema,
      "entries",
      `${nativePreviewLabel} object debug output`,
    );
    expect(objectDebugEntriesSchema.maxItems).toBe(64);
    expectClosedRootObjectSchema(
      objectDebugEntriesSchema.items,
      `${nativePreviewLabel} object debug output entries`,
    );
    const objectDebugEntrySchema = asRecord(
      objectDebugEntriesSchema.items,
      `${nativePreviewLabel} object debug output entry`,
    );
    expect(
      schemaProperty(
        objectDebugEntrySchema,
        "shape",
        `${nativePreviewLabel} object debug output entry`,
      ).enum,
    ).toEqual([
      "rectangle",
      "point",
      "ellipse",
      "capsule",
      "polygon",
      "polyline",
      "text",
      "tile",
    ]);
    expectExactLiteralSchema(
      schemaProperty(
        objectDebugOutputSchema,
        "curveTessellation",
        `${nativePreviewLabel} object debug output`,
      ),
      {
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
      `${nativePreviewLabel} object debug curve tessellation`,
    );
    expectExactLiteralSchema(
      schemaProperty(
        objectDebugOutputSchema,
        "tileObjectFrames",
        `${nativePreviewLabel} object debug output`,
      ),
      {
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
      `${nativePreviewLabel} object debug tile-object frames`,
    );
    expectExactLiteralSchema(
      schemaProperty(
        objectDebugOutputSchema,
        "tileObjectCollision",
        `${nativePreviewLabel} object debug output`,
      ),
      {
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
      `${nativePreviewLabel} object debug tile-object collision`,
    );

    const applicationErrorContractSchema =
      schemaProperty(
        capabilitySuccessSchema,
        "applicationErrorContract",
        `${capabilitiesLabel} capability result`,
      );
    expectLiteralObjectSchema(
      applicationErrorContractSchema,
      {
        name:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.name,
        registryVersion:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.registryVersion,
        resourceUri:
          APPLICATION_ERROR_RESOURCE_URI,
        revision:
          APPLICATION_ERROR_RESOURCE_REVISION,
        size: APPLICATION_ERROR_RESOURCE_SIZE,
        wireLocation:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.wireLocation,
        fallbackCode:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.fallbackCode,
        codeSetPolicy:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.compatibility.additions,
        clientUnknownCodePolicy:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.compatibility.clientUnknownCodePolicy,
        messages:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.messages,
        details:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.details,
        sdkInputErrors:
          "excluded-sdk-owned-text-only",
      },
      `${capabilitiesLabel} applicationErrorContract`,
    );
    const filesystemThreatModelSchema =
      schemaProperty(
        capabilitySuccessSchema,
        "filesystemThreatModelContract",
        `${capabilitiesLabel} capability result`,
      );
    expectExactLiteralSchema(
      filesystemThreatModelSchema,
      TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT,
      `${capabilitiesLabel} filesystemThreatModelContract`,
    );
    const checkpointCapabilitiesSchema =
      schemaProperty(
        capabilitySuccessSchema,
        "checkpointCapabilities",
        `${capabilitiesLabel} capability result`,
      );
    const checkpointStoragePolicySchema =
      schemaProperty(
        checkpointCapabilitiesSchema,
        "storagePolicy",
        `${capabilitiesLabel} checkpointCapabilities`,
      );
    const checkpointStoragePolicyLiterals = {
      ...CHECKPOINT_STORAGE_POLICY,
      garbageCollectionTrigger:
        "quota-pressure-approved-checkpoint-prune-approved-prepared-discard-approved-prepared-abandon-automatic-rolling-post-commit-or-explicit-internal-call",
      quotaFailureCode:
        "CHECKPOINT_QUOTA_EXCEEDED",
    } as const;
    const checkpointStoragePolicyProperties =
      asRecord(
        checkpointStoragePolicySchema.properties,
        `${capabilitiesLabel} checkpoint storage policy properties`,
      );
    const checkpointStoragePolicyKeys = [
      ...Object.keys(
        checkpointStoragePolicyLiterals,
      ),
      "maxBytes",
      "maxEntries",
    ].sort();
    expect(
      checkpointStoragePolicySchema.type,
    ).toBe("object");
    expect(
      checkpointStoragePolicySchema.additionalProperties,
    ).toBe(false);
    expect(
      Object.keys(
        checkpointStoragePolicyProperties,
      ).sort(),
    ).toEqual(checkpointStoragePolicyKeys);
    expect(
      asStringArray(
        checkpointStoragePolicySchema.required,
        `${capabilitiesLabel} checkpoint storage policy required`,
      ).sort(),
    ).toEqual(checkpointStoragePolicyKeys);
    for (const [key, value] of Object.entries(
      checkpointStoragePolicyLiterals,
    )) {
      expectExactLiteralSchema(
        asRecord(
          checkpointStoragePolicyProperties[key],
          `${capabilitiesLabel} checkpoint storage policy ${key}`,
        ),
        value,
        `${capabilitiesLabel} checkpoint storage policy ${key}`,
      );
    }
    for (const key of [
      "maxBytes",
      "maxEntries",
    ] as const) {
      expect(
        asRecord(
          checkpointStoragePolicyProperties[key],
          `${capabilitiesLabel} checkpoint storage policy ${key}`,
        ),
      ).toEqual({
        maximum: Number.MAX_SAFE_INTEGER,
        minimum: 1,
        type: "integer",
      });
    }
    const safetyStatusSchema = schemaProperty(
      capabilitySuccessSchema,
      "safetyStatus",
      `${capabilitiesLabel} capability result`,
    );
    expect(
      Object.keys(
        asRecord(
          safetyStatusSchema.properties,
          `${capabilitiesLabel} safetyStatus.properties`,
        ),
      ),
    ).toEqual([
      "jsonLexicalPreservation",
    ]);
  });

  it("publishes exact direct resources and application error metadata without environment leaks", () => {
    expect(
      JSON.parse(
        generated.applicationErrorsJson,
      ),
    ).toEqual(
      TILED_MCP_APPLICATION_ERROR_REGISTRY,
    );
    const applicationErrorBytes = Buffer.from(
      generated.applicationErrorsJson,
      "utf8",
    );
    const applicationErrorRevision =
      `sha256:${createHash("sha256")
        .update(applicationErrorBytes)
        .digest("hex")}`;
    expect(applicationErrorBytes.byteLength).toBe(
      APPLICATION_ERROR_RESOURCE_SIZE,
    );
    expect(applicationErrorRevision).toBe(
      APPLICATION_ERROR_RESOURCE_REVISION,
    );
    expect(contract.applicationErrorRegistry).toEqual({
      path: APPLICATION_ERRORS_RELATIVE_PATH,
      resourceUri:
        APPLICATION_ERROR_RESOURCE_URI,
      registryVersion: 1,
      revision:
        APPLICATION_ERROR_RESOURCE_REVISION,
      size: APPLICATION_ERROR_RESOURCE_SIZE,
    });
    const resources = asRecordArray(
      contract.resourceDefinitions,
      "contract.resourceDefinitions",
    );
    expect(resources).toHaveLength(2);
    expect(
      resources.map(({ uri }) => uri),
    ).toEqual([
      APPLICATION_ERROR_RESOURCE_URI,
      "tiled://guide",
    ]);
    expect(resources[0]).toMatchObject({
      uri: APPLICATION_ERROR_RESOURCE_URI,
      name: "application-errors",
      mimeType:
        APPLICATION_ERROR_RESOURCE_MIME_TYPE,
      size: APPLICATION_ERROR_RESOURCE_SIZE,
      _meta: APPLICATION_ERROR_RESOURCE_META,
    });
    expect(resources[1]).toMatchObject({
      uri: "tiled://guide",
      name: "guide",
      mimeType: "text/markdown",
    });

    const contentContracts = asRecordArray(
      contract.resourceContentContracts,
      "contract.resourceContentContracts",
    );
    expect(contentContracts).toHaveLength(2);
    expect(contentContracts[0]).toEqual({
      uri: APPLICATION_ERROR_RESOURCE_URI,
      mimeType:
        APPLICATION_ERROR_RESOURCE_MIME_TYPE,
      contentKind: "text",
      byteLength:
        APPLICATION_ERROR_RESOURCE_SIZE,
      sha256:
        APPLICATION_ERROR_RESOURCE_REVISION,
      _meta: APPLICATION_ERROR_RESOURCE_META,
    });
    expect(contentContracts[1]).toEqual(
      expect.objectContaining({
        uri: "tiled://guide",
        mimeType: "text/markdown",
        contentKind: "text",
        _meta: expect.objectContaining({
          revision: expect.stringMatching(
            /^sha256:[0-9a-f]{64}$/u,
          ),
          size: expect.any(Number),
        }),
      }),
    );
    expect(contract.resourceTemplateDefinitions).toEqual(
      [],
    );
    expect(contract.prompts).toEqual([]);

    const profiles = asRecord(
      contract.profiles,
      "contract.profiles",
    );
    for (const profileName of [
      "core",
      "with-tmxrasterizer",
    ]) {
      const profile = asRecord(
        profiles[profileName],
        `contract.profiles.${profileName}`,
      );
      expect(profile.resourceOrder).toEqual([
        "tiled://guide",
        APPLICATION_ERROR_RESOURCE_URI,
      ]);
      expect(profile.resourceTemplateOrder).toEqual([]);
    }

    const artifacts =
      generated.applicationErrorsJson +
      generated.contractJson +
      generated.referenceMarkdown;
    for (const forbidden of [
      REPOSITORY_ROOT,
      process.cwd(),
      "contract-tiled",
      "contract-tmxrasterizer",
    ]) {
      expect(artifacts).not.toContain(forbidden);
    }
  });
});

function expectClosedRootObjectSchema(
  value: unknown,
  label: string,
): void {
  const schema = asRecord(value, label);
  expect(schema.type, `${label}.type`).toBe("object");
  expect(
    schema.additionalProperties,
    `${label}.additionalProperties`,
  ).toBe(false);
  expectClosedSchemaTree(schema, label);
}

function countExactEnums(
  value: unknown,
  expected: readonly string[],
): number {
  if (Array.isArray(value)) {
    return value.reduce(
      (count, child) =>
        count +
        countExactEnums(child, expected),
      0,
    );
  }
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return 0;
  }
  const record = value as Record<
    string,
    unknown
  >;
  const ownMatch =
    Array.isArray(record.enum) &&
    record.enum.length === expected.length &&
    record.enum.every(
      (item, index) =>
        item === expected[index],
    )
      ? 1
      : 0;
  return Object.values(record).reduce<number>(
    (count, child) =>
      count +
      countExactEnums(child, expected),
    ownMatch,
  );
}

function findCapabilitySuccessSchema(
  outputSchema: unknown,
  label: string,
): Record<string, unknown> {
  const output = asRecord(outputSchema, label);
  const resultSchema = schemaProperty(
    output,
    "result",
    label,
  );
  const branches = asRecordArray(
    resultSchema.anyOf,
    `${label}.properties.result.anyOf`,
  );
  const matches = branches.filter((branch) => {
    const properties = branch.properties;
    return (
      properties !== null &&
      typeof properties === "object" &&
      !Array.isArray(properties) &&
      "cli" in properties
    );
  });
  expect(
    matches,
    `${label} capability-success branches`,
  ).toHaveLength(1);
  const match = matches[0];
  if (match === undefined) {
    throw new Error(
      `${label} is missing its capability-success branch`,
    );
  }
  return match;
}

function findResultBranchWithProperty(
  outputSchema: unknown,
  propertyName: string,
  label: string,
): Record<string, unknown> {
  const output = asRecord(outputSchema, label);
  const resultSchema = schemaProperty(
    output,
    "result",
    label,
  );
  const branches = asRecordArray(
    resultSchema.anyOf,
    `${label}.properties.result.anyOf`,
  );
  const matches = branches.filter((branch) => {
    const properties = branch.properties;
    return (
      properties !== null &&
      typeof properties === "object" &&
      !Array.isArray(properties) &&
      propertyName in properties
    );
  });
  expect(
    matches,
    `${label} branches with ${propertyName}`,
  ).toHaveLength(1);
  const match = matches[0];
  if (match === undefined) {
    throw new Error(
      `${label} is missing a branch with ${propertyName}`,
    );
  }
  return match;
}

function schemaProperty(
  schema: Record<string, unknown>,
  propertyName: string,
  label: string,
): Record<string, unknown> {
  const properties = asRecord(
    schema.properties,
    `${label}.properties`,
  );
  return asRecord(
    properties[propertyName],
    `${label}.properties.${propertyName}`,
  );
}

function expectLiteralObjectSchema(
  schema: Record<string, unknown>,
  expected: Record<
    string,
    string | number | boolean | null
  >,
  label: string,
): void {
  expect(schema.type, `${label}.type`).toBe("object");
  expect(
    schema.additionalProperties,
    `${label}.additionalProperties`,
  ).toBe(false);
  const expectedKeys = Object.keys(expected).sort();
  const properties = asRecord(
    schema.properties,
    `${label}.properties`,
  );
  expect(Object.keys(properties).sort()).toEqual(
    expectedKeys,
  );
  expect(
    asStringArray(
      schema.required,
      `${label}.required`,
    ).sort(),
  ).toEqual(expectedKeys);
  for (const [key, value] of Object.entries(
    expected,
  )) {
    expect(
      asRecord(
        properties[key],
        `${label}.properties.${key}`,
      ).const,
      `${label}.properties.${key}.const`,
    ).toEqual(value);
  }
}

function expectExactLiteralSchema(
  schema: Record<string, unknown>,
  expected: unknown,
  label: string,
): void {
  if (
    expected === null ||
    typeof expected !== "object"
  ) {
    expect(
      schema.const,
      `${label}.const`,
    ).toEqual(expected);
    return;
  }
  if (Array.isArray(expected)) {
    expect(schema.type, `${label}.type`).toBe(
      "array",
    );
    const items = asRecordArray(
      schema.items,
      `${label}.items`,
    );
    expect(items).toHaveLength(expected.length);
    for (
      let index = 0;
      index < expected.length;
      index += 1
    ) {
      expectExactLiteralSchema(
        items[index] as Record<string, unknown>,
        expected[index],
        `${label}[${index}]`,
      );
    }
    return;
  }

  expect(schema.type, `${label}.type`).toBe(
    "object",
  );
  expect(
    schema.additionalProperties,
    `${label}.additionalProperties`,
  ).toBe(false);
  const properties = asRecord(
    schema.properties,
    `${label}.properties`,
  );
  const expectedEntries = Object.entries(
    expected,
  );
  const expectedKeys = expectedEntries
    .map(([key]) => key)
    .sort();
  expect(
    Object.keys(properties).sort(),
  ).toEqual(expectedKeys);
  expect(
    asStringArray(
      schema.required,
      `${label}.required`,
    ).sort(),
  ).toEqual(expectedKeys);
  for (const [key, value] of expectedEntries) {
    expectExactLiteralSchema(
      asRecord(
        properties[key],
        `${label}.properties.${key}`,
      ),
      value,
      `${label}.${key}`,
    );
  }
}

function countExactConst(
  value: unknown,
  expected: unknown,
): number {
  if (Array.isArray(value)) {
    return value.reduce(
      (count, child) =>
        count + countExactConst(child, expected),
      0,
    );
  }
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return 0;
  }
  const record = value as Record<
    string,
    unknown
  >;
  return Object.values(record).reduce<number>(
    (count, child) =>
      count + countExactConst(child, expected),
    Object.prototype.hasOwnProperty.call(
      record,
      "const",
    ) && record.const === expected
      ? 1
      : 0,
  );
}

function findObjectSchemasWithPropertyConst(
  value: unknown,
  propertyName: string,
  expected: unknown,
): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap((child) =>
      findObjectSchemasWithPropertyConst(
        child,
        propertyName,
        expected,
      ),
    );
  }
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return [];
  }
  const record = value as Record<
    string,
    unknown
  >;
  const properties =
    record.properties !== null &&
    typeof record.properties === "object" &&
    !Array.isArray(record.properties)
      ? (record.properties as Record<
          string,
          unknown
        >)
      : undefined;
  const propertySchema =
    properties?.[propertyName];
  const ownMatch =
    propertySchema !== null &&
    typeof propertySchema === "object" &&
    !Array.isArray(propertySchema) &&
    (
      propertySchema as Record<
        string,
        unknown
      >
    ).const === expected
      ? [record]
      : [];
  return Object.values(record).reduce<
    Array<Record<string, unknown>>
  >(
    (matches, child) => [
      ...matches,
      ...findObjectSchemasWithPropertyConst(
        child,
        propertyName,
        expected,
      ),
    ],
    ownMatch,
  );
}

function expectClosedSchemaTree(
  schema: Record<string, unknown>,
  label: string,
): void {
  const visited = new Set<object>();

  const visit = (value: unknown, path: string): void => {
    expect(value, `${path} must not use a true schema`).not.toBe(
      true,
    );
    if (value === false) {
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) {
        visit(child, `${path}[${index}]`);
      }
      return;
    }
    const node = asRecord(value, path);
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    expect(
      Object.keys(node).length,
      `${path} must constrain its value`,
    ).toBeGreaterThan(0);

    const declaredTypes = Array.isArray(node.type)
      ? node.type
      : [node.type];
    const objectKeywords = [
      "additionalProperties",
      "dependencies",
      "dependentRequired",
      "dependentSchemas",
      "maxProperties",
      "minProperties",
      "patternProperties",
      "properties",
      "propertyNames",
      "required",
      "unevaluatedProperties",
    ];
    if (
      declaredTypes.includes("object") ||
      objectKeywords.some((key) => key in node)
    ) {
      expect(
        "additionalProperties" in node,
        `${path} must close or constrain additional properties`,
      ).toBe(true);
      expect(
        node.additionalProperties,
        `${path}.additionalProperties`,
      ).not.toBe(true);
    }

    for (const key of [
      "additionalProperties",
      "additionalItems",
      "unevaluatedProperties",
      "unevaluatedItems",
      "propertyNames",
      "items",
      "contains",
      "not",
      "if",
      "then",
      "else",
      "contentSchema",
    ]) {
      const child = node[key];
      if (child !== undefined && child !== false) {
        visit(child, `${path}.${key}`);
      }
    }

    for (const key of [
      "allOf",
      "anyOf",
      "oneOf",
      "prefixItems",
    ]) {
      const children = node[key];
      if (children === undefined) {
        continue;
      }
      expect(Array.isArray(children), `${path}.${key}`).toBe(
        true,
      );
      for (const [index, child] of (
        children as unknown[]
      ).entries()) {
        visit(child, `${path}.${key}[${index}]`);
      }
    }

    for (const key of [
      "properties",
      "patternProperties",
      "dependentSchemas",
      "$defs",
      "definitions",
    ]) {
      const children = node[key];
      if (children === undefined) {
        continue;
      }
      for (const [name, child] of Object.entries(
        asRecord(children, `${path}.${key}`),
      )) {
        visit(child, `${path}.${key}.${name}`);
      }
    }

    const dependencies = node.dependencies;
    if (dependencies !== undefined) {
      for (const [name, child] of Object.entries(
        asRecord(
          dependencies,
          `${path}.dependencies`,
        ),
      )) {
        if (!Array.isArray(child)) {
          visit(
            child,
            `${path}.dependencies.${name}`,
          );
        }
      }
    }
  };

  visit(schema, label);
}

function tileRenderOutputEnvelope(
  localIds: number[],
): Record<string, unknown> {
  const revision =
    `sha256:${"0".repeat(64)}`;
  return {
    result: {
      mimeType: "image/png",
      pixelSize: {
        width: 100,
        height: 100,
      },
      byteLength: 100,
      sha256: revision,
      map: {
        path: "maps/example.tmj",
        revision,
      },
      source: {
        assetId:
          "asset_0123456789abcdef01234567",
        revision,
      },
      image: {
        path: "tiles/example.png",
        revision,
        format: "png",
        pixelSize: {
          width: 32,
          height: 32,
        },
      },
      tileset: {
        path: "tiles/example.tsj",
        name: "Example",
        tileCount: 4,
        tileSize: {
          width: 16,
          height: 16,
        },
        atlas: {
          columns: 2,
          margin: 0,
          spacing: 0,
        },
      },
      renderProfile:
        "explicit-local-id-atlas-selection-v1",
      selection: {
        localIds,
        count: localIds.length,
        order: "input",
        labels: "local-id",
        layout: {
          kind: "row-major",
          requestedColumns: 2,
          columns: 2,
          rows: 1,
          adjusted: false,
        },
      },
      scale: 2,
      snapshotConsistency:
        "non-atomic-read-set",
      truncated: false,
    },
  };
}

function asRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  expect(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value),
    `${label} must be an object`,
  ).toBe(true);
  return value as Record<string, unknown>;
}

function asRecordArray(
  value: unknown,
  label: string,
): Record<string, unknown>[] {
  expect(Array.isArray(value), `${label} must be an array`).toBe(
    true,
  );
  return (value as unknown[]).map((item, index) =>
    asRecord(item, `${label}[${index}]`),
  );
}

function asStringArray(
  value: unknown,
  label: string,
): string[] {
  expect(Array.isArray(value), `${label} must be an array`).toBe(
    true,
  );
  return (value as unknown[]).map((item, index) =>
    asString(item, `${label}[${index}]`),
  );
}

function asString(value: unknown, label: string): string {
  expect(typeof value, `${label} must be a string`).toBe(
    "string",
  );
  return value as string;
}
