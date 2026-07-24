import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";

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
      "tiled_preview_checkpoint_restore",
    );
    expect(tools.tools.map(({ name }) => name)).toContain(
      "tiled_analyze_usage",
    );
    expect(tools.tools.length === 18 || tools.tools.length === 19).toBe(
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
      checkpointCapabilities: {
        automaticBeforeWrite: true,
        exactByteRestoreKernel: true,
        previewAndApplyRestore: true,
        restoreScope: "single-existing-json-document",
        restoresReferencedDependencies: false,
      },
      tileFindCapabilities: {
        defaultQueryMode: "all",
        nextPageIncludesRevisionPins: true,
        inputRevisionPins: "optional",
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
      mapOperations: ["updateMap"],
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
        creatable: ["rectangle", "point", "ellipse", "capsule"],
        shapeMutation: false,
        ellipseAndCapsuleDimensions:
          "optional-nonnegative-default-zero",
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
      },
    });
    expect(capabilities?.objectShapeCapabilities).toEqual({
      creatable: ["rectangle", "point", "ellipse", "capsule"],
      shapeMutation: false,
      ellipseAndCapsuleDimensions:
        "optional-nonnegative-default-zero",
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
      ],
      summary: {
        affectedObjectLayerIds: [1],
        createdObjectIds: [1, 2],
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
    const objectMap = JSON.parse(
      await readFile(join(projectRoot, "created.tmj"), "utf8"),
    ) as {
      nextobjectid: number;
      layers: Array<{
        id: number;
        objects: Array<Record<string, unknown>>;
      }>;
    };
    expect(objectMap.nextobjectid).toBe(3);
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

    const guide = await client.readResource({ uri: "tiled://guide" });
    const guideText = guide.contents[0];
    expect(guideText).toMatchObject({ mimeType: "text/markdown" });
    expect(
      guideText !== undefined && "text" in guideText
        ? guideText.text
        : "",
    ).toContain("`tilesetAssetId`");
  } finally {
    await client.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  expect(stderr).toMatch(
    /ready for .+ \(1[89] tools\)/u,
  );
});
