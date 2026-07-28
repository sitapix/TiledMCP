import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import sharp from "sharp";
import { expect, it } from "vitest";

import {
  TILED_MCP_APPLICATION_ERROR_REGISTRY,
  TILED_MCP_APPLICATION_ERROR_REGISTRY_JSON,
} from "../src/errorRegistry.js";
import {
  APPLICATION_ERROR_RESOURCE_MIME_TYPE,
  APPLICATION_ERROR_RESOURCE_REVISION,
  APPLICATION_ERROR_RESOURCE_SIZE,
  APPLICATION_ERROR_RESOURCE_URI,
} from "../src/resources/applicationErrors.js";
import {
  GUIDE_RESOURCE_MIME_TYPE,
  GUIDE_RESOURCE_URI,
} from "../src/resources/guide.js";
import {
  MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT,
} from "../src/storage/checkpoints.js";
import { revisionOf } from "../src/storage/revision.js";

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

it("serves tiled_find_tiles through the production stdio entry point", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "tiledmcp-stdio-test-"),
  );
  const projectRoot = join(temporaryRoot, "project");
  await cp(resolve("fixtures/mvp"), projectRoot, { recursive: true });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "dist/index.js",
      "--project-dir",
      projectRoot,
    ],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({
    name: "tiledmcp-stdio-contract-test",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toContain(
      "tiled_find_tiles",
    );
    expect(tools.tools.map(({ name }) => name)).toContain(
      "tiled_add_tileset_to_map",
    );
    expect(tools.tools.map(({ name }) => name)).toContain(
      "tiled_create_layer",
    );
    expect(tools.tools.map(({ name }) => name)).toContain(
      "tiled_preview_prepared_checkpoint_discard",
    );
    expect(tools.tools.map(({ name }) => name)).toContain(
      "tiled_preview_prepared_checkpoint_commit",
    );
    expect(tools.tools.map(({ name }) => name)).toContain(
      "tiled_preview_prepared_checkpoint_abandon",
    );
    expect(tools.tools.map(({ name }) => name)).toContain(
      "tiled_preview_checkpoint_prune",
    );
    expect(tools.tools.map(({ name }) => name)).toContain(
      "tiled_preview_checkpoint_prune_batch",
    );
    expect(tools.tools.map(({ name }) => name)).toContain(
      "tiled_preview_checkpoint_restore",
    );
    expect(tools.tools.map(({ name }) => name)).toContain(
      "tiled_analyze_usage",
    );
    expect(tools.tools.map(({ name }) => name)).toContain(
      "tiled_get_object",
    );
    expect(tools.tools.map(({ name }) => name)).toContain(
      "tiled_render_tiles",
    );
    expect(tools.tools.length === 36 ||
        tools.tools.length === 37 ||
        tools.tools.length === 39).toBe(
      true,
    );
    expect(tools.tools.map(({ name }) => name)).not.toContain(
      "tiled_remove_tileset_from_map",
    );
    expect(tools.tools.map(({ name }) => name)).not.toContain(
      "tiled_copy_region",
    );

    const capabilitiesResponse = await client.callTool({
      name: "tiled_get_capabilities",
      arguments: {},
    });
    const capabilities = (
      capabilitiesResponse.structuredContent as
        | { result?: Record<string, unknown> }
        | undefined
    )?.result;
    expect(capabilities).toMatchObject({
      resourceCapabilities: {
        direct: [
          GUIDE_RESOURCE_URI,
          APPLICATION_ERROR_RESOURCE_URI,
        ],
      },
      applicationErrorContract: {
        registryVersion: 1,
        resourceUri:
          APPLICATION_ERROR_RESOURCE_URI,
        revision:
          APPLICATION_ERROR_RESOURCE_REVISION,
        size: APPLICATION_ERROR_RESOURCE_SIZE,
        fallbackCode: "INTERNAL_ERROR",
      },
      checkpointCapabilities: {
        automaticBeforeWrite: true,
        exactByteRestoreKernel: true,
        previewAndApplyRestore: true,
        restoreScope: "single-existing-json-document",
        restoresReferencedDependencies: false,
        prune: {
          scope:
            "single-explicit-committed-checkpoint",
          workflow: "preview-then-apply",
          expectedRevision:
            "sha256-of-raw-manifest-bytes",
          preparedCheckpoints:
            "unsupported-reconcile-first",
          automaticRetention:
            "separate-opt-in-post-commit-policy",
          tombstones: false,
        },
        pruneBatch: {
          scope:
            "2-to-32-explicit-committed-checkpoints",
          minCheckpointCount: 2,
          maxCheckpointCount: 32,
          workflow: "preview-then-apply",
          ordering:
            "canonical-checkpoint-id",
          lockOrder:
            "sorted-unique-targets-then-checkpoint-store",
          preflight:
            "all-pins-before-first-unlink",
          commitMode:
            "sequential-manifest-unlink-per-item-directory-fsync",
          atomic: false,
          stopOnFirstFailure: true,
          partialResult:
            "cached-final-no-resume",
          garbageCollection:
            "once-after-all-manifests-fail-closed",
          storedBeforeValidation:
            "not-read",
          automaticSelection: "none",
          tombstones: false,
        },
        retention: {
          enabled: false,
          retainCommittedPerTarget: null,
          minimumRetainedPerTarget:
            MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT,
          mode:
            "rolling-per-target-count-v1",
          defaultMode: "disabled",
          standingApproval:
            "process-startup-config",
          eligibleManifests:
            "v2-rolling-committed-existing-file-only",
          legacyManifests: "always-retained",
          protectedManifests: "always-retained",
          preparedManifests: "always-retained",
          ordering:
            "durable-monotonic-ordinal",
          maxManifestDeletionsPerCommit: 1,
          backlogConvergence:
            "one-add-one-delete-does-not-reduce-existing-excess-explicit-prune-required",
          trigger:
            "successful-checkpoint-commit-only",
          targetDurability:
            "required-no-post-replace-warning",
          startupSweep: false,
          periodicSweep: false,
          lockOrder:
            "target-then-checkpoint-store",
          targetValidation:
            "current-target-equals-newest-rolling-after-revision",
          incompleteInventory:
            "block-before-first-manifest-unlink",
          quotaPressure:
            "orphan-gc-only-no-valid-manifest-deletion",
          resultChannel:
            "commit-result-checkpointRetention",
          previewLease:
            "unsupported-apply-may-be-invalidated",
        },
      },
      tileFindCapabilities: {
        defaultQueryMode: "all",
        nextPageIncludesRevisionPins: true,
        inputRevisionPins: "optional",
      },
      tileRenderCapabilities: {
        locator:
          "map-path-plus-tileset-asset-id",
        renderProfile:
          "explicit-local-id-atlas-selection-v1",
        atlasProfile:
          "root-atlas-no-per-tile-images",
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
      usageAnalysisCapabilities: {
        includesTileLayerCells: true,
        includesTileObjects: true,
        visibility: "all-serialized-layers",
        transformAggregation: "base-tile",
        optionalExactReadSetPins: true,
        defaultTopTileLimit: 64,
      },
      tilesetReferenceCapabilities: {
        removalPlanner:
          "generic-exclusive-operation-change-set",
        removalPolicy: "unused-only",
        removalLocator: "tileset-asset-id",
        removalSourcePatch: "array-element-local",
      },
      mapOperations: ["updateMap", "resizeMap"],
      mapResizeCapabilities: {
        offsetUnit: "tiles",
        offsetMeaning:
          "old-content-position-in-new-map",
        cellMapping:
          "destination-equals-source-plus-offset",
        tileLayerRequirement:
          "map-aligned-zero-origin-finite-numeric-data-only",
        croppedGidValidation:
          "every-scanned-source-cell-fail-closed",
        objectPolicy:
          "shift-anchor-only-never-delete",
        outOfBoundsObjectMetric:
          "shifted-anchor-outside-closed-pixel-bounds",
        templateObjects:
          "fail-closed-when-shifting",
        imageLayerPolicy:
          "shift-changed-offset-members-only",
        groupLayerPolicy:
          "recurse-children-untouched-self",
        idCounters: "unchanged",
        operationOrdering:
          "exclusive-single-operation-change-set",
        sourcePatch:
          "root-dimensions-and-affected-layer-members-local",
      },
      mapUpdateCapabilities: {
        fields: [
          "renderOrder",
          "backgroundColor",
          "className",
        ],
        renderOrders: [
          "right-down",
          "right-up",
          "left-down",
          "left-up",
        ],
        backgroundColorNullDeletes: true,
        maxClassNameCodePoints: 1_024,
        operationOrdering:
          "sequential-change-set-order-last-write-wins",
        sourcePatch: "root-object-member-local",
      },
      tileOperations: [
        "setTiles",
        "fillRegion",
        "stampPattern",
        "floodFill",
        "replaceTiles",
        "copyRegion",
      ],
      tileStampCapabilities: {
        pattern:
          "dense-non-empty-rectangular-row-major",
        origin: "absolute-tile-coordinates",
        nullSemantics: "clear-target-cell",
        skipSentinel: false,
        clipping: false,
        transformEncoding:
          "standard-tile-ref-encoded-gid",
        operationOrdering:
          "sequential-change-set-order-last-write-wins",
        sourcePatch: "tile-layer-data-member-local",
      },
      tileFloodFillCapabilities: {
        seedSourceMatch: "exact-encoded-gid",
        connectivity: "fixed-four-way",
        nullableTarget: true,
        coordinates: "absolute-tile-coordinates",
        operationOrdering:
          "sequential-change-set-order-last-write-wins",
        scanAccounting: "actual-gid-reads",
        scanBudget:
          "shared-with-replaceTiles-and-copyRegion-per-change-set",
        sourcePatch: "tile-layer-data-member-local",
      },
      tileCopyCapabilities: {
        coordinates: "absolute-tile-coordinates",
        clipping: false,
        overlap: "snapshot-source-memmove",
        emptySource: "overwrites-and-clears",
        gidCopy: "exact-encoded-gid",
        observedGidValidation:
          "source-and-destination-fail-closed",
        operationOrdering:
          "sequential-change-set-order-last-write-wins",
        scanBudget:
          "shared-with-replaceTiles-and-floodFill-per-change-set",
        sourcePatch:
          "destination-tile-layer-data-member-local",
      },
      objectShapeCapabilities: {
        creatable: [
          "rectangle",
          "point",
          "ellipse",
          "capsule",
          "polygon",
          "polyline",
          "text",
        ],
        shapeMutation: false,
        ellipseAndCapsuleDimensions:
          "optional-nonnegative-default-zero",
        polygonAndPolylinePoints: {
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
        polygonAndPolylineUpdates:
          "common-fields-and-complete-points-replacement-no-dimensions",
        textObject:
          EXPECTED_TEXT_OBJECT_CAPABILITIES,
        sourcePatch: "object-layer-objects-member-local",
      },
      layerOperations: [
        "updateLayer",
        "deleteLayer",
        "moveLayer",
        "duplicateLayer",
      ],
      layerUpdateCapabilities: {
        layerTypes: [
          "tilelayer",
          "objectgroup",
          "imagelayer",
          "group",
        ],
        tintColorNullDeletes: true,
        lockedSemantics: "advisory-metadata",
        sourcePatch: "object-member-local",
      },
      layerDeletionCapabilities: {
        planner: "generic-exclusive-operation-change-set",
        nonEmptyGroupConfirmation:
          "deleteDescendants-true",
        objectReferencePolicy:
          "reject-surviving-typed-references",
        lockedSemantics: "advisory-metadata",
        idHighWaterMarks: "preserved",
        sourcePatch: "array-element-local",
      },
      layerMoveCapabilities: {
        planner: "generic-exclusive-operation-change-set",
        target: "root-or-group",
        indexSemantics:
          "zero-based-final-index-after-move",
        cycleProtection: true,
        depthLimit: 64,
        lockedSemantics: "advisory-metadata",
        idHighWaterMarks: "preserved",
        sourcePatch: "exact-byte-array-element-move",
      },
      layerDuplicationCapabilities: {
        planner: "generic-exclusive-operation-change-set",
        defaultDestination:
          "same-parent-adjacent-above-source",
        indexSemantics:
          "zero-based-final-insertion-index",
        idAllocation:
          "preorder-layer-and-object-ids-from-high-water-marks",
        objectReferencePolicy:
          "rewire-within-copy-retain-external",
        typedReferenceSafety:
          "class-and-template-fail-closed",
        externalFilePolicy: "shared-references",
        lockedSemantics: "advisory-metadata",
        sourcePatch:
          "compact-new-element-existing-bytes-preserved",
        maxSerializedDuplicateBytes: 16 * 1024 * 1024,
      },
      tileReplacementCapabilities: {
        match: "exact-encoded-gid",
        transformMatch: "exact",
        mappingEvaluation: "simultaneous-single-pass",
        emptySource: false,
        nullableTarget: true,
        defaultRegion: "target-layer-bounds",
      },
      limits: {
        maxSerializedDuplicateBytes: 16 * 1024 * 1024,
        maxRemoveTilesetGidScans: 1_000_000,
        maxReplaceTileMappings: 128,
        maxTileOperationScans: 1_000_000,
        maxFloodFillScans: 1_000_000,
        maxReplaceTileScans: 1_000_000,
        maxStampPatternEdge: 256,
        maxStampPatternCells: 16_384,
        maxResizeMapDimension: 100_000,
        maxResizeOffsetMagnitude: 100_000,
        maxResizeSourceCellScans: 1_000_000,
        maxResizeCroppedCellSample: 16,
        maxTileRenderLocalIds: 64,
        maxTileRenderColumns: 32,
        maxTileRenderScale: 4,
        maxTileRenderBytes: 8 * 1024 * 1024,
        maxTileRenderEdge: 2_048,
        maxTileRenderPixels: 1_500_000,
        maxPendingObjectShapePoints: 65_536,
        maxPendingTextObjectPayloadBytes:
          2_097_152,
      },
      textContentContract: {
        name: "tiled-mcp-summary",
        version: 1,
        encoding: "compact-json",
        maxBytes: 1_024,
        fullResult: "structuredContent.result",
        structuredByteMeasure: "utf8-json-stringify",
        sdkInputErrors: "sdk-owned-text-only",
      },
      rasterMapCapabilities: {
        registration:
          "when-tmxrasterizer-version-probe-succeeds",
        artifactMetadata:
          "traceable-inline-png-v1",
        rendererVersionSource:
          "startup-capability-probe",
        sourceRevisionCoverage:
          "map-and-external-tsj-only",
        inputImageRevisionCoverage:
          "validated-before-and-after-not-reported",
        snapshotValidation:
          "before-and-after-render",
        snapshotConsistency:
          "non-atomic-read-set",
        effectiveOptionsReturned: true,
      },
    });
    const capabilitiesText = (
      capabilitiesResponse as {
        content: Array<{
          type: string;
          text?: string;
        }>;
      }
    ).content[0];
    expect(capabilitiesText).toMatchObject({
      type: "text",
      text: expect.any(String),
    });
    if (
      capabilitiesText?.type !== "text" ||
      typeof capabilitiesText.text !== "string"
    ) {
      throw new Error(
        "Expected capabilities text summary.",
      );
    }
    const serializedCapabilitiesEnvelope = JSON.stringify(
      capabilitiesResponse.structuredContent,
    );
    if (serializedCapabilitiesEnvelope === undefined) {
      throw new Error(
        "Expected capabilities structured content.",
      );
    }
    const capabilitiesTextSummary = JSON.parse(
      capabilitiesText.text,
    ) as unknown;
    expect(capabilitiesText.text).toBe(
      JSON.stringify(capabilitiesTextSummary),
    );
    expect(capabilitiesTextSummary).toEqual({
      kind: "tiled-mcp-summary",
      version: 1,
      ok: true,
      structuredContentBytes: Buffer.byteLength(
        serializedCapabilitiesEnvelope,
        "utf8",
      ),
    });
    expect(capabilities?.objectShapeCapabilities).toEqual({
      creatable: [
        "rectangle",
        "point",
        "ellipse",
        "capsule",
        "polygon",
        "polyline",
        "text",
      ],
      shapeMutation: false,
      ellipseAndCapsuleDimensions:
        "optional-nonnegative-default-zero",
      polygonAndPolylinePoints: {
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
      polygonAndPolylineUpdates:
        "common-fields-and-complete-points-replacement-no-dimensions",
      textObject:
        EXPECTED_TEXT_OBJECT_CAPABILITIES,
      sourcePatch: "object-layer-objects-member-local",
    });

    const summaryResponse = await client.callTool({
      name: "tiled_get_map_summary",
      arguments: { mapPath: "basic.tmj" },
    });
    const summary = (
      summaryResponse.structuredContent as
        | {
            result?: {
              revision: string;
              dependencyRevisions: Record<string, string>;
              renderOrder: string;
              tilesets: Array<{
                assetId: string;
                revision: string;
              }>;
            };
          }
        | undefined
    )?.result;
    const tileset = summary?.tilesets[0];
    expect(summary).toMatchObject({
      renderOrder: "right-down",
    });
    expect(tileset).toBeDefined();
    if (summary === undefined || tileset === undefined) {
      throw new Error("Expected the stdio fixture summary.");
    }

    const selectedTileResponse =
      await client.callTool({
        name: "tiled_render_tiles",
        arguments: {
          mapPath: "basic.tmj",
          tilesetAssetId: tileset.assetId,
          localIds: [3, 0, 2],
          columns: 2,
          scale: 2,
          expectedMapRevision:
            summary.revision,
          expectedTilesetRevision:
            tileset.revision,
        },
      });
    expect(
      selectedTileResponse.isError,
    ).not.toBe(true);
    const selectedTileContent = (
      selectedTileResponse as {
        content: Array<{
          type: string;
          data?: string;
          mimeType?: string;
        }>;
      }
    ).content;
    const selectedTileImage =
      selectedTileContent.find(
        (block) => block.type === "image",
      );
    expect(selectedTileImage).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: expect.any(String),
    });
    const selectedTilePng = Buffer.from(
      selectedTileImage?.data ?? "",
      "base64",
    );
    const selectedTileResult = (
      selectedTileResponse.structuredContent as {
        result: {
          mimeType: string;
          pixelSize: {
            width: number;
            height: number;
          };
          byteLength: number;
          sha256: string;
          map: {
            path: string;
            revision: string;
          };
          source: {
            assetId: string;
            revision: string;
          };
          renderProfile: string;
          selection: {
            localIds: number[];
            count: number;
            order: string;
            labels: string;
            layout: {
              kind: string;
              requestedColumns: number;
              columns: number;
              rows: number;
              adjusted: boolean;
            };
          };
          scale: number;
          snapshotConsistency: string;
          truncated: boolean;
        };
      }
    ).result;
    expect(selectedTileResult).toMatchObject({
      mimeType: "image/png",
      byteLength: selectedTilePng.byteLength,
      sha256: revisionOf(selectedTilePng),
      map: {
        path: "basic.tmj",
        revision: summary.revision,
      },
      source: {
        assetId: tileset.assetId,
        revision: tileset.revision,
      },
      renderProfile:
        "explicit-local-id-atlas-selection-v1",
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
      snapshotConsistency:
        "non-atomic-read-set",
      truncated: false,
    });
    expect(
      await sharp(selectedTilePng).metadata(),
    ).toMatchObject({
      format: "png",
      width:
        selectedTileResult.pixelSize.width,
      height:
        selectedTileResult.pixelSize.height,
    });

    if (
      tools.tools.some(
        ({ name }) =>
          name === "tiled_render_map",
      )
    ) {
      const rasterResponse = await client.callTool({
        name: "tiled_render_map",
        arguments: {
          mapPath: "basic.tmj",
          size: 256,
        },
      });
      expect(rasterResponse.isError).not.toBe(true);
      const rasterContent = (
        rasterResponse as {
          content: Array<{
            type: string;
            data?: string;
            mimeType?: string;
          }>;
        }
      ).content;
      const image = rasterContent.find(
        (block) => block.type === "image",
      );
      expect(image).toMatchObject({
        type: "image",
        mimeType: "image/png",
        data: expect.any(String),
      });
      const png = Buffer.from(
        image?.data ?? "",
        "base64",
      );
      const rasterResult = (
        rasterResponse.structuredContent as {
          result: {
            mimeType: string;
            pixelSize: {
              width: number;
              height: number;
            };
            byteLength: number;
            sha256: string;
            map: {
              path: string;
              revision: string;
            };
            dependencyRevisions:
              Record<string, string>;
            renderer: {
              kind: string;
              version: string;
              profile: string;
            };
            options: {
              size: number;
              ignoreVisibility: boolean;
            };
            snapshotConsistency: string;
            truncated: boolean;
          };
        }
      ).result;
      expect(rasterResult).toMatchObject({
        mimeType: "image/png",
        byteLength: png.byteLength,
        sha256: revisionOf(png),
        map: {
          path: "basic.tmj",
          revision: summary.revision,
        },
        dependencyRevisions:
          summary.dependencyRevisions,
        renderer: {
          kind: "tmxrasterizer",
          version: expect.any(String),
          profile:
            "tmxrasterizer-png-v1",
        },
        options: {
          size: 256,
          ignoreVisibility: false,
        },
        snapshotConsistency:
          "non-atomic-read-set",
        truncated: false,
      });
      expect(
        await sharp(png).metadata(),
      ).toMatchObject({
        format: "png",
        width:
          rasterResult.pixelSize.width,
        height:
          rasterResult.pixelSize.height,
      });
    }

    const usageResponse = await client.callTool({
      name: "tiled_analyze_usage",
      arguments: {
        mapPath: "basic.tmj",
        topTileLimit: 1,
        expectedMapRevision: summary.revision,
        expectedDependencyRevisions:
          summary.dependencyRevisions,
      },
    });
    expect(usageResponse.isError).not.toBe(true);
    expect(
      (
        usageResponse.structuredContent as
          | { result?: Record<string, unknown> }
          | undefined
      )?.result,
    ).toMatchObject({
      profile:
        "finite-orthogonal-tmj-external-atlas-tsj",
      scan: {
        tileCellCount: 12,
        objectCount: 0,
        valueCount: 12,
      },
      totals: {
        nonEmptyTileCellCount: 12,
        tileObjectCount: 0,
        referenceCount: 12,
        distinctUsedTileCount: 4,
        usedTilesetCount: 1,
        unusedTilesetCount: 0,
      },
      topTiles: {
        limit: 1,
        returned: 1,
        distinctUsedTileCount: 4,
        truncated: true,
        items: [
          {
            tile: {
              tileset: {
                kind: "external",
                assetId: tileset.assetId,
              },
              localId: 0,
            },
            references: {
              total: 3,
              tileCells: 3,
              tileObjects: 0,
              transformed: 0,
            },
          },
        ],
      },
    });

    const searchResponse = await client.callTool({
      name: "tiled_find_tiles",
      arguments: {
        mapPath: "basic.tmj",
        tilesetAssetId: tileset.assetId,
        query: {
          clauses: [
            { kind: "class", equals: "Grass" },
            {
              kind: "propertyEquals",
              name: "walkable",
              type: "bool",
              value: true,
            },
          ],
        },
        expectedMapRevision: summary.revision,
        expectedTilesetRevision: tileset.revision,
      },
    });
    expect(searchResponse.isError).not.toBe(true);
    const searchResult = (
      searchResponse.structuredContent as
        | { result?: Record<string, unknown> }
        | undefined
    )?.result;
    expect(searchResult).toMatchObject({
      query: { mode: "all" },
      source: {
        assetId: tileset.assetId,
        revision: tileset.revision,
      },
      items: [
        {
          tile: {
            tileset: {
              kind: "external",
              assetId: tileset.assetId,
            },
            localId: 0,
          },
          matchedClauseIndexes: [0, 1],
        },
      ],
    });

    const replacePreviewResponse = await client.callTool({
      name: "tiled_preview_edits",
      arguments: {
        mapPath: "basic.tmj",
        expectedRevision: summary.revision,
        expectedDependencyRevisions:
          summary.dependencyRevisions,
        operations: [
          {
            type: "replaceTiles",
            layerId: 1,
            region: { x: 0, y: 0, width: 2, height: 1 },
            mappings: [
              {
                from: {
                  tileset: {
                    kind: "external",
                    assetId: tileset.assetId,
                  },
                  localId: 0,
                },
                to: {
                  tileset: {
                    kind: "external",
                    assetId: tileset.assetId,
                  },
                  localId: 1,
                },
              },
            ],
          },
        ],
      },
    });
    expect(replacePreviewResponse.isError).not.toBe(true);
    const replacePreview = (
      replacePreviewResponse.structuredContent as
        | {
            result?: {
              changeSetId: string;
              expectedRevision: string;
              operations: Array<Record<string, unknown>>;
              summary: Record<string, unknown>;
            };
          }
        | undefined
    )?.result;
    expect(replacePreview).toMatchObject({
      operations: [
        {
          type: "replaceTiles",
          layerId: 1,
          region: { x: 0, y: 0, width: 2, height: 1 },
          scannedCellCount: 2,
          replacedCellCount: 2,
          mappingCount: 1,
          omittedMappingCount: 0,
        },
      ],
      summary: {
        cellWrites: 2,
        tileReplacements: [
          {
            operationIndex: 0,
            layerId: 1,
            scannedCellCount: 2,
            replacedCellCount: 2,
            mappingCount: 1,
          },
        ],
      },
    });
    if (replacePreview === undefined) {
      throw new Error("Expected the tile-replacement preview.");
    }
    const replaceApplyResponse = await client.callTool({
      name: "tiled_apply_change_set",
      arguments: {
        changeSetId: replacePreview.changeSetId,
        expectedRevision: replacePreview.expectedRevision,
      },
    });
    expect(replaceApplyResponse.isError).not.toBe(true);
    expect(
      (
        replaceApplyResponse.structuredContent as
          | { result?: Record<string, unknown> }
          | undefined
      )?.result,
    ).toMatchObject({
      changed: true,
      checkpointId: expect.stringMatching(
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
      ),
    });
    const replacedMap = JSON.parse(
      await readFile(join(projectRoot, "basic.tmj"), "utf8"),
    ) as { layers: Array<{ data: number[] }> };
    expect(replacedMap.layers[0]?.data.slice(0, 4)).toEqual([
      2, 2, 2, 2,
    ]);

    const copySummaryResponse = await client.callTool({
      name: "tiled_get_map_summary",
      arguments: { mapPath: "basic.tmj" },
    });
    const copySummary = (
      copySummaryResponse.structuredContent as
        | {
            result?: {
              revision: string;
              dependencyRevisions: Record<string, string>;
            };
          }
        | undefined
    )?.result;
    if (copySummary === undefined) {
      throw new Error(
        "Expected the post-replacement map summary.",
      );
    }
    const copyPreviewResponse = await client.callTool({
      name: "tiled_preview_edits",
      arguments: {
        mapPath: "basic.tmj",
        expectedRevision: copySummary.revision,
        expectedDependencyRevisions:
          copySummary.dependencyRevisions,
        operations: [
          {
            type: "copyRegion",
            source: {
              layerId: 1,
              x: 0,
              y: 1,
              width: 3,
              height: 1,
            },
            destination: {
              layerId: 1,
              x: 1,
              y: 1,
            },
          },
        ],
      },
    });
    expect(copyPreviewResponse.isError).not.toBe(
      true,
    );
    const copyPreview = (
      copyPreviewResponse.structuredContent as
        | {
            result?: {
              changeSetId: string;
              expectedRevision: string;
              operations: Array<
                Record<string, unknown>
              >;
              summary: Record<string, unknown>;
            };
          }
        | undefined
    )?.result;
    const copiedSource = {
      layerId: 1,
      x: 0,
      y: 1,
      width: 3,
      height: 1,
    };
    const copiedDestination = {
      layerId: 1,
      x: 1,
      y: 1,
      width: 3,
      height: 1,
    };
    expect(copyPreview).toMatchObject({
      operations: [
        {
          type: "copyRegion",
          destructive: true,
          warning: expect.any(String),
          source: copiedSource,
          destination: copiedDestination,
          scannedCellCount: 6,
          cellCount: 3,
          sourceNonEmptyCellCount: 3,
          changedCellCount: 3,
          overwrittenNonEmptyCellCount: 3,
          clearedCellCount: 0,
          overlapsSource: true,
          wouldChange: true,
        },
      ],
      summary: {
        cellWrites: 3,
        tileCopies: [
          {
            operationIndex: 0,
            source: copiedSource,
            destination: copiedDestination,
            scannedCellCount: 6,
            cellCount: 3,
            sourceNonEmptyCellCount: 3,
            changedCellCount: 3,
            overwrittenNonEmptyCellCount: 3,
            clearedCellCount: 0,
            overlapsSource: true,
            wouldChange: true,
          },
        ],
      },
    });
    if (copyPreview === undefined) {
      throw new Error(
        "Expected the tile-copy preview.",
      );
    }
    expect(
      copyPreview.operations[0],
    ).not.toHaveProperty("operationIndex");
    const copyApplyResponse = await client.callTool({
      name: "tiled_apply_change_set",
      arguments: {
        changeSetId: copyPreview.changeSetId,
        expectedRevision:
          copyPreview.expectedRevision,
      },
    });
    expect(copyApplyResponse.isError).not.toBe(true);
    expect(
      (
        copyApplyResponse.structuredContent as
          | { result?: Record<string, unknown> }
          | undefined
      )?.result,
    ).toMatchObject({
      changed: true,
      checkpointId: expect.stringMatching(
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
      ),
    });
    const copiedMap = JSON.parse(
      await readFile(
        join(projectRoot, "basic.tmj"),
        "utf8",
      ),
    ) as { layers: Array<{ data: number[] }> };
    expect(
      copiedMap.layers[0]?.data.slice(4, 8),
    ).toEqual([1, 1, 3, 4]);

    const createdMapResponse = await client.callTool({
      name: "tiled_create_map",
      arguments: {
        mapPath: "created.tmj",
        width: 4,
        height: 3,
        tileWidth: 16,
        tileHeight: 16,
      },
    });
    expect(createdMapResponse.isError).not.toBe(true);
    const createdMapSummaryResponse = await client.callTool({
      name: "tiled_get_map_summary",
      arguments: { mapPath: "created.tmj" },
    });
    const createdMapSummary = (
      createdMapSummaryResponse.structuredContent as
        | {
            result?: {
              revision: string;
              dependencyRevisions: Record<string, string>;
              renderOrder: string;
              tilesets: unknown[];
            };
          }
        | undefined
    )?.result;
    expect(createdMapSummary).toMatchObject({
      dependencyRevisions: {},
      renderOrder: "right-down",
      tilesets: [],
    });
    if (createdMapSummary === undefined) {
      throw new Error("Expected the newly created map summary.");
    }

    const addTilesetResponse = await client.callTool({
      name: "tiled_add_tileset_to_map",
      arguments: {
        mapPath: "created.tmj",
        tilesetPath: "basic.tsj",
        expectedMapRevision: createdMapSummary.revision,
        expectedDependencyRevisions:
          createdMapSummary.dependencyRevisions,
        expectedTilesetRevision: tileset.revision,
      },
    });
    expect(addTilesetResponse.isError).not.toBe(true);
    const addTilesetPreview = (
      addTilesetResponse.structuredContent as
        | {
            result?: {
              changeSetId: string;
              expectedRevision: string;
              operations: Array<Record<string, unknown>>;
              prospectiveDependencyRevisions: Record<string, string>;
            };
          }
        | undefined
    )?.result;
    expect(addTilesetPreview).toMatchObject({
      changeSetId: expect.stringMatching(/^changeset:[0-9a-f]{64}$/u),
      expectedRevision: createdMapSummary.revision,
      prospectiveDependencyRevisions: {
        [tileset.assetId]: tileset.revision,
      },
      operations: [
        {
          type: "addTilesetToMap",
          source: "basic.tsj",
          assignedFirstGid: 1,
          gidRange: { first: 1, last: 4 },
          tileset: {
            kind: "external",
            assetId: tileset.assetId,
            revision: tileset.revision,
            tileCount: 4,
          },
        },
      ],
    });
    if (addTilesetPreview === undefined) {
      throw new Error("Expected an add-tileset change-set preview.");
    }
    const addTilesetApplyResponse = await client.callTool({
      name: "tiled_apply_change_set",
      arguments: {
        changeSetId: addTilesetPreview.changeSetId,
        expectedRevision: addTilesetPreview.expectedRevision,
      },
    });
    expect(addTilesetApplyResponse.isError).not.toBe(true);

    const attachedSummaryResponse = await client.callTool({
      name: "tiled_get_map_summary",
      arguments: { mapPath: "created.tmj" },
    });
    const attachedSummary = (
      attachedSummaryResponse.structuredContent as
        | {
            result?: {
              revision: string;
              dependencyRevisions: Record<string, string>;
              layers: Array<Record<string, unknown>>;
              tilesets: Array<Record<string, unknown>>;
            };
          }
        | undefined
    )?.result;
    expect(attachedSummary?.tilesets).toEqual([
      expect.objectContaining({
        assetId: tileset.assetId,
        path: "basic.tsj",
        firstGid: 1,
        tileCount: 4,
        revision: tileset.revision,
      }),
    ]);
    if (attachedSummary === undefined) {
      throw new Error("Expected the attached map summary.");
    }
    const beforeLayerBytes = await readFile(
      join(projectRoot, "created.tmj"),
    );

    const createLayerResponse = await client.callTool({
      name: "tiled_create_layer",
      arguments: {
        mapPath: "created.tmj",
        type: "objectgroup",
        name: "Objects",
        expectedMapRevision: attachedSummary.revision,
        expectedDependencyRevisions:
          attachedSummary.dependencyRevisions,
      },
    });
    expect(createLayerResponse.isError).not.toBe(true);
    const createLayerPreview = (
      createLayerResponse.structuredContent as
        | {
            result?: {
              changeSetId: string;
              expectedRevision: string;
              operations: Array<Record<string, unknown>>;
            };
          }
        | undefined
    )?.result;
    expect(createLayerPreview).toMatchObject({
      expectedRevision: attachedSummary.revision,
      operations: [
        {
          type: "createLayer",
          layer: {
            id: 1,
            type: "objectgroup",
            name: "Objects",
          },
          parentGroupId: null,
          index: 0,
          allocatedCellCount: 0,
        },
      ],
    });
    if (createLayerPreview === undefined) {
      throw new Error("Expected a create-layer change-set preview.");
    }
    const createLayerApplyResponse = await client.callTool({
      name: "tiled_apply_change_set",
      arguments: {
        changeSetId: createLayerPreview.changeSetId,
        expectedRevision: createLayerPreview.expectedRevision,
      },
    });
    expect(createLayerApplyResponse.isError).not.toBe(true);
    const createLayerApply = (
      createLayerApplyResponse.structuredContent as
        | {
            result?: {
              revision: string;
              checkpointId: string;
              changed: boolean;
            };
          }
        | undefined
    )?.result;
    expect(createLayerApply).toMatchObject({
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      checkpointId: expect.stringMatching(
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
      ),
      changed: true,
    });
    if (createLayerApply === undefined) {
      throw new Error("Expected the create-layer apply result.");
    }

    const layeredSummaryResponse = await client.callTool({
      name: "tiled_get_map_summary",
      arguments: { mapPath: "created.tmj" },
    });
    const layeredSummary = (
      layeredSummaryResponse.structuredContent as
          | {
            result?: {
              revision: string;
              dependencyRevisions: Record<string, string>;
              layers: Array<Record<string, unknown>>;
            };
          }
        | undefined
    )?.result;
    expect(layeredSummary?.layers).toEqual([
      expect.objectContaining({
        id: 1,
        name: "Objects",
        type: "objectgroup",
      }),
    ]);
    expect(layeredSummary?.revision).toBe(createLayerApply.revision);
    if (layeredSummary === undefined) {
      throw new Error("Expected the map summary with an object layer.");
    }

    const objectPreviewResponse = await client.callTool({
      name: "tiled_preview_edits",
      arguments: {
        mapPath: "created.tmj",
        expectedRevision: layeredSummary.revision,
        expectedDependencyRevisions:
          layeredSummary.dependencyRevisions,
        operations: [
          {
            type: "createObject",
            layerId: 1,
            object: {
              shape: "ellipse",
              x: 8,
              y: 10,
              name: "Portal",
            },
          },
          {
            type: "createObject",
            layerId: 1,
            object: {
              shape: "capsule",
              x: 24,
              y: 10,
              width: 0,
              height: 0,
              name: "Trigger",
            },
          },
          {
            type: "createObject",
            layerId: 1,
            object: {
              shape: "polygon",
              x: 40,
              y: 12,
              name: "Patrol zone",
              points: [
                { x: 0, y: 0 },
                { x: 12, y: 0 },
                { x: 6, y: 8 },
              ],
            },
          },
        ],
      },
    });
    expect(objectPreviewResponse.isError).not.toBe(true);
    const objectPreview = (
      objectPreviewResponse.structuredContent as
        | {
            result?: {
              changeSetId: string;
              expectedRevision: string;
              operations: Array<Record<string, unknown>>;
              summary: Record<string, unknown>;
            };
          }
        | undefined
    )?.result;
    expect(objectPreview).toMatchObject({
      expectedRevision: layeredSummary.revision,
      operations: [
        {
          type: "createObject",
          layerId: 1,
          shape: "ellipse",
          object: {
            shape: "ellipse",
          },
        },
        {
          type: "createObject",
          layerId: 1,
          shape: "capsule",
          object: {
            shape: "capsule",
            width: 0,
            height: 0,
          },
        },
        {
          type: "createObject",
          layerId: 1,
          shape: "polygon",
          object: {
            shape: "polygon",
            points: [
              { x: 0, y: 0 },
              { x: 12, y: 0 },
              { x: 6, y: 8 },
            ],
          },
        },
      ],
      summary: {
        affectedObjectLayerIds: [1],
        createdObjectIds: [1, 2, 3],
      },
    });
    if (objectPreview === undefined) {
      throw new Error("Expected the ellipse/capsule object preview.");
    }
    const objectApplyResponse = await client.callTool({
      name: "tiled_apply_change_set",
      arguments: {
        changeSetId: objectPreview.changeSetId,
        expectedRevision: objectPreview.expectedRevision,
      },
    });
    expect(objectApplyResponse.isError).not.toBe(true);
    const objectApply = (
      objectApplyResponse.structuredContent as
        | {
            result?: {
              revision: string;
              changed: boolean;
            };
          }
        | undefined
    )?.result;
    expect(objectApply).toMatchObject({
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      changed: true,
    });
    if (objectApply === undefined) {
      throw new Error("Expected the ellipse/capsule object apply result.");
    }
    const objectDetailsResponse =
      await client.callTool({
        name: "tiled_get_object",
        arguments: {
          mapPath: "created.tmj",
          objectId: 1,
        },
      });
    expect(
      objectDetailsResponse.isError,
    ).not.toBe(true);
    const objectDetails = (
      objectDetailsResponse.structuredContent as
        | {
            result?: Record<string, unknown>;
          }
        | undefined
    )?.result;
    expect(objectDetails).toMatchObject({
      mapPath: "created.tmj",
      revision: objectApply.revision,
      object: {
        id: 1,
        layerId: 1,
        layerName: "Objects",
        name: "Portal",
        className: "",
        shape: "ellipse",
        x: 8,
        y: 10,
        width: 0,
        height: 0,
        rotation: 0,
        visible: true,
        opacity: 1,
      },
    });
    const objectMap = JSON.parse(
      await readFile(join(projectRoot, "created.tmj"), "utf8"),
    ) as {
      nextobjectid: number;
      layers: Array<{
        id: number;
        objects: Array<Record<string, unknown>>;
      }>;
    };
    expect(objectMap.nextobjectid).toBe(4);
    expect(objectMap.layers[0]?.objects).toEqual([
      expect.objectContaining({
        id: 1,
        ellipse: true,
        width: 0,
        height: 0,
      }),
      expect.objectContaining({
        id: 2,
        capsule: true,
        width: 0,
        height: 0,
      }),
      expect.objectContaining({
        id: 3,
        name: "Patrol zone",
        polygon: [
          { x: 0, y: 0 },
          { x: 12, y: 0 },
          { x: 6, y: 8 },
        ],
      }),
    ]);

    const replacementPoints = [
      { x: -2, y: 1 },
      { x: 14, y: 0 },
      { x: 7, y: 10 },
    ];
    const pathUpdatePreviewResponse =
      await client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: "created.tmj",
          expectedRevision:
            objectApply.revision,
          expectedDependencyRevisions:
            layeredSummary.dependencyRevisions,
          operations: [
            {
              type: "updateObject",
              objectId: 3,
              patch: {
                points: replacementPoints,
                name: "Updated patrol zone",
              },
            },
          ],
        },
      });
    expect(
      pathUpdatePreviewResponse.isError,
    ).not.toBe(true);
    const pathUpdatePreview = (
      pathUpdatePreviewResponse.structuredContent as
        | {
            result?: {
              operations: Array<
                Record<string, unknown>
              >;
            };
          }
        | undefined
    )?.result;
    expect(pathUpdatePreview?.operations).toEqual([
      {
        type: "updateObject",
        objectId: 3,
        changedFields: ["name", "points"],
        patch: {
          points: replacementPoints,
          name: "Updated patrol zone",
        },
      },
    ]);

    const restorePreviewResponse = await client.callTool({
      name: "tiled_preview_checkpoint_restore",
      arguments: {
        checkpointId: createLayerApply.checkpointId,
        expectedRevision: objectApply.revision,
      },
    });
    expect(restorePreviewResponse.isError).not.toBe(true);
    const restorePreview = (
      restorePreviewResponse.structuredContent as
        | {
            result?: {
              kind: string;
              changeSetId: string;
              expectedRevision: string;
              targetPath: string;
              restore: {
                revision: string;
                exactBytes: boolean;
                wouldChange: boolean;
              };
              operations: Array<Record<string, unknown>>;
            };
          }
        | undefined
    )?.result;
    expect(restorePreview).toMatchObject({
      kind: "checkpointRestore",
      changeSetId: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      expectedRevision: objectApply.revision,
      targetPath: "created.tmj",
      restore: {
        revision: attachedSummary.revision,
        exactBytes: true,
        wouldChange: true,
      },
      operations: [
        {
          type: "restoreCheckpoint",
          destructive: true,
          checkpointId: createLayerApply.checkpointId,
          targetPath: "created.tmj",
          exactBytes: true,
          wouldChange: true,
        },
      ],
    });
    if (restorePreview === undefined) {
      throw new Error("Expected a checkpoint restore preview.");
    }
    const restoreApplyResponse = await client.callTool({
      name: "tiled_apply_change_set",
      arguments: {
        changeSetId: restorePreview.changeSetId,
        expectedRevision: restorePreview.expectedRevision,
      },
    });
    expect(restoreApplyResponse.isError).not.toBe(true);
    const restoreApply = (
      restoreApplyResponse.structuredContent as
        | {
            result?: {
              path: string;
              beforeRevision: string;
              revision: string;
              changed: boolean;
            };
          }
        | undefined
    )?.result;
    expect(restoreApply).toMatchObject({
      path: "created.tmj",
      beforeRevision: objectApply.revision,
      revision: attachedSummary.revision,
      changed: true,
    });
    expect(await readFile(join(projectRoot, "created.tmj"))).toEqual(
      beforeLayerBytes,
    );

    const restoredSummaryResponse = await client.callTool({
      name: "tiled_get_map_summary",
      arguments: { mapPath: "created.tmj" },
    });
    const restoredSummary = (
      restoredSummaryResponse.structuredContent as
        | {
            result?: {
              revision: string;
              layers: Array<Record<string, unknown>>;
              tilesets: Array<Record<string, unknown>>;
            };
          }
        | undefined
    )?.result;
    expect(restoredSummary).toMatchObject({
      revision: attachedSummary.revision,
      layers: [],
      tilesets: [
        expect.objectContaining({
          assetId: tileset.assetId,
          path: "basic.tsj",
        }),
      ],
    });

    const resources = await client.listResources();
    expect(resources.resources.map(({ uri }) => uri)).toEqual([
      GUIDE_RESOURCE_URI,
      APPLICATION_ERROR_RESOURCE_URI,
    ]);

    const guide = await client.readResource({
      uri: GUIDE_RESOURCE_URI,
    });
    const guideText = guide.contents[0];
    expect(guideText).toMatchObject({
      mimeType: GUIDE_RESOURCE_MIME_TYPE,
    });
    expect(
      guideText !== undefined && "text" in guideText
        ? guideText.text
        : "",
    ).toContain("`tilesetAssetId`");

    const applicationErrors =
      await client.readResource({
        uri: APPLICATION_ERROR_RESOURCE_URI,
      });
    const applicationErrorContent =
      applicationErrors.contents[0];
    expect(applicationErrorContent).toMatchObject({
      mimeType:
        APPLICATION_ERROR_RESOURCE_MIME_TYPE,
    });
    if (
      applicationErrorContent === undefined ||
      !("text" in applicationErrorContent)
    ) {
      throw new Error(
        "Expected the application error registry resource to contain text",
      );
    }
    expect(applicationErrorContent.text).toBe(
      TILED_MCP_APPLICATION_ERROR_REGISTRY_JSON,
    );
    expect(
      JSON.parse(applicationErrorContent.text),
    ).toEqual(
      TILED_MCP_APPLICATION_ERROR_REGISTRY,
    );
  } finally {
    await client.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  expect(stderr).toMatch(
    /ready for .+ \((?:36|37|38|39) tools\)/u,
  );
});
