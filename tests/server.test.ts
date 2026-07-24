import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TiledCliAdapter } from "../src/adapters/tiledCli.js";
import { serializeJsonDocument, type JsonObject } from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  GUIDE_RESOURCE_MIME_TYPE,
  GUIDE_RESOURCE_REVISION,
  GUIDE_RESOURCE_SIZE,
  GUIDE_RESOURCE_URI,
  MAX_GUIDE_RESOURCE_BYTES,
} from "../src/resources/guide.js";
import { createTiledMcpServer } from "../src/server.js";
import { DocumentStore } from "../src/storage/documentStore.js";
import { revisionOf } from "../src/storage/revision.js";
import { SERVER_NAME, SERVER_VERSION } from "../src/version.js";

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
const LAYER_ID = 7;
const OBJECT_LAYER_ID = 8;
const RECTANGLE_OBJECT_ID = 1;
const POINT_OBJECT_ID = 2;
const CORE_TOOLS = [
  "tiled_get_capabilities",
  "tiled_list_files",
  "tiled_list_checkpoints",
  "tiled_preview_checkpoint_restore",
  "tiled_get_map_summary",
  "tiled_get_tileset",
  "tiled_find_tiles",
  "tiled_get_region",
  "tiled_render_tileset_sheet",
  "tiled_render_preview",
  "tiled_list_objects",
  "tiled_validate",
  "tiled_analyze_usage",
  "tiled_create_map",
  "tiled_add_tileset_to_map",
  "tiled_create_layer",
  "tiled_preview_edits",
  "tiled_apply_change_set",
] as const;

interface Harness {
  root: string;
  client: Client;
  server: McpServer;
}

interface ToolResponse {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ToolTextSummary {
  kind: "tiled-mcp-summary";
  version: 1;
  ok: boolean;
  structuredContentBytes: number;
  image?: {
    mimeType: "image/png";
    bytes: number;
  };
  error?: {
    code: string;
    message: string;
    messageTruncated?: true;
  };
}

describe("createTiledMcpServer", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.client.close().catch(() => undefined);
    await harness.server.close().catch(() => undefined);
    await rm(harness.root, { recursive: true, force: true });
  });

  it("advertises exactly the eighteen core tools with safety annotations", async () => {
    const response = await harness.client.listTools();
    const byName = new Map(response.tools.map((tool) => [tool.name, tool]));

    expect([...byName.keys()]).toEqual(CORE_TOOLS);
    for (const name of [
      "tiled_get_capabilities",
      "tiled_list_files",
      "tiled_list_checkpoints",
      "tiled_get_map_summary",
      "tiled_get_tileset",
      "tiled_find_tiles",
      "tiled_get_region",
      "tiled_render_tileset_sheet",
      "tiled_render_preview",
      "tiled_list_objects",
      "tiled_validate",
      "tiled_analyze_usage",
    ]) {
      expect(byName.get(name)?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    for (const name of [
      "tiled_preview_checkpoint_restore",
      "tiled_preview_edits",
    ]) {
      expect(byName.get(name)?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
    for (const name of [
      "tiled_add_tileset_to_map",
      "tiled_create_layer",
    ]) {
      expect(byName.get(name)?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
    expect(byName.get("tiled_create_map")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName.get("tiled_apply_change_set")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(
      byName.get("tiled_preview_checkpoint_restore")?.inputSchema,
    ).toMatchObject({
      type: "object",
      properties: {
        checkpointId: { type: "string" },
        expectedRevision: { type: "string" },
      },
      required: ["checkpointId", "expectedRevision"],
      additionalProperties: false,
    });
    for (const tool of response.tools) {
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(tool.outputSchema).toMatchObject({
        type: "object",
        properties: {
          result: expect.any(Object),
        },
        additionalProperties: false,
      });
      expect(
        (tool.outputSchema as { required?: unknown } | undefined)?.required,
      ).toEqual(["result"]);
      expect(
        Object.keys(
          (tool.outputSchema as { properties: Record<string, unknown> })
            .properties,
        ),
      ).toEqual(["result"]);
      expectNoUnconstrainedOutputSchemas(tool.outputSchema, tool.name);
    }
    expect(
      JSON.stringify(
        byName.get("tiled_get_capabilities")
          ?.outputSchema,
      ),
    ).not.toContain(harness.root);
    const capabilities = resultOf<{
      serverVersion: string;
      registeredTools: string[];
      cli: {
        tiled: { executable: string };
        rasterizer: { executable: string };
      };
      textContentContract: {
        name: string;
        version: number;
        encoding: string;
        maxBytes: number;
        fullResult: string;
        structuredByteMeasure: string;
        sdkInputErrors: string;
      };
    }>(
      await harness.client.callTool({
        name: "tiled_get_capabilities",
        arguments: {},
      }),
    );
    expect(capabilities).toMatchObject({
      serverVersion: SERVER_VERSION,
      registeredTools: CORE_TOOLS,
      cli: {
        tiled: {
          executable: expect.stringContaining(
            harness.root,
          ),
        },
        rasterizer: {
          executable: expect.stringContaining(
            harness.root,
          ),
        },
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
    });
  });

  it("keeps application errors schema-valid after caching client validators while SDK input errors stay text-only", async () => {
    await harness.client.listTools();

    const applicationError = asToolResponse(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: "../outside.tmj" },
      }),
    );
    expect(applicationError).toMatchObject({
      isError: true,
      structuredContent: {
        result: {
          ok: false,
          error: {
            code: "INVALID_PROJECT_PATH",
            message: expect.any(String),
            details: { path: "../outside.tmj" },
          },
        },
      },
    });
    const applicationErrorSummary = textSummaryOf(
      applicationError,
      false,
    );
    expect(applicationErrorSummary.error).toEqual({
      code: "INVALID_PROJECT_PATH",
      message:
        "Project path is not canonical or escapes the root: ../outside.tmj",
    });
    expect(applicationErrorSummary.error).not.toHaveProperty("details");

    const inputError = asToolResponse(
      await harness.client.callTool({
        name: "tiled_validate",
        arguments: {
          mapPath: MAP_PATH,
          unexpected: true,
        },
      }),
    );
    expect(inputError.isError).toBe(true);
    expect(inputError.structuredContent).toBeUndefined();
    expect(inputError.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Input validation error"),
      }),
    ]);
    expect(inputError.content[0]?.text).not.toContain(
      '"kind":"tiled-mcp-summary"',
    );
  });

  it("returns one-line compact v1 summaries without mirroring ordinary or large success payloads", async () => {
    const ordinaryResponse = asToolResponse(
      await harness.client.callTool({
        name: "tiled_list_files",
        arguments: {},
      }),
    );
    const ordinaryStructuredJson = JSON.stringify(
      ordinaryResponse.structuredContent,
    );
    expect(ordinaryStructuredJson).toContain(MAP_PATH);
    const ordinaryTextSummary = textSummaryOf(
      ordinaryResponse,
      true,
    );
    expect(ordinaryTextSummary).toEqual({
      kind: "tiled-mcp-summary",
      version: 1,
      ok: true,
      structuredContentBytes: Buffer.byteLength(
        ordinaryStructuredJson,
        "utf8",
      ),
    });
    expect(ordinaryResponse.content[0]?.text).not.toContain(
      MAP_PATH,
    );

    const capabilitiesResponse = asToolResponse(
      await harness.client.callTool({
        name: "tiled_get_capabilities",
        arguments: {},
      }),
    );
    const capabilitiesStructuredJson = JSON.stringify(
      capabilitiesResponse.structuredContent,
    );
    expect(capabilitiesStructuredJson).toContain(harness.root);
    expect(capabilitiesStructuredJson).toContain(
      '"registeredTools"',
    );
    const capabilitiesTextSummary = textSummaryOf(
      capabilitiesResponse,
      true,
    );
    expect(
      capabilitiesTextSummary.structuredContentBytes,
    ).toBeGreaterThan(1_024);
    expect(capabilitiesResponse.content[0]?.text).not.toContain(
      harness.root,
    );
    expect(capabilitiesResponse.content[0]?.text).not.toContain(
      "registeredTools",
    );
    expect(capabilitiesResponse.content[0]?.text).not.toContain(
      "tiled_apply_change_set",
    );
  });

  it("accepts a no-op layer update preview through the cached exact output validator", async () => {
    await harness.client.listTools();
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );

    const preview = resultOf<{
      operations: Array<{
        changedFields: string[];
        wouldChange: boolean;
      }>;
      summary: {
        affectedLayerIds: number[];
        updatedLayerIds: number[];
        layerUpdates: Array<{
          changedFields: string[];
          wouldChange: boolean;
        }>;
      };
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: summary.revision,
          expectedDependencyRevisions: summary.dependencyRevisions,
          operations: [
            {
              type: "updateLayer",
              layerId: LAYER_ID,
              patch: { name: "Ground" },
            },
          ],
        },
      }),
    );

    expect(preview.operations).toEqual([
      expect.objectContaining({
        type: "updateLayer",
        layerId: LAYER_ID,
        requestedFields: ["name"],
        changedFields: [],
        wouldChange: false,
      }),
    ]);
    expect(preview.summary).toMatchObject({
      affectedLayerIds: [],
      updatedLayerIds: [],
      layerUpdates: [
        {
          operationIndex: 0,
          layerId: LAYER_ID,
          requestedFields: ["name"],
          changedFields: [],
          wouldChange: false,
        },
      ],
    });
  });

  it("validates fill-region and stamp-pattern previews through the cached exact output validator", async () => {
    await harness.client.listTools();
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );

    const preview = resultOf<{
      operations: Array<Record<string, unknown>>;
      summary: {
        operationCount: number;
        cellWrites: number;
        tileStamps: Array<Record<string, unknown>>;
      };
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: summary.revision,
          expectedDependencyRevisions:
            summary.dependencyRevisions,
          operations: [
            {
              type: "fillRegion",
              layerId: LAYER_ID,
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              tile: null,
            },
            {
              type: "stampPattern",
              layerId: LAYER_ID,
              x: 1,
              y: 0,
              pattern: [[null]],
            },
          ],
        },
      }),
    );

    expect(preview.operations).toMatchObject([
      {
        type: "fillRegion",
        layerId: LAYER_ID,
        region: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
        tile: null,
      },
      {
        type: "stampPattern",
        layerId: LAYER_ID,
        destructive: true,
        region: {
          x: 1,
          y: 0,
          width: 1,
          height: 1,
        },
        cellCount: 1,
        nonEmptyCellCount: 0,
        clearCellCount: 1,
        sample: [{ x: 1, y: 0, tile: null }],
        omittedCellCount: 0,
      },
    ]);
    expect(preview.summary).toMatchObject({
      operationCount: 2,
      cellWrites: 2,
      tileStamps: [
        {
          operationIndex: 1,
          layerId: LAYER_ID,
          region: {
            x: 1,
            y: 0,
            width: 1,
            height: 1,
          },
          cellCount: 1,
        },
      ],
    });
  });

  it.each([
    ["width", 0],
    ["height", -1],
  ] as const)(
    "returns a structured application error for a tile layer with %s=%i after caching output validators",
    async (field, value) => {
      await harness.client.listTools();
      const malformed = baseMap();
      const tileLayer = (malformed.layers as JsonObject[])[0];
      if (tileLayer === undefined) {
        throw new Error("Expected the fixture tile layer.");
      }
      tileLayer[field] = value;
      await writeJson(join(harness.root, MAP_PATH), malformed);

      const response = asToolResponse(
        await harness.client.callTool({
          name: "tiled_get_map_summary",
          arguments: { mapPath: MAP_PATH },
        }),
      );
      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          result: {
            ok: false,
            error: {
              code: "INVALID_DOCUMENT",
              details: {
                width: field === "width" ? value : 2,
                height: field === "height" ? value : 2,
              },
            },
          },
        },
      });
    },
  );

  it("rejects unsupported layer discriminators before projecting a map summary", async () => {
    await harness.client.listTools();
    const malformed = baseMap();
    const tileLayer = (malformed.layers as JsonObject[])[0];
    if (tileLayer === undefined) {
      throw new Error("Expected the fixture tile layer.");
    }
    tileLayer.type = "future-layer";
    await writeJson(join(harness.root, MAP_PATH), malformed);

    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        result: {
          ok: false,
          error: {
            code: "INVALID_DOCUMENT",
            details: {
              layerType: "future-layer",
            },
          },
        },
      },
    });
  });

  it("lists broadly formatted checkpoint IDs and Date.parse timestamps through the cached exact output validator", async () => {
    await harness.client.listTools();
    const checkpointsDirectory = join(
      harness.root,
      ".tiledmcp",
      "checkpoints",
    );
    await mkdir(checkpointsDirectory, { recursive: true });
    const validId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const corruptId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const createdAt = "Sat, 25 Jul 2026 00:00:00 GMT";
    expect(Number.isFinite(Date.parse(createdAt))).toBe(true);
    await writeJson(join(checkpointsDirectory, `${validId}.json`), {
      version: 1,
      id: validId,
      createdAt,
      label: "broad parser compatibility",
      path: MAP_PATH,
      status: "prepared",
      before: { existed: false },
      afterRevision: `sha256:${"0".repeat(64)}`,
    });
    await writeFile(
      join(checkpointsDirectory, `${corruptId}.json`),
      '{"version":',
      "utf8",
    );

    const listing = resultOf<{
      manifests: Array<{ id: string; createdAt: string }>;
      corruptEntries: Array<{
        fileName: string;
        checkpointId?: string;
        code: string;
      }>;
      scannedEntries: number;
      truncated: boolean;
    }>(
      await harness.client.callTool({
        name: "tiled_list_checkpoints",
        arguments: {},
      }),
    );
    expect(listing).toMatchObject({
      manifests: [
        {
          id: validId,
          createdAt,
        },
      ],
      corruptEntries: [
        {
          fileName: `${corruptId}.json`,
          checkpointId: corruptId,
          code: "CHECKPOINT_CORRUPT",
        },
      ],
      scannedEntries: 2,
      truncated: false,
    });
  });

  it("advertises an exact output schema for the optional rasterizer tool", async () => {
    const rasterHarness = await createHarness({
      rasterizerAvailable: true,
      rasterizerPng: await terrainPng(),
    });
    try {
      const listed = await rasterHarness.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        ...CORE_TOOLS,
        "tiled_render_map",
      ]);
      const rasterTool = listed.tools.find(
        (tool) => tool.name === "tiled_render_map",
      );
      expect(rasterTool?.outputSchema).toMatchObject({
        type: "object",
        properties: {
          result: expect.any(Object),
        },
        additionalProperties: false,
      });
      expect(
        (rasterTool?.outputSchema as { required?: unknown } | undefined)
          ?.required,
      ).toEqual(["result"]);
      expectNoUnconstrainedOutputSchemas(
        rasterTool?.outputSchema,
        "tiled_render_map",
      );
      const capabilities = resultOf<{
        registeredTools: string[];
        cli: {
          rasterizer: {
            available: boolean;
          };
        };
      }>(
        await rasterHarness.client.callTool({
          name: "tiled_get_capabilities",
          arguments: {},
        }),
      );
      expect(capabilities).toMatchObject({
        registeredTools: [
          ...CORE_TOOLS,
          "tiled_render_map",
        ],
        cli: {
          rasterizer: {
            available: true,
          },
        },
      });

      const applicationError = asToolResponse(
        await rasterHarness.client.callTool({
          name: "tiled_render_map",
          arguments: { mapPath: "../outside.tmj" },
        }),
      );
      expect(applicationError).toMatchObject({
        isError: true,
        structuredContent: {
          result: {
            ok: false,
            error: {
              code: "INVALID_PROJECT_PATH",
            },
          },
        },
      });
      const rasterErrorSummary = textSummaryOf(
        applicationError,
        false,
      );
      expect(rasterErrorSummary.error).toEqual({
        code: "INVALID_PROJECT_PATH",
        message:
          "Project path is not canonical or escapes the root: ../outside.tmj",
      });
      expect(rasterErrorSummary.error).not.toHaveProperty(
        "details",
      );

      const rasterResponse = asToolResponse(
        await rasterHarness.client.callTool({
          name: "tiled_render_map",
          arguments: {
            mapPath: MAP_PATH,
            size: 128,
          },
        }),
      );
      expect(rasterResponse.isError).not.toBe(true);
      expect(
        rasterResponse.content.map((block) => block.type),
      ).toEqual(["text", "image"]);
      const imageBlock = rasterResponse.content[1];
      expect(imageBlock).toMatchObject({
        type: "image",
        mimeType: "image/png",
        data: expect.any(String),
      });
      const png = Buffer.from(imageBlock?.data ?? "", "base64");
      expect(textSummaryOf(rasterResponse, true).image).toEqual({
        mimeType: "image/png",
        bytes: png.byteLength,
      });
      expect(
        (
          rasterResponse.structuredContent as {
            result: {
              mapPath: string;
              mimeType: string;
              bytes: number;
              width: number;
              height: number;
            };
          }
        ).result,
      ).toEqual({
        mapPath: MAP_PATH,
        mimeType: "image/png",
        bytes: png.byteLength,
        width: 32,
        height: 32,
      });
    } finally {
      await rasterHarness.client.close().catch(() => undefined);
      await rasterHarness.server.close().catch(() => undefined);
      await rm(rasterHarness.root, { recursive: true, force: true });
    }
  });

  it("advertises and serves the bounded direct guide resource", async () => {
    expect(harness.client.getServerVersion()).toEqual({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    expect(harness.client.getServerCapabilities()).toMatchObject({
      resources: { listChanged: true },
    });

    const listed = await harness.client.listResources();
    expect(listed.resources).toEqual([
      {
        uri: GUIDE_RESOURCE_URI,
        name: "guide",
        title: "TiledMCP safe editing guide",
        description:
          "A concise workflow for inspecting, previewing, approving, applying, and verifying safe Tiled map edits.",
        mimeType: GUIDE_RESOURCE_MIME_TYPE,
        size: GUIDE_RESOURCE_SIZE,
        annotations: {
          audience: ["assistant", "user"],
          priority: 1,
        },
        _meta: {
          revision: GUIDE_RESOURCE_REVISION,
          size: GUIDE_RESOURCE_SIZE,
          serverVersion: SERVER_VERSION,
        },
      },
    ]);
    expect(await harness.client.listResourceTemplates()).toEqual({
      resourceTemplates: [],
    });

    const read = await harness.client.readResource({
      uri: GUIDE_RESOURCE_URI,
    });
    expect(read.contents).toHaveLength(1);
    const content = read.contents[0];
    expect(content).toBeDefined();
    expect(content).toMatchObject({
      uri: GUIDE_RESOURCE_URI,
      mimeType: GUIDE_RESOURCE_MIME_TYPE,
      _meta: {
        revision: GUIDE_RESOURCE_REVISION,
        size: GUIDE_RESOURCE_SIZE,
        serverVersion: SERVER_VERSION,
      },
    });
    expect(content?._meta).not.toHaveProperty("lastModified");
    expect(content).toHaveProperty("text");
    if (!content || !("text" in content)) {
      throw new Error("Expected tiled://guide to return text content");
    }
    const bytes = Buffer.from(content.text, "utf8");
    expect(bytes.byteLength).toBe(GUIDE_RESOURCE_SIZE);
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_GUIDE_RESOURCE_BYTES);
    expect(revisionOf(bytes)).toBe(GUIDE_RESOURCE_REVISION);
    for (const toolName of CORE_TOOLS) {
      expect(content.text).toContain(`\`${toolName}\``);
    }
    for (const fieldName of [
      "mapPath",
      "tilesetAssetId",
      "query",
      "startTileId",
      "expectedMapRevision",
      "expectedTilesetRevision",
    ]) {
      expect(content.text).toContain(`\`${fieldName}\``);
    }
    expect(content.text).toMatch(
      /`tiled_get_tileset` with that `mapPath` and the selected\s+`tilesetAssetId`/u,
    );
    expect(content.text).toMatch(
      /`tiled_find_tiles` with that `mapPath`, the selected\s+`tilesetAssetId`, and an exact[\s\S]+`query`/u,
    );
    expect(content.text).toMatch(
      /`tiled_render_tileset_sheet` with that `mapPath` and\s+`tilesetAssetId`/u,
    );
    expect(content.text).toContain("client owns the approval step");
    expect(content.text).toContain("partial: true");
    expect(content.text).toContain(
      "treat `structuredContent.result` as the",
    );
    expect(content.text).toContain(
      "`tiled-mcp-summary` v1",
    );

    await expect(
      harness.client.readResource({ uri: "tiled://missing" }),
    ).rejects.toThrow("Resource tiled://missing not found");
  });

  it("serves capabilities, project assets, summaries, regions and validation", async () => {
    const capabilities = resultOf<{
      protocolBaseline: string;
      registeredTools: string[];
      resourceCapabilities: {
        direct: string[];
        templates: string[];
        subscriptions: boolean;
        listChanged: boolean;
      };
      checkpointCapabilities: {
        automaticBeforeWrite: boolean;
        startupPreparedReconciliation: boolean;
        boundedListing: boolean;
        exactByteRestoreKernel: boolean;
        previewAndApplyRestore: boolean;
        restoreScope: string;
        restoresReferencedDependencies: boolean;
      };
      mapOperations: string[];
      mapUpdateCapabilities: {
        fields: string[];
        renderOrders: string[];
        backgroundColorNullDeletes: boolean;
        maxClassNameCodePoints: number;
        operationOrdering: string;
        sourcePatch: string;
      };
      tileOperations: string[];
      tileStampCapabilities: {
        pattern: string;
        origin: string;
        nullSemantics: string;
        skipSentinel: boolean;
        clipping: boolean;
        transformEncoding: string;
        operationOrdering: string;
        sourcePatch: string;
      };
      tileFloodFillCapabilities: {
        seedSourceMatch: string;
        connectivity: string;
        nullableTarget: boolean;
        coordinates: string;
        operationOrdering: string;
        scanAccounting: string;
        scanBudget: string;
        sourcePatch: string;
      };
      tileCopyCapabilities: {
        coordinates: string;
        clipping: boolean;
        overlap: string;
        emptySource: string;
        gidCopy: string;
        observedGidValidation: string;
        operationOrdering: string;
        scanBudget: string;
        sourcePatch: string;
      };
      tileReplacementCapabilities: {
        match: string;
        transformMatch: string;
        mappingEvaluation: string;
        emptySource: boolean;
        nullableTarget: boolean;
        defaultRegion: string;
      };
      objectOperations: string[];
      objectShapeCapabilities: {
        creatable: string[];
        shapeMutation: boolean;
        ellipseAndCapsuleDimensions: string;
        sourcePatch: string;
      };
      layerOperations: string[];
      layerUpdateCapabilities: {
        layerTypes: string[];
        fields: string[];
        tintColorNullDeletes: boolean;
        lockedSemantics: string;
        sourcePatch: string;
      };
      layerDeletionCapabilities: {
        planner: string;
        layerTypes: string[];
        nonEmptyGroupConfirmation: string;
        objectReferencePolicy: string;
        lockedSemantics: string;
        idHighWaterMarks: string;
        sourcePatch: string;
      };
      layerMoveCapabilities: {
        planner: string;
        layerTypes: string[];
        target: string;
        indexSemantics: string;
        cycleProtection: boolean;
        depthLimit: number;
        lockedSemantics: string;
        idHighWaterMarks: string;
        sourcePatch: string;
      };
      layerDuplicationCapabilities: {
        planner: string;
        layerTypes: string[];
        defaultDestination: string;
        indexSemantics: string;
        idAllocation: string;
        objectReferencePolicy: string;
        typedReferenceSafety: string;
        externalFilePolicy: string;
        lockedSemantics: string;
        sourcePatch: string;
        maxSerializedDuplicateBytes: number;
      };
      tilesetSheetCapabilities: {
        supportedFormats: string[];
        pageIndexBase: number;
        defaultPageSize: number;
        defaultScale: number;
        consecutiveLocalIds: boolean;
        semanticNames: boolean;
      };
      tilesetDetailCapabilities: {
        locator: string;
        tileMetadataOrder: string;
        tileClassField: string;
        defaultLimit: number;
        returnsAllDependencyRevisions: boolean;
        returnsPropertyValues: boolean;
        returnsCollisionGeometry: boolean;
        returnsWangAssignments: boolean;
        validatesRenderingEnums: boolean;
      };
      tileFindCapabilities: {
        locator: string;
        queryModes: string[];
        defaultQueryMode: string;
        queryKinds: string[];
        propertyEqualsTypes: string[];
        customOrComplexPropertyEquals: string;
        comparison: string;
        tileClassField: string;
        candidates: string;
        returnsTileRefs: boolean;
        returnsPropertyValues: boolean;
        resolvesInheritedProperties: boolean;
        wangAssignments: boolean;
        nextPageIncludesRevisionPins: boolean;
        inputRevisionPins: string;
      };
      usageAnalysisCapabilities: {
        profile: string;
        includesTileLayerCells: boolean;
        includesTileObjects: boolean;
        visibility: string;
        transformAggregation: string;
        unusedLocalIdDomain: string;
        output: string;
        optionalExactReadSetPins: boolean;
        snapshotConsistency: string;
        defaultTopTileLimit: number;
      };
      tilesetReferenceCapabilities: {
        planner: string;
        targetProfile: string;
        firstGidAllocation: string;
        existingDependencyPins: string;
        targetRevisionPin: string;
        writeTarget: string;
        removalPlanner: string;
        removalPolicy: string;
        removalLocator: string;
        removalSourcePatch: string;
      };
      layerCreationCapabilities: {
        planner: string;
        mapProfile: string;
        types: string[];
        placement: string;
        idAllocation: string;
        imageSource: string;
        writeTarget: string;
      };
      nativePreviewCapabilities: {
        renderProfile: string;
        supportedFormats: string[];
        defaultScale: number;
        layerSelection: string[];
        overlays: string[];
        regionCoordinates: string;
        reportsOmittedVisibleLayers: boolean;
      };
      limits: {
        maxTilesetImageBytes: number;
        maxSimpleSvgBytes: number;
        maxTilesetImageEdge: number;
        maxTilesetDecodedPixels: number;
        maxTilesetSheetBytes: number;
        maxTilesetSheetEdge: number;
        maxTilesetSheetPixels: number;
        maxTilesetSheetPageSize: number;
        maxTilesetSheetColumns: number;
        maxTilesetSheetScale: number;
        maxTilesetMetadataLimit: number;
        maxTilesetMetadataEntries: number;
        maxTilesetAnimationFrames: number;
        maxTilesetAnimationFrameSample: number;
        maxTilesetCollisionObjects: number;
        maxTilesetPropertyEntries: number;
        maxTilesetWangSets: number;
        maxTilesetWangSetSummaries: number;
        maxTilesetDetailDisplayCodePoints: number;
        maxTilesetDetailResultBytes: number;
        maxTileFindLimit: number;
        maxTileFindClauses: number;
        maxTileFindQueryBytes: number;
        maxTileFindQueryCodePoints: number;
        maxTileFindValueCodePoints: number;
        maxTileFindEvaluations: number;
        maxTileFindResultBytes: number;
        maxAddTilesetGidScans: number;
        maxRemoveTilesetGidScans: number;
        maxSerializedDuplicateBytes: number;
        maxUsageScanValues: number;
        maxUsageDistinctTiles: number;
        maxUsageTopTileLimit: number;
        maxUsageLayerSummaries: number;
        maxUsageTilesetSummaries: number;
        maxUsageUnusedLocalIdSample: number;
        maxUsageResultBytes: number;
        maxReplaceTileMappings: number;
        maxTileOperationScans: number;
        maxFloodFillScans: number;
        maxReplaceTileScans: number;
        maxStampPatternEdge: number;
        maxStampPatternCells: number;
        maxCreateTileLayerCells: number;
        maxLayerNameLength: number;
        maxNativePreviewBytes: number;
        maxNativePreviewEdge: number;
        maxNativePreviewPixels: number;
        maxNativePreviewScale: number;
        maxNativePreviewRegionCells: number;
        maxNativePreviewLayers: number;
        maxNativePreviewTileDraws: number;
        maxNativePreviewPixelBlends: number;
        maxNativePreviewAtlases: number;
        maxNativePreviewOmittedLayers: number;
        maxNativePreviewLayerLabelLength: number;
        maxNativePreviewAggregateImageBytes: number;
        maxNativePreviewAggregateDecodedPixels: number;
      };
      safetyStatus: {
        jsonLexicalPreservation: {
          outsideEditedRanges: boolean;
          editedRangesReformatted: boolean;
        };
      };
      cli: {
        tiled: { available: boolean };
        rasterizer: { available: boolean };
      };
    }>(
      await harness.client.callTool({
        name: "tiled_get_capabilities",
        arguments: {},
      }),
    );
    expect(capabilities).toMatchObject({
      protocolBaseline: "2025-11-25",
      registeredTools: CORE_TOOLS,
      resourceCapabilities: {
        direct: [GUIDE_RESOURCE_URI],
        templates: [],
        subscriptions: false,
        listChanged: true,
      },
      checkpointCapabilities: {
        automaticBeforeWrite: true,
        startupPreparedReconciliation: true,
        boundedListing: true,
        exactByteRestoreKernel: true,
        previewAndApplyRestore: true,
        restoreScope: "single-existing-json-document",
        restoresReferencedDependencies: false,
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
      tileReplacementCapabilities: {
        match: "exact-encoded-gid",
        transformMatch: "exact",
        mappingEvaluation: "simultaneous-single-pass",
        emptySource: false,
        nullableTarget: true,
        defaultRegion: "target-layer-bounds",
      },
      objectOperations: ["createObject", "updateObject", "deleteObjects"],
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
        fields: [
          "name",
          "className",
          "visible",
          "opacity",
          "offsetX",
          "offsetY",
          "parallaxX",
          "parallaxY",
          "tintColor",
          "locked",
          "blendMode",
        ],
        tintColorNullDeletes: true,
        lockedSemantics: "advisory-metadata",
        sourcePatch: "object-member-local",
      },
      layerDeletionCapabilities: {
        planner: "generic-exclusive-operation-change-set",
        layerTypes: [
          "tilelayer",
          "objectgroup",
          "imagelayer",
          "group",
        ],
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
        layerTypes: [
          "tilelayer",
          "objectgroup",
          "imagelayer",
          "group",
        ],
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
        layerTypes: [
          "tilelayer",
          "objectgroup",
          "imagelayer",
          "group",
        ],
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
      tilesetSheetCapabilities: {
        supportedFormats: ["png", "jpeg", "webp", "simple-svg"],
        pageIndexBase: 0,
        defaultPageSize: 64,
        defaultScale: 2,
        consecutiveLocalIds: true,
        semanticNames: false,
      },
      tilesetDetailCapabilities: {
        locator: "map-path-plus-tileset-asset-id",
        tileMetadataOrder: "local-id",
        tileClassField: "type-with-class-compatibility-fallback",
        defaultLimit: 64,
        returnsAllDependencyRevisions: false,
        returnsPropertyValues: false,
        returnsCollisionGeometry: false,
        returnsWangAssignments: false,
        validatesRenderingEnums: true,
      },
      tileFindCapabilities: {
        locator: "map-path-plus-tileset-asset-id",
        queryModes: ["all", "any"],
        defaultQueryMode: "all",
        queryKinds: ["class", "propertyExists", "propertyEquals"],
        propertyEqualsTypes: [
          "string",
          "int",
          "float",
          "bool",
          "color",
          "file",
        ],
        customOrComplexPropertyEquals: "reject-query",
        comparison: "case-sensitive-exact",
        tileClassField: "type-with-class-compatibility-fallback",
        candidates: "explicit-tiles-metadata-only",
        returnsTileRefs: true,
        returnsPropertyValues: false,
        resolvesInheritedProperties: false,
        wangAssignments: false,
        nextPageIncludesRevisionPins: true,
        inputRevisionPins: "optional",
      },
      usageAnalysisCapabilities: {
        profile:
          "finite-orthogonal-tmj-external-atlas-tsj",
        includesTileLayerCells: true,
        includesTileObjects: true,
        visibility: "all-serialized-layers",
        transformAggregation: "base-tile",
        unusedLocalIdDomain:
          "zero-to-tilecount-exclusive",
        output: "bounded-summary-and-samples",
        optionalExactReadSetPins: true,
        snapshotConsistency: "non-atomic-read-set",
        defaultTopTileLimit: 64,
      },
      tilesetReferenceCapabilities: {
        planner: "dedicated-single-operation-change-set",
        targetProfile: "project-local-external-root-atlas-tsj",
        firstGidAllocation: "after-highest-occupied-range",
        existingDependencyPins: "required-exact",
        targetRevisionPin: "optional-capture-current",
        writeTarget: "map-only",
        removalPlanner:
          "generic-exclusive-operation-change-set",
        removalPolicy: "unused-only",
        removalLocator: "tileset-asset-id",
        removalSourcePatch: "array-element-local",
      },
      layerCreationCapabilities: {
        planner: "dedicated-single-operation-change-set",
        mapProfile: "finite-orthogonal-tmj",
        types: [
          "tilelayer",
          "objectgroup",
          "imagelayer",
          "group",
        ],
        placement: "root-or-group-zero-based-index",
        idAllocation: "current-nextlayerid",
        imageSource:
          "project-local-revision-pinned-safe-image",
        writeTarget: "map-only",
      },
      nativePreviewCapabilities: {
        renderProfile:
          "finite-orthogonal-static-atlas-tilelayers-v1",
        supportedFormats: ["png", "jpeg", "webp", "simple-svg"],
        defaultScale: 2,
        layerSelection: ["visible", "explicit"],
        overlays: ["grid", "coordinates"],
        regionCoordinates: "absolute-map-tiles",
        reportsOmittedVisibleLayers: true,
      },
      limits: {
        maxTilesetImageBytes: 64 * 1024 * 1024,
        maxSimpleSvgBytes: 256 * 1024,
        maxTilesetImageEdge: 8_192,
        maxTilesetDecodedPixels: 4_096 * 4_096,
        maxTilesetSheetBytes: 8 * 1024 * 1024,
        maxTilesetSheetEdge: 2_048,
        maxTilesetSheetPixels: 1_500_000,
        maxTilesetSheetPageSize: 256,
        maxTilesetSheetColumns: 32,
        maxTilesetSheetScale: 4,
        maxTilesetMetadataLimit: 128,
        maxTilesetMetadataEntries: 100_000,
        maxTilesetAnimationFrames: 100_000,
        maxTilesetAnimationFrameSample: 16,
        maxTilesetCollisionObjects: 100_000,
        maxTilesetPropertyEntries: 100_000,
        maxTilesetWangSets: 10_000,
        maxTilesetWangSetSummaries: 32,
        maxTilesetDetailDisplayCodePoints: 128,
        maxTilesetDetailResultBytes: 256 * 1024,
        maxTileFindLimit: 128,
        maxTileFindClauses: 8,
        maxTileFindQueryBytes: 32 * 1024,
        maxTileFindQueryCodePoints: 256,
        maxTileFindValueCodePoints: 1_024,
        maxTileFindEvaluations: 800_000,
        maxTileFindResultBytes: 256 * 1024,
        maxAddTilesetGidScans: 1_000_000,
        maxRemoveTilesetGidScans: 1_000_000,
        maxSerializedDuplicateBytes: 16 * 1024 * 1024,
        maxUsageScanValues: 1_000_000,
        maxUsageDistinctTiles: 100_000,
        maxUsageTopTileLimit: 128,
        maxUsageLayerSummaries: 64,
        maxUsageTilesetSummaries: 64,
        maxUsageUnusedLocalIdSample: 16,
        maxUsageResultBytes: 256 * 1024,
        maxReplaceTileMappings: 128,
        maxTileOperationScans: 1_000_000,
        maxFloodFillScans: 1_000_000,
        maxReplaceTileScans: 1_000_000,
        maxStampPatternEdge: 256,
        maxStampPatternCells: 16_384,
        maxCreateTileLayerCells: 100_000,
        maxLayerNameLength: 1_024,
        maxNativePreviewBytes: 8 * 1024 * 1024,
        maxNativePreviewEdge: 2_048,
        maxNativePreviewPixels: 1_500_000,
        maxNativePreviewScale: 4,
        maxNativePreviewRegionCells: 20_000,
        maxNativePreviewLayers: 128,
        maxNativePreviewTileDraws: 250_000,
        maxNativePreviewPixelBlends: 30_000_000,
        maxNativePreviewAtlases: 64,
        maxNativePreviewOmittedLayers: 128,
        maxNativePreviewLayerLabelLength: 128,
        maxNativePreviewAggregateImageBytes: 64 * 1024 * 1024,
        maxNativePreviewAggregateDecodedPixels: 16_000_000,
      },
      safetyStatus: {
        jsonLexicalPreservation: {
          outsideEditedRanges: true,
          editedRangesReformatted: true,
        },
      },
      cli: {
        tiled: { available: false },
        rasterizer: { available: false },
      },
    });
    expect(capabilities.objectShapeCapabilities).toEqual({
      creatable: ["rectangle", "point", "ellipse", "capsule"],
      shapeMutation: false,
      ellipseAndCapsuleDimensions:
        "optional-nonnegative-default-zero",
      sourcePatch: "object-layer-objects-member-local",
    });

    const assets = resultOf<Array<{ path: string; kind: string }>>(
      await harness.client.callTool({
        name: "tiled_list_files",
        arguments: {},
      }),
    );
    expect(assets).toEqual([
      { path: MAP_PATH, kind: "map" },
      { path: TILESET_PATH, kind: "tileset" },
    ]);

    const summary = resultOf<{
      revision: string;
      layers: Array<{ id: number; name: string }>;
      tilesets: Array<{ assetId: string; revision: string }>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    expect(summary).toMatchObject({
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      layers: [
        { id: LAYER_ID, name: "Ground" },
        { id: OBJECT_LAYER_ID, name: "Objects" },
      ],
      tilesets: [{ assetId: expect.stringMatching(/^asset_[0-9a-f]{24}$/u) }],
    });
    const summaryTileset = summary.tilesets[0];
    expect(summaryTileset).toBeDefined();

    const tilesetDetails = resultOf<{
      map: { path: string; revision: string };
      source: { assetId: string; revision: string };
      binding: { firstGid: number; lastGid: number };
      tileset: {
        path: string;
        tileCount: number;
        tileSize: { width: number; height: number };
        atlas: { columns: number; rows: number };
        image: {
          path: string;
          declaredPixelSize: { width: number; height: number };
        };
        featureCounts: { metadataTiles: number; wangSets: number };
      };
      tileMetadata: {
        total: number;
        returned: number;
        items: unknown[];
      };
      wangSets: { total: number; items: unknown[] };
      snapshotConsistency: string;
    }>(
      await harness.client.callTool({
        name: "tiled_get_tileset",
        arguments: {
          mapPath: MAP_PATH,
          tilesetAssetId: summaryTileset?.assetId,
        },
      }),
    );
    expect(tilesetDetails).toMatchObject({
      map: { path: MAP_PATH, revision: summary.revision },
      source: {
        assetId: summaryTileset?.assetId,
        revision: summaryTileset?.revision,
      },
      binding: { firstGid: 1, lastGid: 4 },
      tileset: {
        path: TILESET_PATH,
        tileCount: 4,
        tileSize: { width: 16, height: 16 },
        atlas: { columns: 2, rows: 2 },
        image: {
          path: "tiles/terrain.png",
          declaredPixelSize: { width: 32, height: 32 },
        },
        featureCounts: { metadataTiles: 0, wangSets: 0 },
      },
      tileMetadata: { total: 0, returned: 0, items: [] },
      wangSets: { total: 0, items: [] },
      snapshotConsistency: "non-atomic-read-set",
    });
    expect(tilesetDetails).not.toHaveProperty("dependencyRevisions");

    const region = resultOf<{
      revision: string;
      rows: Array<Array<{ localId: number } | null>>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_region",
        arguments: {
          mapPath: MAP_PATH,
          layerId: LAYER_ID,
          x: 0,
          y: 0,
          width: 2,
          height: 1,
        },
      }),
    );
    expect(region).toMatchObject({
      revision: summary.revision,
      rows: [[{ localId: 0 }, null]],
    });

    const objects = resultOf<{
      revision: string;
      total: number;
      truncated: boolean;
      objects: Array<{ id: number; layerId: number }>;
    }>(
      await harness.client.callTool({
        name: "tiled_list_objects",
        arguments: { mapPath: MAP_PATH, layerId: OBJECT_LAYER_ID, limit: 1 },
      }),
    );
    expect(objects).toMatchObject({
      revision: summary.revision,
      total: 2,
      truncated: true,
      objects: [{ id: RECTANGLE_OBJECT_ID, layerId: OBJECT_LAYER_ID }],
    });

    const validation = resultOf<{
      path: string;
      revision: string;
      valid: boolean;
      diagnostics: unknown[];
    }>(
      await harness.client.callTool({
        name: "tiled_validate",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    expect(validation).toEqual({
      path: MAP_PATH,
      revision: summary.revision,
      valid: true,
      diagnostics: [],
    });
  });

  it("analyzes bounded whole-map tile usage with an optional exact read-set pin", async () => {
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
      tilesets: Array<{ assetId: string }>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const assetId = summary.tilesets[0]?.assetId;
    if (assetId === undefined) {
      throw new Error("Expected the fixture tileset binding.");
    }

    const missingPair = asToolResponse(
      await harness.client.callTool({
        name: "tiled_analyze_usage",
        arguments: {
          mapPath: MAP_PATH,
          expectedMapRevision: summary.revision,
        },
      }),
    );
    expect(missingPair.isError).toBe(true);
    expect(missingPair.structuredContent).toBeUndefined();
    expect(missingPair.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Input validation error"),
      }),
    ]);

    const usage = resultOf<Record<string, unknown>>(
      await harness.client.callTool({
        name: "tiled_analyze_usage",
        arguments: {
          mapPath: MAP_PATH,
          topTileLimit: 1,
          expectedMapRevision: summary.revision,
          expectedDependencyRevisions:
            summary.dependencyRevisions,
        },
      }),
    );
    expect(usage).toMatchObject({
      profile:
        "finite-orthogonal-tmj-external-atlas-tsj",
      map: {
        path: MAP_PATH,
        revision: summary.revision,
      },
      dependencyRevisions: summary.dependencyRevisions,
      scope: {
        tileLayers: "all-recursive",
        tileObjects: "all-recursive",
        visibility: "ignored",
        transformAggregation: "base-tile",
      },
      scan: {
        tileCellCount: 4,
        objectCount: 2,
        valueCount: 6,
        limit: 1_000_000,
      },
      totals: {
        tileLayerCount: 1,
        objectLayerCount: 1,
        emptyTileCellCount: 3,
        nonEmptyTileCellCount: 1,
        tileObjectCount: 0,
        referenceCount: 1,
        distinctUsedTileCount: 1,
        usedTilesetCount: 1,
        unusedTilesetCount: 0,
      },
      transforms: {
        identityReferenceCount: 1,
        transformedReferenceCount: 0,
        rawFlagUsage: [{ rawFlags: 0, referenceCount: 1 }],
      },
      layerDensity: {
        total: 1,
        returned: 1,
        omitted: 0,
        truncated: false,
        order: "density-asc-then-layer-id",
        items: [
          {
            layerId: LAYER_ID,
            cellCount: 4,
            emptyCellCount: 3,
            nonEmptyCellCount: 1,
            density: 0.25,
          },
        ],
      },
      tilesets: {
        total: 1,
        returned: 1,
        omitted: 0,
        truncated: false,
        items: [
          {
            assetId,
            unused: false,
            referenceCount: 1,
            usedLocalIdCount: 1,
            unusedLocalIds: {
              count: 3,
              sample: [1, 2, 3],
              truncated: false,
            },
          },
        ],
      },
      topTiles: {
        limit: 1,
        returned: 1,
        distinctUsedTileCount: 1,
        truncated: false,
        items: [
          {
            tile: {
              tileset: { kind: "external", assetId },
              localId: 0,
            },
            references: {
              total: 1,
              tileCells: 1,
              tileObjects: 0,
              transformed: 0,
            },
          },
        ],
      },
      snapshotConsistency: "non-atomic-read-set",
    });
  });

  it("finds exact tile classes and scalar properties through the MCP contract", async () => {
    const tilesetDocument = baseTileset();
    tilesetDocument.tiles = [
      {
        id: 2,
        type: "Grass",
        properties: [
          { name: "walkable", type: "bool", value: false },
        ],
      },
      {
        id: 0,
        type: "Grass",
        properties: [
          { name: "walkable", type: "bool", value: true },
        ],
      },
      { id: 1, type: "Rock" },
    ];
    await writeJson(join(harness.root, TILESET_PATH), tilesetDocument);

    const summary = resultOf<{
      revision: string;
      tilesets: Array<{ assetId: string; revision: string }>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const tileset = summary.tilesets[0];
    expect(tileset).toBeDefined();

    const classQuery = {
      mode: "all",
      clauses: [{ kind: "class", equals: "Grass" }],
    } as const;
    const classSearch = resultOf<{
      map: { path: string; revision: string };
      source: { assetId: string; revision: string };
      projection: {
        kind: string;
        comparison: string;
        propertyValuesReturned: boolean;
        wangAssignments: string;
      };
      query: unknown;
      scan: {
        metadataEntries: number;
        propertyEntries: number;
        evaluations: number;
      };
      page: {
        order: string;
        startTileId: number;
        limit: number;
        totalMatches: number;
        returned: number;
        hasEarlier: boolean;
        hasMore: boolean;
        truncated: boolean;
        nextStartTileId?: number;
      };
      items: Array<{
        tile: {
          tileset: { kind: string; assetId: string };
          localId: number;
        };
        sourceIndex: number;
        matchedClauseIndexes: number[];
        class: { name: string; source: string };
      }>;
      nextPage?: {
        startTileId: number;
        expectedMapRevision: string;
        expectedTilesetRevision: string;
      };
      snapshotConsistency: string;
      truncated: boolean;
    }>(
      await harness.client.callTool({
        name: "tiled_find_tiles",
        arguments: {
          mapPath: MAP_PATH,
          tilesetAssetId: tileset?.assetId,
          query: classQuery,
          limit: 1,
          expectedMapRevision: summary.revision,
          expectedTilesetRevision: tileset?.revision,
        },
      }),
    );
    expect(classSearch).toMatchObject({
      map: { path: MAP_PATH, revision: summary.revision },
      source: {
        assetId: tileset?.assetId,
        revision: tileset?.revision,
      },
      projection: {
        kind: "explicit-tile-semantics-search",
        comparison: "case-sensitive-exact",
        propertyValuesReturned: false,
        wangAssignments: "not-indexed",
      },
      query: classQuery,
      scan: {
        metadataEntries: 3,
        propertyEntries: 0,
        evaluations: 3,
      },
      page: {
        order: "local-id",
        startTileId: 0,
        limit: 1,
        totalMatches: 2,
        returned: 1,
        hasEarlier: false,
        hasMore: true,
        truncated: true,
        nextStartTileId: 2,
      },
      items: [
        {
          tile: {
            tileset: {
              kind: "external",
              assetId: tileset?.assetId,
            },
            localId: 0,
          },
          sourceIndex: 1,
          matchedClauseIndexes: [0],
          class: { name: "Grass", source: "type" },
        },
      ],
      nextPage: {
        startTileId: 2,
        expectedMapRevision: summary.revision,
        expectedTilesetRevision: tileset?.revision,
      },
      snapshotConsistency: "non-atomic-read-set",
      truncated: true,
    });
    expect(classSearch).not.toHaveProperty("dependencyRevisions");

    const nextPage = classSearch.nextPage;
    expect(nextPage).toBeDefined();
    const secondClassPage = resultOf<{
      page: {
        startTileId: number;
        hasEarlier: boolean;
        hasMore: boolean;
      };
      items: Array<{ tile: { localId: number } }>;
    }>(
      await harness.client.callTool({
        name: "tiled_find_tiles",
        arguments: {
          mapPath: MAP_PATH,
          tilesetAssetId: tileset?.assetId,
          query: classQuery,
          limit: 1,
          ...nextPage,
        },
      }),
    );
    expect(secondClassPage).toMatchObject({
      page: {
        startTileId: 2,
        hasEarlier: true,
        hasMore: false,
      },
      items: [{ tile: { localId: 2 } }],
    });

    const propertyQuery = {
      mode: "all",
      clauses: [
        { kind: "propertyExists", name: "walkable" },
        {
          kind: "propertyEquals",
          name: "walkable",
          type: "bool",
          value: true,
        },
      ],
    } as const;
    const propertySearch = resultOf<{
      query: unknown;
      scan: {
        metadataEntries: number;
        propertyEntries: number;
        evaluations: number;
      };
      page: { totalMatches: number; returned: number };
      items: Array<{
        tile: { tileset: { assetId: string }; localId: number };
        matchedClauseIndexes: number[];
      }>;
    }>(
      await harness.client.callTool({
        name: "tiled_find_tiles",
        arguments: {
          mapPath: MAP_PATH,
          tilesetAssetId: tileset?.assetId,
          query: propertyQuery,
          expectedMapRevision: summary.revision,
          expectedTilesetRevision: tileset?.revision,
        },
      }),
    );
    expect(propertySearch).toMatchObject({
      query: propertyQuery,
      scan: {
        metadataEntries: 3,
        propertyEntries: 2,
        evaluations: 6,
      },
      page: { totalMatches: 1, returned: 1 },
      items: [
        {
          tile: {
            tileset: { assetId: tileset?.assetId },
            localId: 0,
          },
          matchedClauseIndexes: [0, 1],
        },
      ],
    });

    const defaultModeSearch = resultOf<{
      query: { mode: string };
      page: { totalMatches: number };
    }>(
      await harness.client.callTool({
        name: "tiled_find_tiles",
        arguments: {
          mapPath: MAP_PATH,
          tilesetAssetId: tileset?.assetId,
          query: {
            clauses: [{ kind: "class", equals: "Grass" }],
          },
        },
      }),
    );
    expect(defaultModeSearch).toMatchObject({
      query: { mode: "all" },
      page: { totalMatches: 2 },
    });
  });

  it("returns a labeled tileset sheet as MCP image content with snapshot metadata", async () => {
    const summary = resultOf<{
      revision: string;
      tilesets: Array<{ assetId: string; revision: string }>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const tileset = summary.tilesets[0];
    expect(tileset).toBeDefined();

    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_render_tileset_sheet",
        arguments: {
          mapPath: MAP_PATH,
          tilesetAssetId: tileset?.assetId,
        },
      }),
    );
    expect(response.isError).not.toBe(true);
    expect(response.content.map((block) => block.type)).toEqual([
      "text",
      "image",
    ]);
    const imageBlock = response.content[1];
    expect(imageBlock).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: expect.any(String),
    });
    const png = Buffer.from(imageBlock?.data ?? "", "base64");
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(textSummaryOf(response, true).image).toEqual({
      mimeType: "image/png",
      bytes: png.byteLength,
    });

    const result = (
      response.structuredContent as {
        result: {
          mimeType: string;
          pixelSize: { width: number; height: number };
          byteLength: number;
          sha256: string;
          source: { assetId: string; revision: string };
          map: { path: string; revision: string };
          image: { path: string; revision: string; format: string };
          page: {
            index: number;
            count: number;
            localIdRange: { first: number; last: number };
          };
          truncated: boolean;
        };
      }
    ).result;
    expect(result).toMatchObject({
      mimeType: "image/png",
      pixelSize: { width: 176, height: 70 },
      byteLength: png.byteLength,
      sha256: revisionOf(png),
      source: {
        assetId: tileset?.assetId,
        revision: tileset?.revision,
      },
      map: { path: MAP_PATH, revision: summary.revision },
      image: {
        path: "tiles/terrain.png",
        revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        format: "png",
      },
      page: {
        index: 0,
        count: 1,
        localIdRange: { first: 0, last: 3 },
      },
      truncated: false,
    });
  });

  it("returns a bounded native map preview with explicit coordinate metadata", async () => {
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_render_preview",
        arguments: {
          mapPath: MAP_PATH,
          overlays: { grid: true, coordinates: true },
        },
      }),
    );
    expect(response.isError).not.toBe(true);
    expect(response.content.map((block) => block.type)).toEqual([
      "text",
      "image",
    ]);
    const imageBlock = response.content[1];
    expect(imageBlock).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: expect.any(String),
    });
    const png = Buffer.from(imageBlock?.data ?? "", "base64");
    expect(textSummaryOf(response, true).image).toEqual({
      mimeType: "image/png",
      bytes: png.byteLength,
    });
    const result = (
      response.structuredContent as {
        result: {
          mimeType: string;
          pixelSize: { width: number; height: number };
          byteLength: number;
          sha256: string;
          map: { path: string; revision: string };
          dependencyRevisions: Record<string, string>;
          sources: Array<{
            assetId: string;
            tileset: { path: string; revision: string };
            image: { path: string; revision: string; format: string };
          }>;
          tileRegion: { x: number; y: number; width: number; height: number };
          coordinateTransform: {
            tileOrigin: { x: number; y: number };
            pixelOrigin: { x: number; y: number };
            pixelsPerTile: { x: number; y: number };
          };
          contentPixelRect: {
            x: number;
            y: number;
            width: number;
            height: number;
          };
          layerIds: number[];
          omittedLayers: Array<{ id: number; type: string }>;
          omittedLayerCount: number;
          omittedLayersTruncated: boolean;
          partial: boolean;
          snapshotConsistency: string;
          renderProfile: string;
          truncated: boolean;
        };
      }
    ).result;
    expect(result).toMatchObject({
      mimeType: "image/png",
      pixelSize: { width: 71, height: 73 },
      byteLength: png.byteLength,
      sha256: revisionOf(png),
      map: { path: MAP_PATH, revision: summary.revision },
      dependencyRevisions: summary.dependencyRevisions,
      sources: [
        {
          assetId: expect.stringMatching(/^asset_[0-9a-f]{24}$/u),
          tileset: {
            path: TILESET_PATH,
            revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          },
          image: {
            path: "tiles/terrain.png",
            revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            format: "png",
          },
        },
      ],
      tileRegion: { x: 0, y: 0, width: 2, height: 2 },
      coordinateTransform: {
        tileOrigin: { x: 0, y: 0 },
        pixelOrigin: { x: 7, y: 9 },
        pixelsPerTile: { x: 32, y: 32 },
      },
      contentPixelRect: { x: 7, y: 9, width: 64, height: 64 },
      layerIds: [LAYER_ID],
      omittedLayers: [{ id: OBJECT_LAYER_ID, type: "objectgroup" }],
      omittedLayerCount: 1,
      omittedLayersTruncated: false,
      partial: true,
      snapshotConsistency: "non-atomic-read-set",
      renderProfile: "finite-orthogonal-static-atlas-tilelayers-v1",
      truncated: false,
    });
  });

  it("returns no image when a native preview request fails its layer contract", async () => {
    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_render_preview",
        arguments: {
          mapPath: MAP_PATH,
          layerIds: [OBJECT_LAYER_ID],
        },
      }),
    );
    expect(response.isError).toBe(true);
    expect(response.content.every((block) => block.type !== "image")).toBe(
      true,
    );
    expect(response.structuredContent).toMatchObject({
      result: {
        ok: false,
        error: {
          code: "LAYER_TYPE_MISMATCH",
          details: { layerId: OBJECT_LAYER_ID },
        },
      },
    });
  });

  it("returns an application error without image content for an unknown tileset asset", async () => {
    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_render_tileset_sheet",
        arguments: {
          mapPath: MAP_PATH,
          tilesetAssetId: "asset_missing",
        },
      }),
    );

    expect(response.isError).toBe(true);
    expect(response.content.every((block) => block.type !== "image")).toBe(true);
    expect(response.structuredContent).toMatchObject({
      result: {
        ok: false,
        error: { code: "TILESET_NOT_FOUND" },
      },
    });
  });

  it("rejects unknown input keys through strict tool schemas", async () => {
    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_validate",
        arguments: {
          mapPath: MAP_PATH,
          unexpected: true,
        },
      }),
    );

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    expect(response.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Input validation error"),
      }),
    ]);
    expect((response.content[0] as { text: string }).text).toContain(
      "Unrecognized key",
    );
  });

  it("rejects unknown checkpoint restore preview keys through its strict schema", async () => {
    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_preview_checkpoint_restore",
        arguments: {
          checkpointId: "00000000-0000-4000-8000-000000000000",
          expectedRevision: `sha256:${"0".repeat(64)}`,
          unexpected: true,
        },
      }),
    );

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    expect(response.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Input validation error"),
      }),
    ]);
    expect((response.content[0] as { text: string }).text).toContain(
      "Unrecognized key",
    );
  });

  it("rejects unknown tiled_find_tiles keys through its strict schema", async () => {
    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_find_tiles",
        arguments: {
          mapPath: MAP_PATH,
          tilesetAssetId: "asset_missing",
          query: {
            mode: "all",
            clauses: [{ kind: "class", equals: "Grass" }],
          },
          unexpected: true,
        },
      }),
    );

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    expect(response.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Input validation error"),
      }),
    ]);
    expect((response.content[0] as { text: string }).text).toContain(
      "Unrecognized key",
    );
  });

  it.each([
    {
      name: "a bool clause with a string scalar",
      arguments: {
        mapPath: MAP_PATH,
        tilesetAssetId: "asset_missing",
        query: {
          mode: "all",
          clauses: [
            {
              kind: "propertyEquals",
              name: "walkable",
              type: "bool",
              value: "true",
            },
          ],
        },
      },
    },
    {
      name: "a malformed expected map revision",
      arguments: {
        mapPath: MAP_PATH,
        tilesetAssetId: "asset_missing",
        query: {
          mode: "all",
          clauses: [{ kind: "class", equals: "Grass" }],
        },
        expectedMapRevision: "sha256:not-a-revision",
      },
    },
    {
      name: "a malformed expected tileset revision",
      arguments: {
        mapPath: MAP_PATH,
        tilesetAssetId: "asset_missing",
        query: {
          mode: "all",
          clauses: [{ kind: "class", equals: "Grass" }],
        },
        expectedTilesetRevision: "sha256:not-a-revision",
      },
    },
  ])("rejects tiled_find_tiles input with $name", async ({ arguments: input }) => {
    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_find_tiles",
        arguments: input,
      }),
    );

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    expect(response.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Input validation error"),
      }),
    ]);
  });

  it("returns structured conflicts for stale tile-search page revisions", async () => {
    const summary = resultOf<{
      revision: string;
      tilesets: Array<{ assetId: string; revision: string }>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const tileset = summary.tilesets[0];
    expect(tileset).toBeDefined();
    const query = {
      mode: "all",
      clauses: [{ kind: "class", equals: "Grass" }],
    };
    const staleRevision = `sha256:${"0".repeat(64)}`;

    const staleMap = asToolResponse(
      await harness.client.callTool({
        name: "tiled_find_tiles",
        arguments: {
          mapPath: MAP_PATH,
          tilesetAssetId: tileset?.assetId,
          query,
          expectedMapRevision: staleRevision,
          expectedTilesetRevision: tileset?.revision,
        },
      }),
    );
    expect(staleMap).toMatchObject({
      isError: true,
      structuredContent: {
        result: {
          ok: false,
          error: {
            code: "REVISION_CONFLICT",
            details: {
              expectedRevision: staleRevision,
              actualRevision: summary.revision,
            },
          },
        },
      },
    });

    const staleTileset = asToolResponse(
      await harness.client.callTool({
        name: "tiled_find_tiles",
        arguments: {
          mapPath: MAP_PATH,
          tilesetAssetId: tileset?.assetId,
          query,
          expectedMapRevision: summary.revision,
          expectedTilesetRevision: staleRevision,
        },
      }),
    );
    expect(staleTileset).toMatchObject({
      isError: true,
      structuredContent: {
        result: {
          ok: false,
          error: {
            code: "DEPENDENCY_REVISION_CONFLICT",
            details: {
              assetId: tileset?.assetId,
              expectedRevision: staleRevision,
              actualRevision: tileset?.revision,
            },
          },
        },
      },
    });
  });

  it("bounds dependency revision keys at the MCP boundary", async () => {
    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: `sha256:${"0".repeat(64)}`,
          expectedDependencyRevisions: {
            ["x".repeat(129)]: `sha256:${"0".repeat(64)}`,
          },
          operations: [
            {
              type: "updateObject",
              objectId: RECTANGLE_OBJECT_ID,
              patch: { x: 1 },
            },
          ],
        },
      }),
    );

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    expect(response.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Input validation error"),
      }),
    ]);
  });

  it("previews and applies strict root map-property updates", async () => {
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    for (const operation of [
      { type: "updateMap", patch: {} },
      {
        type: "updateMap",
        patch: { renderOrder: "clockwise" },
      },
      {
        type: "updateMap",
        patch: { backgroundColor: "#abc" },
      },
      {
        type: "updateMap",
        patch: { className: null },
      },
      {
        type: "updateMap",
        patch: {
          className: "🌲".repeat(1_025),
        },
      },
      {
        type: "updateMap",
        patch: { unknown: true },
      },
      {
        type: "updateMap",
        patch: { className: "MapClass" },
        unexpected: true,
      },
    ]) {
      const rejected = asToolResponse(
        await harness.client.callTool({
          name: "tiled_preview_edits",
          arguments: {
            mapPath: MAP_PATH,
            expectedRevision: summary.revision,
            expectedDependencyRevisions:
              summary.dependencyRevisions,
            operations: [operation],
          },
        }),
      );
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toBeUndefined();
      expect(rejected.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(
            "Input validation error",
          ),
        }),
      ]);
    }

    const maximumAstralClass =
      "🌲".repeat(1_024);
    expect(
      resultOf<{
        operations: Array<Record<string, unknown>>;
      }>(
        await harness.client.callTool({
          name: "tiled_preview_edits",
          arguments: {
            mapPath: MAP_PATH,
            expectedRevision: summary.revision,
            expectedDependencyRevisions:
              summary.dependencyRevisions,
            operations: [
              {
                type: "updateMap",
                patch: {
                  className: maximumAstralClass,
                },
              },
            ],
          },
        }),
      ),
    ).toMatchObject({
      operations: [
        {
          type: "updateMap",
          patch: {
            className: maximumAstralClass,
          },
          changedFields: ["className"],
        },
      ],
    });

    const absoluteMapPath = join(harness.root, MAP_PATH);
    const before = await readFile(absoluteMapPath);
    const patch = {
      renderOrder: "left-up",
      backgroundColor: "#80112233",
      className: "WorldMap",
    } as const;
    const preview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
      operations: Array<Record<string, unknown>>;
      summary: {
        mapUpdates: Array<Record<string, unknown>>;
      };
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: summary.revision,
          expectedDependencyRevisions:
            summary.dependencyRevisions,
          operations: [
            {
              type: "updateMap",
              patch,
            },
          ],
        },
      }),
    );
    expect(preview).toMatchObject({
      changeSetId: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      expectedRevision: summary.revision,
      operations: [
        {
          type: "updateMap",
          destructive: false,
          patch,
          requestedFields: [
            "renderOrder",
            "backgroundColor",
            "className",
          ],
          changedFields: [
            "renderOrder",
            "backgroundColor",
            "className",
          ],
          wouldChange: true,
          renderingMayChange: true,
        },
      ],
      summary: {
        mapUpdates: [
          {
            operationIndex: 0,
            requestedFields: [
              "renderOrder",
              "backgroundColor",
              "className",
            ],
            changedFields: [
              "renderOrder",
              "backgroundColor",
              "className",
            ],
            wouldChange: true,
            renderingMayChange: true,
          },
        ],
      },
    });
    expect(await readFile(absoluteMapPath)).toEqual(before);

    const applied = resultOf<{
      changed: boolean;
      revision: string;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision: preview.expectedRevision,
        },
      }),
    );
    expect(applied.changed).toBe(true);
    const saved = JSON.parse(
      await readFile(absoluteMapPath, "utf8"),
    ) as JsonObject;
    expect(saved).toMatchObject({
      renderorder: "left-up",
      backgroundcolor: "#80112233",
      class: "WorldMap",
    });
    const latestSummary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
      [key: string]: unknown;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    expect(latestSummary).toMatchObject({
      renderOrder: "left-up",
      backgroundColor: "#80112233",
      className: "WorldMap",
    });

    const stalePreview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: latestSummary.revision,
          expectedDependencyRevisions:
            latestSummary.dependencyRevisions,
          operations: [
            {
              type: "updateMap",
              patch: { className: "StalePlan" },
            },
          ],
        },
      }),
    );
    const external = JSON.parse(
      await readFile(absoluteMapPath, "utf8"),
    ) as JsonObject;
    external.vendorExternalEdit = { preserve: true };
    await writeJson(absoluteMapPath, external);
    const externalBytes = await readFile(absoluteMapPath);
    const staleApply = asToolResponse(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: stalePreview.changeSetId,
          expectedRevision:
            stalePreview.expectedRevision,
        },
      }),
    );
    expect(staleApply).toMatchObject({
      isError: true,
      structuredContent: {
        result: {
          ok: false,
          error: { code: "REVISION_CONFLICT" },
        },
      },
    });
    expect(await readFile(absoluteMapPath)).toEqual(
      externalBytes,
    );
  });

  it("previews and applies strict common layer-property updates", async () => {
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    for (const patch of [
      {},
      { tintColor: "#abc" },
      { blendMode: "source-over" },
      { opacity: 2 },
      { unknown: true },
    ]) {
      const rejected = asToolResponse(
        await harness.client.callTool({
          name: "tiled_preview_edits",
          arguments: {
            mapPath: MAP_PATH,
            expectedRevision: summary.revision,
            expectedDependencyRevisions:
              summary.dependencyRevisions,
            operations: [
              {
                type: "updateLayer",
                layerId: LAYER_ID,
                patch,
              },
            ],
          },
        }),
      );
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toBeUndefined();
      expect(rejected.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(
            "Input validation error",
          ),
        }),
      ]);
    }

    const absoluteMapPath = join(harness.root, MAP_PATH);
    const before = await readFile(absoluteMapPath);
    const patch = {
      name: "Renamed Ground",
      className: "TerrainLayer",
      locked: true,
      tintColor: "#80112233",
      blendMode: "soft-light",
    };
    const preview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
      operations: Array<Record<string, unknown>>;
      summary: {
        affectedLayerIds: number[];
        updatedLayerIds: number[];
        layerUpdates: Array<Record<string, unknown>>;
      };
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: summary.revision,
          expectedDependencyRevisions:
            summary.dependencyRevisions,
          operations: [
            {
              type: "updateLayer",
              layerId: LAYER_ID,
              patch,
            },
          ],
        },
      }),
    );
    expect(preview).toMatchObject({
      changeSetId: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      expectedRevision: summary.revision,
      operations: [
        {
          type: "updateLayer",
          layerId: LAYER_ID,
          layerType: "tilelayer",
          destructive: false,
          patch,
          requestedFields: [
            "name",
            "className",
            "tintColor",
            "locked",
            "blendMode",
          ],
          changedFields: [
            "name",
            "className",
            "tintColor",
            "locked",
            "blendMode",
          ],
          wouldChange: true,
          affectsDescendants: false,
          warning: expect.stringContaining(
            "advisory metadata",
          ),
        },
      ],
      summary: {
        affectedLayerIds: [LAYER_ID],
        updatedLayerIds: [LAYER_ID],
        layerUpdates: [
          {
            operationIndex: 0,
            layerId: LAYER_ID,
            layerType: "tilelayer",
            requestedFields: [
              "name",
              "className",
              "tintColor",
              "locked",
              "blendMode",
            ],
            changedFields: [
              "name",
              "className",
              "tintColor",
              "locked",
              "blendMode",
            ],
            wouldChange: true,
            affectsDescendants: false,
          },
        ],
      },
    });
    expect(await readFile(absoluteMapPath)).toEqual(before);

    const applied = resultOf<{
      changed: boolean;
      revision: string;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision: preview.expectedRevision,
        },
      }),
    );
    expect(applied).toMatchObject({
      changed: true,
      revision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
    });
    const saved = JSON.parse(
      await readFile(absoluteMapPath, "utf8"),
    ) as JsonObject;
    expect((saved.layers as JsonObject[])[0]).toMatchObject({
      id: LAYER_ID,
      name: "Renamed Ground",
      class: "TerrainLayer",
      locked: true,
      tintcolor: "#80112233",
      mode: "soft-light",
    });
  });

  it("previews and applies strict exclusive layer deletion", async () => {
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    for (const operation of [
      {
        type: "deleteLayer",
        layerId: LAYER_ID,
        deleteDescendants: "yes",
      },
      {
        type: "deleteLayer",
        layerId: LAYER_ID,
        unexpected: true,
      },
    ]) {
      const rejected = asToolResponse(
        await harness.client.callTool({
          name: "tiled_preview_edits",
          arguments: {
            mapPath: MAP_PATH,
            expectedRevision: summary.revision,
            expectedDependencyRevisions:
              summary.dependencyRevisions,
            operations: [operation],
          },
        }),
      );
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toBeUndefined();
      expect(rejected.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(
            "Input validation error",
          ),
        }),
      ]);
    }

    const absoluteMapPath = join(harness.root, MAP_PATH);
    const before = await readFile(absoluteMapPath);
    const preview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
      operations: Array<Record<string, unknown>>;
      summary: {
        affectedLayerIds: number[];
        deletedLayers: Array<Record<string, unknown>>;
      };
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: summary.revision,
          expectedDependencyRevisions:
            summary.dependencyRevisions,
          operations: [
            {
              type: "deleteLayer",
              layerId: LAYER_ID,
            },
          ],
        },
      }),
    );
    expect(preview).toMatchObject({
      changeSetId: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      expectedRevision: summary.revision,
      operations: [
        {
          type: "deleteLayer",
          layerId: LAYER_ID,
          deleteDescendants: false,
          destructive: true,
          layer: {
            id: LAYER_ID,
            type: "tilelayer",
            name: "Ground",
            nameTruncated: false,
          },
          parentGroupId: null,
          index: 0,
          deletedLayerCount: 1,
          descendantLayerCount: 0,
          layerIdSample: [LAYER_ID],
          omittedLayerCount: 0,
          objectCount: 0,
          objectIdSample: [],
          omittedObjectCount: 0,
          warning: expect.stringContaining(
            "permanently removes",
          ),
        },
      ],
      summary: {
        affectedLayerIds: [LAYER_ID],
        deletedLayers: [
          {
            operationIndex: 0,
            layerId: LAYER_ID,
            layerType: "tilelayer",
            parentGroupId: null,
            index: 0,
            deletedLayerCount: 1,
            descendantLayerCount: 0,
          },
        ],
      },
    });
    expect(await readFile(absoluteMapPath)).toEqual(before);

    const applied = resultOf<{
      changed: boolean;
      revision: string;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision: preview.expectedRevision,
        },
      }),
    );
    expect(applied).toMatchObject({
      changed: true,
      revision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
    });
    const saved = JSON.parse(
      await readFile(absoluteMapPath, "utf8"),
    ) as JsonObject;
    expect(
      (saved.layers as JsonObject[]).some(
        (layer) => layer.id === LAYER_ID,
      ),
    ).toBe(false);
    expect(saved.nextlayerid).toBe(9);
    expect(saved.nextobjectid).toBe(3);
  });

  it("previews and applies strict exclusive layer movement", async () => {
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    for (const operation of [
      {
        type: "moveLayer",
        layerId: LAYER_ID,
      },
      {
        type: "moveLayer",
        layerId: LAYER_ID,
        index: 1,
        parentGroupId: null,
      },
      {
        type: "moveLayer",
        layerId: LAYER_ID,
        index: 1,
        unexpected: true,
      },
    ]) {
      const rejected = asToolResponse(
        await harness.client.callTool({
          name: "tiled_preview_edits",
          arguments: {
            mapPath: MAP_PATH,
            expectedRevision: summary.revision,
            expectedDependencyRevisions:
              summary.dependencyRevisions,
            operations: [operation],
          },
        }),
      );
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toBeUndefined();
      expect(rejected.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(
            "Input validation error",
          ),
        }),
      ]);
    }

    const absoluteMapPath = join(harness.root, MAP_PATH);
    const before = await readFile(absoluteMapPath);
    const preview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
      operations: Array<Record<string, unknown>>;
      summary: {
        affectedLayerIds: number[];
        movedLayers: Array<Record<string, unknown>>;
      };
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: summary.revision,
          expectedDependencyRevisions:
            summary.dependencyRevisions,
          operations: [
            {
              type: "moveLayer",
              layerId: LAYER_ID,
              index: 1,
            },
          ],
        },
      }),
    );
    expect(preview).toMatchObject({
      expectedRevision: summary.revision,
      operations: [
        {
          type: "moveLayer",
          layerId: LAYER_ID,
          destructive: false,
          layer: {
            id: LAYER_ID,
            type: "tilelayer",
            name: "Ground",
          },
          sourceParentGroupId: null,
          sourceIndex: 0,
          targetParentGroupId: null,
          targetIndex: 1,
          subtreeLayerCount: 1,
          descendantLayerCount: 0,
          layerIdSample: [LAYER_ID],
          omittedLayerCount: 0,
          wouldChange: true,
          renderOrderMayChange: true,
          renderContextMayChange: false,
          affectsDescendants: false,
          warning: expect.stringContaining(
            "rendering order",
          ),
        },
      ],
      summary: {
        affectedLayerIds: [LAYER_ID],
        movedLayers: [
          {
            operationIndex: 0,
            layerId: LAYER_ID,
            sourceParentGroupId: null,
            sourceIndex: 0,
            targetParentGroupId: null,
            targetIndex: 1,
            wouldChange: true,
          },
        ],
      },
    });
    expect(await readFile(absoluteMapPath)).toEqual(before);

    const applied = resultOf<{
      changed: boolean;
      revision: string;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision: preview.expectedRevision,
        },
      }),
    );
    expect(applied).toMatchObject({
      changed: true,
      revision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
    });
    const saved = JSON.parse(
      await readFile(absoluteMapPath, "utf8"),
    ) as JsonObject;
    expect(
      (saved.layers as JsonObject[]).map(
        (layer) => layer.id,
      ),
    ).toEqual([OBJECT_LAYER_ID, LAYER_ID]);
    expect(saved.nextlayerid).toBe(9);
    expect(saved.nextobjectid).toBe(3);
  });

  it("rejects invalid duplicate-layer wire shapes before planning", async () => {
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const invalidOperations: unknown[] = [
      {
        type: "duplicateLayer",
        layerId: 0,
      },
      {
        type: "duplicateLayer",
        layerId: LAYER_ID,
        destination: null,
      },
      {
        type: "duplicateLayer",
        layerId: LAYER_ID,
        destination: {
          kind: "sameParent",
          parentGroupId: 3,
        },
      },
      {
        type: "duplicateLayer",
        layerId: LAYER_ID,
        destination: {
          kind: "root",
          index: -1,
        },
      },
      {
        type: "duplicateLayer",
        layerId: LAYER_ID,
        destination: {
          kind: "root",
          index: 10_001,
        },
      },
      {
        type: "duplicateLayer",
        layerId: LAYER_ID,
        destination: {
          kind: "group",
        },
      },
      {
        type: "duplicateLayer",
        layerId: LAYER_ID,
        destination: {
          kind: "group",
          parentGroupId: 0,
        },
      },
      {
        type: "duplicateLayer",
        layerId: LAYER_ID,
        destination: {
          kind: "elsewhere",
        },
      },
      {
        type: "duplicateLayer",
        layerId: LAYER_ID,
        name: "x".repeat(1_025),
      },
      {
        type: "duplicateLayer",
        layerId: LAYER_ID,
        unexpected: true,
      },
    ];
    for (const operation of invalidOperations) {
      const rejected = asToolResponse(
        await harness.client.callTool({
          name: "tiled_preview_edits",
          arguments: {
            mapPath: MAP_PATH,
            expectedRevision: summary.revision,
            expectedDependencyRevisions:
              summary.dependencyRevisions,
            operations: [operation],
          },
        }),
      );
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toBeUndefined();
      expect(rejected.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(
            "Input validation error",
          ),
        }),
      ]);
    }
  });

  it("rejects invalid flood-fill wire shapes before planning", async () => {
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const invalidOperations: unknown[] = [
      {
        type: "floodFill",
        layerId: 0,
        x: 0,
        y: 0,
        tile: null,
      },
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: Number.MAX_SAFE_INTEGER + 1,
        y: 0,
        tile: null,
      },
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: 0,
        y: Number.MIN_SAFE_INTEGER - 1,
        tile: null,
      },
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
      },
      {
        type: "floodFill",
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        tile: null,
        connectivity: "four-way",
      },
    ];
    for (const operation of invalidOperations) {
      const rejected = asToolResponse(
        await harness.client.callTool({
          name: "tiled_preview_edits",
          arguments: {
            mapPath: MAP_PATH,
            expectedRevision: summary.revision,
            expectedDependencyRevisions:
              summary.dependencyRevisions,
            operations: [operation],
          },
        }),
      );
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toBeUndefined();
      expect(rejected.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(
            "Input validation error",
          ),
        }),
      ]);
    }
  });

  it("rejects invalid copy-region wire shapes before planning", async () => {
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const source = {
      layerId: LAYER_ID,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    };
    const destination = {
      layerId: LAYER_ID,
      x: 1,
      y: 1,
    };
    const invalidOperations: unknown[] = [
      {
        type: "copyRegion",
        source,
        destination,
        unexpected: true,
      },
      {
        type: "copyRegion",
        source: { ...source, unexpected: true },
        destination,
      },
      {
        type: "copyRegion",
        source,
        destination: {
          ...destination,
          unexpected: true,
        },
      },
      {
        type: "copyRegion",
        source: { ...source, layerId: 0 },
        destination,
      },
      {
        type: "copyRegion",
        source,
        destination: { ...destination, layerId: 0 },
      },
      {
        type: "copyRegion",
        source: {
          ...source,
          x: Number.MAX_SAFE_INTEGER + 1,
        },
        destination,
      },
      {
        type: "copyRegion",
        source: {
          ...source,
          y: Number.MIN_SAFE_INTEGER - 1,
        },
        destination,
      },
      {
        type: "copyRegion",
        source,
        destination: {
          ...destination,
          x: Number.MAX_SAFE_INTEGER + 1,
        },
      },
      {
        type: "copyRegion",
        source,
        destination: {
          ...destination,
          y: Number.MIN_SAFE_INTEGER - 1,
        },
      },
      {
        type: "copyRegion",
        source: { ...source, width: 0 },
        destination,
      },
      {
        type: "copyRegion",
        source: { ...source, height: -1 },
        destination,
      },
      {
        type: "copyRegion",
        source: { ...source, width: 1.5 },
        destination,
      },
      {
        type: "copyRegion",
        source: {
          ...source,
          height: Number.MAX_SAFE_INTEGER + 1,
        },
        destination,
      },
      {
        type: "copyRegion",
        source: {
          layerId: LAYER_ID,
          x: 0,
          y: 0,
          height: 1,
        },
        destination,
      },
      {
        type: "copyRegion",
        source,
        destination: {
          layerId: LAYER_ID,
          x: 1,
        },
      },
    ];
    for (const operation of invalidOperations) {
      const rejected = asToolResponse(
        await harness.client.callTool({
          name: "tiled_preview_edits",
          arguments: {
            mapPath: MAP_PATH,
            expectedRevision: summary.revision,
            expectedDependencyRevisions:
              summary.dependencyRevisions,
            operations: [operation],
          },
        }),
      );
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toBeUndefined();
      expect(rejected.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(
            "Input validation error",
          ),
        }),
      ]);
    }
  });

  it("previews and applies a mixed-batch snapshot copy with the frozen MCP shape", async () => {
    const absoluteMapPath = join(
      harness.root,
      MAP_PATH,
    );
    const map = baseMap();
    map.width = 4;
    map.height = 1;
    const tileLayer = (
      map.layers as JsonObject[]
    )[0];
    if (tileLayer === undefined) {
      throw new Error(
        "Expected the fixture tile layer.",
      );
    }
    tileLayer.width = 4;
    tileLayer.height = 1;
    tileLayer.data = [
      0x8000_0001,
      0,
      2,
      0,
    ];
    await writeFile(
      absoluteMapPath,
      serializeJsonDocument(map),
    );

    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const operation = {
      type: "copyRegion",
      source: {
        layerId: LAYER_ID,
        x: 0,
        y: 0,
        width: 3,
        height: 1,
      },
      destination: {
        layerId: LAYER_ID,
        x: 1,
        y: 0,
      },
    } as const;

    const mixedPreview = resultOf<{
      operations: Array<{ type: string }>;
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: summary.revision,
          expectedDependencyRevisions:
            summary.dependencyRevisions,
          operations: [
            operation,
            {
              type: "setTiles",
              layerId: LAYER_ID,
              cells: [{ x: 0, y: 0, tile: null }],
            },
          ],
        },
      }),
    );
    expect(
      mixedPreview.operations.map(
        ({ type }) => type,
      ),
    ).toEqual(["copyRegion", "setTiles"]);

    const before = await readFile(absoluteMapPath);
    const preview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
      operations: Array<Record<string, unknown>>;
      summary: {
        operationCount: number;
        cellWrites: number;
        tileCopies: Array<Record<string, unknown>>;
      };
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: summary.revision,
          expectedDependencyRevisions:
            summary.dependencyRevisions,
          operations: [operation],
        },
      }),
    );
    const normalizedSource = {
      layerId: LAYER_ID,
      x: 0,
      y: 0,
      width: 3,
      height: 1,
    };
    const normalizedDestination = {
      layerId: LAYER_ID,
      x: 1,
      y: 0,
      width: 3,
      height: 1,
    };
    expect(preview.operations).toEqual([
      {
        type: "copyRegion",
        destructive: true,
        warning: expect.any(String),
        source: normalizedSource,
        destination: normalizedDestination,
        scannedCellCount: 6,
        cellCount: 3,
        sourceNonEmptyCellCount: 2,
        changedCellCount: 3,
        overwrittenNonEmptyCellCount: 1,
        clearedCellCount: 1,
        overlapsSource: true,
        wouldChange: true,
      },
    ]);
    expect(preview.summary).toMatchObject({
      operationCount: 1,
      cellWrites: 3,
      tileCopies: [
        {
          operationIndex: 0,
          source: normalizedSource,
          destination: normalizedDestination,
          scannedCellCount: 6,
          cellCount: 3,
          sourceNonEmptyCellCount: 2,
          changedCellCount: 3,
          overwrittenNonEmptyCellCount: 1,
          clearedCellCount: 1,
          overlapsSource: true,
          wouldChange: true,
        },
      ],
    });
    expect(preview.operations[0]).not.toHaveProperty(
      "operationIndex",
    );
    expect(await readFile(absoluteMapPath)).toEqual(
      before,
    );

    const applied = resultOf<{
      changed: boolean;
      checkpointId: string;
      revision: string;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision: preview.expectedRevision,
        },
      }),
    );
    expect(applied).toMatchObject({
      changed: true,
      checkpointId: expect.stringMatching(
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
      ),
      revision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
    });
    const saved = JSON.parse(
      await readFile(absoluteMapPath, "utf8"),
    ) as JsonObject;
    expect(
      ((saved.layers as JsonObject[])[0]
        ?.data as number[]),
    ).toEqual([
      0x8000_0001,
      0x8000_0001,
      0,
      2,
    ]);
  });

  it("previews and applies exact tile replacements through the generic edit batch", async () => {
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
      tilesets: Array<{ assetId: string }>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const assetId = summary.tilesets[0]?.assetId;
    if (assetId === undefined) {
      throw new Error("Expected the fixture tileset binding.");
    }
    const from = {
      tileset: { kind: "external" as const, assetId },
      localId: 0,
    };
    const to = {
      tileset: { kind: "external" as const, assetId },
      localId: 1,
    };

    for (const mappings of [
      [{ from: null, to }],
      [{ from, to, unexpected: true }],
    ]) {
      const rejected = asToolResponse(
        await harness.client.callTool({
          name: "tiled_preview_edits",
          arguments: {
            mapPath: MAP_PATH,
            expectedRevision: summary.revision,
            expectedDependencyRevisions:
              summary.dependencyRevisions,
            operations: [
              {
                type: "replaceTiles",
                layerId: LAYER_ID,
                mappings,
              },
            ],
          },
        }),
      );
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toBeUndefined();
      expect(rejected.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Input validation error"),
        }),
      ]);
    }

    const before = await readFile(join(harness.root, MAP_PATH));
    const preview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
      operations: Array<Record<string, unknown>>;
      summary: {
        operationCount: number;
        cellWrites: number;
        tileReplacements: Array<Record<string, unknown>>;
      };
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: summary.revision,
          expectedDependencyRevisions:
            summary.dependencyRevisions,
          operations: [
            {
              type: "replaceTiles",
              layerId: LAYER_ID,
              mappings: [{ from, to }],
            },
          ],
        },
      }),
    );

    expect(preview).toMatchObject({
      changeSetId: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      expectedRevision: summary.revision,
      operations: [
        {
          type: "replaceTiles",
          layerId: LAYER_ID,
          destructive: true,
          region: { x: 0, y: 0, width: 2, height: 2 },
          scannedCellCount: 4,
          replacedCellCount: 1,
          mappingCount: 1,
          mappingSample: [{ from, to }],
          omittedMappingCount: 0,
        },
      ],
      summary: {
        operationCount: 1,
        cellWrites: 1,
        tileReplacements: [
          {
            operationIndex: 0,
            layerId: LAYER_ID,
            region: { x: 0, y: 0, width: 2, height: 2 },
            scannedCellCount: 4,
            replacedCellCount: 1,
            mappingCount: 1,
          },
        ],
      },
    });
    expect(await readFile(join(harness.root, MAP_PATH))).toEqual(
      before,
    );

    const applied = resultOf<{
      changed: boolean;
      checkpointId: string;
      revision: string;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision: preview.expectedRevision,
        },
      }),
    );
    expect(applied).toMatchObject({
      changed: true,
      checkpointId: expect.stringMatching(
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
      ),
      revision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
    });
    const saved = JSON.parse(
      await readFile(join(harness.root, MAP_PATH), "utf8"),
    ) as JsonObject;
    expect(
      ((saved.layers as JsonObject[])[0]?.data as number[]),
    ).toEqual([2, 0, 0, 0]);
  });

  it("keeps tileset attachment out of the generic edit batch", async () => {
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: summary.revision,
          expectedDependencyRevisions: summary.dependencyRevisions,
          operations: [
            {
              type: "addTilesetToMap",
              tilesetPath: TILESET_PATH,
            },
          ],
        },
      }),
    );
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    expect(response.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Input validation error"),
      }),
    ]);
  });

  it("previews and applies one external tileset reference without writing the TSJ", async () => {
    const created = resultOf<{ revision: string }>(
      await harness.client.callTool({
        name: "tiled_create_map",
        arguments: {
          mapPath: "maps/attach.tmj",
          width: 2,
          height: 2,
          tileWidth: 16,
          tileHeight: 16,
        },
      }),
    );
    const targetBytesBefore = await readFile(
      join(harness.root, TILESET_PATH),
    );
    const emptyMapPath = join(harness.root, "maps/attach.tmj");
    const mapBytesBefore = await readFile(emptyMapPath);
    const emptySummary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
      tilesets: unknown[];
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: "maps/attach.tmj" },
      }),
    );
    const referencedSummary = resultOf<{
      tilesets: Array<{ assetId: string; revision: string }>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const target = referencedSummary.tilesets[0];
    expect(target).toBeDefined();
    if (target === undefined) {
      throw new Error("Expected the fixture tileset binding.");
    }

    const preview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
      dependencyRevisions: Record<string, string>;
      prospectiveDependencyRevisions: Record<string, string>;
      operations: Array<Record<string, unknown>>;
      summary: {
        operationCount: number;
        cellWrites: number;
        addedTilesets: Array<Record<string, unknown>>;
      };
    }>(
      await harness.client.callTool({
        name: "tiled_add_tileset_to_map",
        arguments: {
          mapPath: "maps/attach.tmj",
          tilesetPath: TILESET_PATH,
          expectedMapRevision: created.revision,
          expectedDependencyRevisions:
            emptySummary.dependencyRevisions,
          expectedTilesetRevision: target.revision,
        },
      }),
    );
    expect(preview).toMatchObject({
      changeSetId: expect.stringMatching(/^changeset:[0-9a-f]{64}$/u),
      expectedRevision: emptySummary.revision,
      dependencyRevisions: {},
      prospectiveDependencyRevisions: {
        [target.assetId]: target.revision,
      },
      operations: [
        {
          type: "addTilesetToMap",
          destructive: false,
          source: "../tiles/terrain.tsj",
          assignedFirstGid: 1,
          gidRange: { first: 1, last: 4 },
          tileset: {
            kind: "external",
            assetId: target.assetId,
            path: TILESET_PATH,
            revision: target.revision,
            tileCount: 4,
          },
        },
      ],
      summary: {
        operationCount: 1,
        cellWrites: 0,
        addedTilesets: [
          {
            tilesetPath: TILESET_PATH,
            source: "../tiles/terrain.tsj",
            assetId: target.assetId,
            tilesetRevision: target.revision,
            tileCount: 4,
            firstGid: 1,
          },
        ],
      },
    });
    expect(await readFile(emptyMapPath)).toEqual(mapBytesBefore);
    expect(await readFile(join(harness.root, TILESET_PATH))).toEqual(
      targetBytesBefore,
    );

    const applied = resultOf<{
      changeSetId: string;
      revision: string;
      changed: boolean;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision: preview.expectedRevision,
        },
      }),
    );
    expect(applied).toMatchObject({
      changeSetId: preview.changeSetId,
      changed: true,
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(await readFile(join(harness.root, TILESET_PATH))).toEqual(
      targetBytesBefore,
    );

    const attached = resultOf<{
      dependencyRevisions: Record<string, string>;
      tilesets: Array<{
        assetId: string;
        path: string;
        firstGid: number;
        tileCount: number;
        revision: string;
      }>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: "maps/attach.tmj" },
      }),
    );
    expect(attached).toMatchObject({
      dependencyRevisions: {
        [target.assetId]: target.revision,
      },
      tilesets: [
        {
          assetId: target.assetId,
          path: TILESET_PATH,
          firstGid: 1,
          tileCount: 4,
          revision: target.revision,
        },
      ],
    });
  });

  it("strictly previews and applies removal of one unused external tileset through the generic edit batch", async () => {
    const used = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
      tilesets: Array<{
        assetId: string;
        revision: string;
      }>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const target = used.tilesets[0];
    if (target === undefined) {
      throw new Error("Expected the fixture tileset binding.");
    }
    const stillUsed = asToolResponse(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: used.revision,
          expectedDependencyRevisions:
            used.dependencyRevisions,
          operations: [
            {
              type: "removeTilesetFromMap",
              tilesetAssetId: target.assetId,
            },
          ],
        },
      }),
    );
    expect(stillUsed.isError).toBe(true);
    expect(stillUsed.structuredContent).toMatchObject({
      result: {
        ok: false,
        error: {
          code: "TILESET_IN_USE",
          details: {
            tilesetAssetId: target.assetId,
            cellReferenceCount: 1,
            objectReferenceCount: 0,
          },
        },
      },
    });

    const unusedMap = baseMap();
    const tileLayer = (unusedMap.layers as JsonObject[])[0];
    if (tileLayer === undefined) {
      throw new Error("Expected the fixture tile layer.");
    }
    tileLayer.data = [0, 0, 0, 0];
    unusedMap.layers = [tileLayer];
    await writeJson(join(harness.root, MAP_PATH), unusedMap);
    const tilesetBytesBefore = await readFile(
      join(harness.root, TILESET_PATH),
    );

    const attached = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
      tilesets: Array<{
        assetId: string;
        path: string;
        firstGid: number;
        tileCount: number;
        revision: string;
      }>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    expect(attached).toMatchObject({
      dependencyRevisions: {
        [target.assetId]: target.revision,
      },
      tilesets: [
        {
          assetId: target.assetId,
          path: TILESET_PATH,
          firstGid: 1,
          tileCount: 4,
          revision: target.revision,
        },
      ],
    });

    const invalidOperations: unknown[] = [
      { type: "removeTilesetFromMap" },
      {
        type: "removeTilesetFromMap",
        tilesetAssetId: "",
      },
      {
        type: "removeTilesetFromMap",
        tilesetAssetId: "not-an-asset-id",
      },
      {
        type: "removeTilesetFromMap",
        tilesetAssetId: target.assetId,
        unexpected: true,
      },
      {
        type: "removeTilesetFromMap",
        tilesetPath: TILESET_PATH,
      },
    ];
    for (const operation of invalidOperations) {
      const rejected = asToolResponse(
        await harness.client.callTool({
          name: "tiled_preview_edits",
          arguments: {
            mapPath: MAP_PATH,
            expectedRevision: attached.revision,
            expectedDependencyRevisions:
              attached.dependencyRevisions,
            operations: [operation],
          },
        }),
      );
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toBeUndefined();
      expect(rejected.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(
            "Input validation error",
          ),
        }),
      ]);
    }

    const mixed = asToolResponse(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: attached.revision,
          expectedDependencyRevisions:
            attached.dependencyRevisions,
          operations: [
            {
              type: "removeTilesetFromMap",
              tilesetAssetId: target.assetId,
            },
            {
              type: "updateMap",
              patch: { className: "MustNotApply" },
            },
          ],
        },
      }),
    );
    expect(mixed.isError).toBe(true);
    expect(mixed.structuredContent).toMatchObject({
      result: {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
        },
      },
    });
    expect(mixed.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining(
          "removeTilesetFromMap",
        ),
      }),
    ]);

    const mapBytesBeforePreview = await readFile(
      join(harness.root, MAP_PATH),
    );
    const preview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
      dependencyRevisions: Record<string, string>;
      operations: Array<Record<string, unknown>>;
      summary: {
        operationCount: number;
        cellWrites: number;
        removedTilesets: Array<Record<string, unknown>>;
      };
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: attached.revision,
          expectedDependencyRevisions:
            attached.dependencyRevisions,
          operations: [
            {
              type: "removeTilesetFromMap",
              tilesetAssetId: target.assetId,
            },
          ],
        },
      }),
    );
    expect(preview).toMatchObject({
      changeSetId: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      expectedRevision: attached.revision,
      dependencyRevisions: {
        [target.assetId]: target.revision,
      },
      operations: [
        {
          type: "removeTilesetFromMap",
          destructive: true,
          warning: expect.any(String),
          tileset: {
            kind: "external",
            assetId: target.assetId,
            path: TILESET_PATH,
            revision: target.revision,
            name: "Terrain",
            tileCount: 4,
            gidSpan: 4,
          },
          source: "../tiles/terrain.tsj",
          index: 0,
          gidRange: { first: 1, last: 4 },
          scanned: {
            tileCells: 4,
            objects: 0,
          },
        },
      ],
      summary: {
        operationCount: 1,
        cellWrites: 0,
        removedTilesets: [
          {
            operationIndex: 0,
            assetId: target.assetId,
            tilesetPath: TILESET_PATH,
            source: "../tiles/terrain.tsj",
            tilesetRevision: target.revision,
            name: "Terrain",
            nameTruncated: false,
            index: 0,
            tileCount: 4,
            gidSpan: 4,
            firstGid: 1,
            lastGid: 4,
            scannedCellCount: 4,
            scannedObjectCount: 0,
          },
        ],
      },
    });
    expect(
      await readFile(join(harness.root, MAP_PATH)),
    ).toEqual(mapBytesBeforePreview);

    const applied = resultOf<{
      changeSetId: string;
      changed: boolean;
      checkpointId: string;
      revision: string;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision: preview.expectedRevision,
        },
      }),
    );
    expect(applied).toMatchObject({
      changeSetId: preview.changeSetId,
      changed: true,
      checkpointId: expect.stringMatching(
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
      ),
      revision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
    });
    expect(await readFile(join(harness.root, TILESET_PATH))).toEqual(
      tilesetBytesBefore,
    );

    const removed = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
      tilesets: unknown[];
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    expect(removed).toMatchObject({
      revision: applied.revision,
      dependencyRevisions: {},
      tilesets: [],
    });
    const saved = JSON.parse(
      await readFile(
        join(harness.root, MAP_PATH),
        "utf8",
      ),
    ) as JsonObject;
    expect(saved.tilesets).toEqual([]);
    expect(saved.class).toBeUndefined();
  });

  it("previews and applies one empty layer through the dedicated tool", async () => {
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const before = await readFile(absoluteMapPath);
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );

    const preview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
      operations: Array<Record<string, unknown>>;
      summary: {
        operationCount: number;
        cellWrites: number;
        affectedLayerIds: number[];
        createdLayers: Array<Record<string, unknown>>;
      };
    }>(
      await harness.client.callTool({
        name: "tiled_create_layer",
        arguments: {
          mapPath: MAP_PATH,
          type: "tilelayer",
          name: "Collision",
          index: 1,
          expectedMapRevision: summary.revision,
          expectedDependencyRevisions:
            summary.dependencyRevisions,
        },
      }),
    );

    expect(preview).toMatchObject({
      expectedRevision: summary.revision,
      snapshotConsistency: "non-atomic-read-set",
      operations: [
        {
          type: "createLayer",
          destructive: false,
          layer: {
            id: 9,
            type: "tilelayer",
            name: "Collision",
          },
          parentGroupId: null,
          index: 1,
          allocatedCellCount: 4,
        },
      ],
      summary: {
        operationCount: 1,
        cellWrites: 4,
        affectedLayerIds: [9],
        createdLayers: [
          {
            layerId: 9,
            layerType: "tilelayer",
            name: "Collision",
            parentGroupId: null,
            index: 1,
            allocatedCellCount: 4,
          },
        ],
      },
    });
    expect(await readFile(absoluteMapPath)).toEqual(before);

    const applied = resultOf<{
      revision: string;
      changed: boolean;
      checkpointId: string;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision: preview.expectedRevision,
        },
      }),
    );
    expect(applied).toMatchObject({
      changed: true,
      checkpointId: expect.any(String),
      revision: expect.stringMatching(/^sha256:/u),
    });

    const saved = JSON.parse(
      await readFile(absoluteMapPath, "utf8"),
    ) as JsonObject;
    expect(saved.nextlayerid).toBe(10);
    expect((saved.layers as JsonObject[])[1]).toEqual({
      data: [0, 0, 0, 0],
      height: 2,
      id: 9,
      name: "Collision",
      opacity: 1,
      type: "tilelayer",
      visible: true,
      width: 2,
      x: 0,
      y: 0,
    });

    const imagePreview = resultOf<{
      prospectiveDependencyRevisions: Record<string, string>;
      operations: Array<{
        type: string;
        image: {
          assetId: string;
          path: string;
          source: string;
          revision: string;
          width: number;
          height: number;
        };
      }>;
    }>(
      await harness.client.callTool({
        name: "tiled_create_layer",
        arguments: {
          mapPath: MAP_PATH,
          type: "imagelayer",
          name: "Backdrop",
          imagePath: "tiles/terrain.png",
          expectedMapRevision: applied.revision,
          expectedDependencyRevisions:
            summary.dependencyRevisions,
        },
      }),
    );
    expect(imagePreview.operations[0]).toMatchObject({
      type: "createLayer",
      image: {
        assetId: expect.stringMatching(/^asset_/u),
        path: "tiles/terrain.png",
        source: "../tiles/terrain.png",
        revision: expect.stringMatching(/^sha256:/u),
        width: 32,
        height: 32,
      },
    });
    const imageAssetId =
      imagePreview.operations[0]?.image.assetId ?? "";
    expect(imagePreview.prospectiveDependencyRevisions).toEqual({
      [imageAssetId]:
        imagePreview.operations[0]?.image.revision,
    });

    for (const argumentsValue of [
      {
        mapPath: MAP_PATH,
        type: "group",
        name: "Invalid image field",
        imagePath: "tiles/terrain.png",
        expectedMapRevision: applied.revision,
        expectedDependencyRevisions:
          summary.dependencyRevisions,
      },
      {
        mapPath: MAP_PATH,
        type: "imagelayer",
        name: "Missing image",
        expectedMapRevision: applied.revision,
        expectedDependencyRevisions:
          summary.dependencyRevisions,
      },
      {
        mapPath: MAP_PATH,
        type: "group",
        name: "Invalid image revision",
        expectedImageRevision:
          imagePreview.operations[0]?.image.revision,
        expectedMapRevision: applied.revision,
        expectedDependencyRevisions:
          summary.dependencyRevisions,
      },
    ]) {
      const invalid = asToolResponse(
        await harness.client.callTool({
          name: "tiled_create_layer",
          arguments: argumentsValue,
        }),
      );
      expect(invalid.isError).toBe(true);
      expect(invalid.content[0]?.text).toContain(
        "Input validation error",
      );
    }
  });

  it("previews without writing, then applies once and replays the cached result", async () => {
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const before = await readFile(absoluteMapPath);
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
      tilesets: Array<{ assetId: string }>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const assetId = summary.tilesets[0]?.assetId;
    expect(assetId).toBeDefined();

    const preview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
      summary: { operationCount: number; cellWrites: number };
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: summary.revision,
          expectedDependencyRevisions: summary.dependencyRevisions,
          operations: [
            {
              type: "setTiles",
              layerId: LAYER_ID,
              cells: [
                {
                  x: 1,
                  y: 0,
                  tile: {
                    tileset: {
                      kind: "external",
                      assetId,
                    },
                    localId: 1,
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(preview).toMatchObject({
      changeSetId: expect.stringMatching(/^changeset:[0-9a-f]{64}$/u),
      expectedRevision: summary.revision,
      summary: { operationCount: 1, cellWrites: 1 },
    });
    expect(await readFile(absoluteMapPath)).toEqual(before);

    const firstApply = await harness.client.callTool({
      name: "tiled_apply_change_set",
      arguments: {
        changeSetId: preview.changeSetId,
        expectedRevision: preview.expectedRevision,
      },
    });
    const firstResult = resultOf<{
      changeSetId: string;
      changed: boolean;
      revision: string;
    }>(firstApply);
    expect(firstResult).toMatchObject({
      changeSetId: preview.changeSetId,
      changed: true,
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(await readFile(absoluteMapPath)).not.toEqual(before);

    const secondApply = await harness.client.callTool({
      name: "tiled_apply_change_set",
      arguments: {
        changeSetId: preview.changeSetId,
        expectedRevision: preview.expectedRevision,
      },
    });
    expect(secondApply).toEqual(firstApply);

    await writeFile(absoluteMapPath, before);
    const replayPreview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: summary.revision,
          expectedDependencyRevisions: summary.dependencyRevisions,
          operations: [
            {
              type: "setTiles",
              layerId: LAYER_ID,
              cells: [
                {
                  x: 1,
                  y: 0,
                  tile: {
                    tileset: { kind: "external", assetId },
                    localId: 1,
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(replayPreview.changeSetId).not.toBe(preview.changeSetId);
    const replayApply = resultOf<{ changed: boolean }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: replayPreview.changeSetId,
          expectedRevision: replayPreview.expectedRevision,
        },
      }),
    );
    expect(replayApply.changed).toBe(true);

    const saved = JSON.parse(await readFile(absoluteMapPath, "utf8")) as JsonObject;
    const layer = (saved.layers as JsonObject[])[0];
    expect(layer?.data).toEqual([1, 2, 0, 0]);
  });

  it("previews, applies and idempotently replays an exact checkpoint restore", async () => {
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const originalBytes = await readFile(absoluteMapPath);
    const original = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
      tilesets: Array<{ assetId: string }>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const assetId = original.tilesets[0]?.assetId;
    if (assetId === undefined) {
      throw new Error("Expected the fixture tileset binding.");
    }

    const editPreview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: original.revision,
          expectedDependencyRevisions:
            original.dependencyRevisions,
          operations: [
            {
              type: "setTiles",
              layerId: LAYER_ID,
              cells: [
                {
                  x: 1,
                  y: 0,
                  tile: {
                    tileset: { kind: "external", assetId },
                    localId: 1,
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    const editApplied = resultOf<{
      revision: string;
      checkpointId: string;
      changed: boolean;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: editPreview.changeSetId,
          expectedRevision: editPreview.expectedRevision,
        },
      }),
    );
    expect(editApplied).toMatchObject({
      changed: true,
      checkpointId: expect.stringMatching(
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
      ),
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    const editedBytes = await readFile(absoluteMapPath);
    expect(editedBytes).not.toEqual(originalBytes);

    const restorePreview = resultOf<{
      kind: string;
      changeSetId: string;
      planDigest: string;
      targetPath: string;
      expectedRevision: string;
      checkpoint: {
        id: string;
        status: string;
        afterRevision: string;
      };
      restore: {
        revision: string;
        size: number;
        exactBytes: boolean;
        wouldChange: boolean;
      };
      operations: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
      snapshotConsistency: string;
    }>(
      await harness.client.callTool({
        name: "tiled_preview_checkpoint_restore",
        arguments: {
          checkpointId: editApplied.checkpointId,
          expectedRevision: editApplied.revision,
        },
      }),
    );
    expect(restorePreview).toMatchObject({
      kind: "checkpointRestore",
      changeSetId: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      planDigest: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      targetPath: MAP_PATH,
      expectedRevision: editApplied.revision,
      checkpoint: {
        id: editApplied.checkpointId,
        status: "committed",
        afterRevision: editApplied.revision,
      },
      restore: {
        revision: original.revision,
        size: originalBytes.byteLength,
        exactBytes: true,
        wouldChange: true,
      },
      operations: [
        {
          type: "restoreCheckpoint",
          destructive: true,
          checkpointId: editApplied.checkpointId,
          targetPath: MAP_PATH,
          currentRevision: editApplied.revision,
          restoreRevision: original.revision,
          restoreBytes: originalBytes.byteLength,
          exactBytes: true,
          wouldChange: true,
          warning: expect.stringContaining("exact pre-write bytes"),
        },
      ],
      summary: {
        operationCount: 1,
        destructive: true,
        checkpointId: editApplied.checkpointId,
        targetPath: MAP_PATH,
        currentRevision: editApplied.revision,
        restoreRevision: original.revision,
        restoreBytes: originalBytes.byteLength,
        wouldChange: true,
        warning: expect.stringContaining("exact pre-write bytes"),
      },
      snapshotConsistency: "non-atomic-read-set",
    });
    expect(await readFile(absoluteMapPath)).toEqual(editedBytes);

    const firstRestoreApply = await harness.client.callTool({
      name: "tiled_apply_change_set",
      arguments: {
        changeSetId: restorePreview.changeSetId,
        expectedRevision: restorePreview.expectedRevision,
      },
    });
    const firstRestoreResult = resultOf<{
      path: string;
      beforeRevision: string;
      revision: string;
      checkpointId: string;
      changed: boolean;
      changeSetId: string;
    }>(firstRestoreApply);
    expect(firstRestoreResult).toMatchObject({
      path: MAP_PATH,
      beforeRevision: editApplied.revision,
      revision: original.revision,
      checkpointId: expect.stringMatching(
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
      ),
      changed: true,
      changeSetId: restorePreview.changeSetId,
    });

    const secondRestoreApply = await harness.client.callTool({
      name: "tiled_apply_change_set",
      arguments: {
        changeSetId: restorePreview.changeSetId,
        expectedRevision: restorePreview.expectedRevision,
      },
    });
    expect(secondRestoreApply).toEqual(firstRestoreApply);
    expect(await readFile(absoluteMapPath)).toEqual(originalBytes);

    const restored = resultOf<{
      revision: string;
      layers: Array<{ id: number }>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    expect(restored).toMatchObject({
      revision: original.revision,
      layers: [
        { id: LAYER_ID },
        { id: OBJECT_LAYER_ID },
      ],
    });
  });

  it("lists, previews and applies create, update and destructive delete object edits", async () => {
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const before = await readFile(absoluteMapPath);
    const initial = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
      total: number;
      objects: Array<{ id: number }>;
    }>(
      await harness.client.callTool({
        name: "tiled_list_objects",
        arguments: { mapPath: MAP_PATH, layerId: OBJECT_LAYER_ID },
      }),
    );
    expect(initial).toMatchObject({
      total: 2,
      objects: [{ id: RECTANGLE_OBJECT_ID }, { id: POINT_OBJECT_ID }],
    });

    const preview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
      operations: Array<Record<string, unknown>>;
      summary: {
        cellWrites: number;
        affectedObjectLayerIds: number[];
        createdObjectIds: number[];
        updatedObjectIds: number[];
        deletedObjectIds: number[];
      };
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: initial.revision,
          expectedDependencyRevisions: initial.dependencyRevisions,
          operations: [
            {
              type: "createObject",
              layerId: OBJECT_LAYER_ID,
              object: {
                shape: "rectangle",
                x: 20,
                y: 30,
                width: 12,
                height: 8,
                name: "Sign",
                className: "Decoration",
                rotation: 15,
                visible: false,
                opacity: 0.75,
              },
            },
            {
              type: "updateObject",
              objectId: RECTANGLE_OBJECT_ID,
              patch: {
                x: 6,
                width: 10,
                height: 11,
                name: "Moved crate",
                className: "Obstacle",
                rotation: 45,
                visible: false,
                opacity: 0.5,
              },
            },
            {
              type: "deleteObjects",
              objectIds: [POINT_OBJECT_ID],
            },
          ],
        },
      }),
    );
    expect(preview).toMatchObject({
      changeSetId: expect.stringMatching(/^changeset:[0-9a-f]{64}$/u),
      expectedRevision: initial.revision,
      operations: [
        {
          type: "createObject",
          layerId: OBJECT_LAYER_ID,
          shape: "rectangle",
          object: { name: "Sign", width: 12, height: 8 },
        },
        {
          type: "updateObject",
          objectId: RECTANGLE_OBJECT_ID,
          changedFields: [
            "className",
            "height",
            "name",
            "opacity",
            "rotation",
            "visible",
            "width",
            "x",
          ],
        },
        {
          type: "deleteObjects",
          destructive: true,
          objectCount: 1,
          objectIdSample: [POINT_OBJECT_ID],
          omittedObjectCount: 0,
          warning: expect.stringContaining("permanently removes"),
        },
      ],
      summary: {
        cellWrites: 0,
        affectedObjectLayerIds: [OBJECT_LAYER_ID],
        createdObjectIds: [3],
        updatedObjectIds: [RECTANGLE_OBJECT_ID],
        deletedObjectIds: [POINT_OBJECT_ID],
      },
    });
    expect(await readFile(absoluteMapPath)).toEqual(before);

    const applied = resultOf<{
      changeSetId: string;
      changed: boolean;
      revision: string;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision: preview.expectedRevision,
        },
      }),
    );
    expect(applied).toMatchObject({
      changeSetId: preview.changeSetId,
      changed: true,
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });

    const listed = resultOf<{
      revision: string;
      total: number;
      truncated: boolean;
      objects: Array<{
        id: number;
        shape: string;
        x: number;
        width?: number;
        name: string;
        className: string;
        rotation: number;
        visible: boolean;
        opacity: number;
      }>;
    }>(
      await harness.client.callTool({
        name: "tiled_list_objects",
        arguments: { mapPath: MAP_PATH, layerId: OBJECT_LAYER_ID },
      }),
    );
    expect(listed).toMatchObject({
      revision: applied.revision,
      total: 2,
      truncated: false,
      objects: [
        {
          id: RECTANGLE_OBJECT_ID,
          shape: "rectangle",
          x: 6,
          width: 10,
          name: "Moved crate",
          className: "Obstacle",
          rotation: 45,
          visible: false,
          opacity: 0.5,
        },
        {
          id: 3,
          shape: "rectangle",
          x: 20,
          width: 12,
          name: "Sign",
          className: "Decoration",
          rotation: 15,
          visible: false,
          opacity: 0.75,
        },
      ],
    });

    const saved = JSON.parse(await readFile(absoluteMapPath, "utf8")) as JsonObject;
    expect(saved.nextobjectid).toBe(4);
    const objectLayer = (saved.layers as JsonObject[]).find(
      (layer) => layer.id === OBJECT_LAYER_ID,
    );
    expect((objectLayer?.objects as JsonObject[]).map((object) => object.id)).toEqual([
      RECTANGLE_OBJECT_ID,
      3,
    ]);
  });

  it("creates, preserves, updates and deletes ellipse and capsule objects", async () => {
    const initial = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );

    const createPreview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
      operations: Array<Record<string, unknown>>;
      summary: {
        affectedObjectLayerIds: number[];
        createdObjectIds: number[];
      };
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: initial.revision,
          expectedDependencyRevisions: initial.dependencyRevisions,
          operations: [
            {
              type: "createObject",
              layerId: OBJECT_LAYER_ID,
              object: {
                shape: "ellipse",
                x: 20,
                y: 30,
                name: "Portal",
              },
            },
            {
              type: "createObject",
              layerId: OBJECT_LAYER_ID,
              object: {
                shape: "capsule",
                x: 40,
                y: 50,
                width: 18,
                height: 6,
                name: "Trigger",
              },
            },
          ],
        },
      }),
    );
    expect(createPreview).toMatchObject({
      expectedRevision: initial.revision,
      operations: [
        {
          type: "createObject",
          layerId: OBJECT_LAYER_ID,
          shape: "ellipse",
          object: {
            shape: "ellipse",
          },
        },
        {
          type: "createObject",
          layerId: OBJECT_LAYER_ID,
          shape: "capsule",
          object: {
            shape: "capsule",
            width: 18,
            height: 6,
          },
        },
      ],
      summary: {
        affectedObjectLayerIds: [OBJECT_LAYER_ID],
        createdObjectIds: [3, 4],
      },
    });

    const createApply = resultOf<{
      changed: boolean;
      revision: string;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: createPreview.changeSetId,
          expectedRevision: createPreview.expectedRevision,
        },
      }),
    );
    expect(createApply).toMatchObject({
      changed: true,
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });

    const absoluteMapPath = join(harness.root, MAP_PATH);
    const createdMap = JSON.parse(
      await readFile(absoluteMapPath, "utf8"),
    ) as JsonObject;
    const createdObjectLayer = (createdMap.layers as JsonObject[]).find(
      (layer) => layer.id === OBJECT_LAYER_ID,
    );
    const createdObjects = createdObjectLayer?.objects as JsonObject[];
    expect(createdObjects.find((object) => object.id === 3)).toMatchObject({
      id: 3,
      ellipse: true,
      width: 0,
      height: 0,
    });
    expect(createdObjects.find((object) => object.id === 3)).not.toHaveProperty(
      "capsule",
    );
    expect(createdObjects.find((object) => object.id === 4)).toMatchObject({
      id: 4,
      capsule: true,
      width: 18,
      height: 6,
    });
    expect(createdObjects.find((object) => object.id === 4)).not.toHaveProperty(
      "ellipse",
    );

    const afterCreate = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const updatePreview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
      operations: Array<Record<string, unknown>>;
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: afterCreate.revision,
          expectedDependencyRevisions: afterCreate.dependencyRevisions,
          operations: [
            {
              type: "updateObject",
              objectId: 3,
              patch: {
                width: 21,
                height: 13,
                name: "Wide portal",
              },
            },
            {
              type: "updateObject",
              objectId: 4,
              patch: {
                x: 44,
                width: 0,
                height: 0,
              },
            },
          ],
        },
      }),
    );
    expect(updatePreview.operations).toEqual([
      {
        type: "updateObject",
        objectId: 3,
        changedFields: ["height", "name", "width"],
        patch: {
          width: 21,
          height: 13,
          name: "Wide portal",
        },
      },
      {
        type: "updateObject",
        objectId: 4,
        changedFields: ["height", "width", "x"],
        patch: {
          x: 44,
          width: 0,
          height: 0,
        },
      },
    ]);

    const updateApply = resultOf<{
      changed: boolean;
      revision: string;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: updatePreview.changeSetId,
          expectedRevision: updatePreview.expectedRevision,
        },
      }),
    );
    expect(updateApply.changed).toBe(true);

    const listed = resultOf<{
      total: number;
      objects: Array<{
        id: number;
        shape: string;
        width: number;
        height: number;
      }>;
    }>(
      await harness.client.callTool({
        name: "tiled_list_objects",
        arguments: { mapPath: MAP_PATH, layerId: OBJECT_LAYER_ID },
      }),
    );
    expect(listed).toMatchObject({
      total: 4,
      objects: [
        { id: RECTANGLE_OBJECT_ID, shape: "rectangle" },
        { id: POINT_OBJECT_ID, shape: "point" },
        { id: 3, shape: "ellipse", width: 21, height: 13 },
        { id: 4, shape: "capsule", width: 0, height: 0 },
      ],
    });

    const updatedMap = JSON.parse(
      await readFile(absoluteMapPath, "utf8"),
    ) as JsonObject;
    const updatedObjectLayer = (updatedMap.layers as JsonObject[]).find(
      (layer) => layer.id === OBJECT_LAYER_ID,
    );
    const updatedObjects = updatedObjectLayer?.objects as JsonObject[];
    expect(updatedObjects.find((object) => object.id === 3)).toMatchObject({
      ellipse: true,
      width: 21,
      height: 13,
    });
    expect(updatedObjects.find((object) => object.id === 4)).toMatchObject({
      capsule: true,
      width: 0,
      height: 0,
    });

    const beforeDelete = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const deletePreview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
      operations: Array<Record<string, unknown>>;
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: beforeDelete.revision,
          expectedDependencyRevisions: beforeDelete.dependencyRevisions,
          operations: [
            {
              type: "deleteObjects",
              objectIds: [3, 4],
            },
          ],
        },
      }),
    );
    expect(deletePreview.operations).toEqual([
      expect.objectContaining({
        type: "deleteObjects",
        destructive: true,
        objectCount: 2,
        objectIdSample: [3, 4],
      }),
    ]);
    await harness.client.callTool({
      name: "tiled_apply_change_set",
      arguments: {
        changeSetId: deletePreview.changeSetId,
        expectedRevision: deletePreview.expectedRevision,
      },
    });

    const afterDelete = resultOf<{
      total: number;
      objects: Array<{ id: number }>;
    }>(
      await harness.client.callTool({
        name: "tiled_list_objects",
        arguments: { mapPath: MAP_PATH, layerId: OBJECT_LAYER_ID },
      }),
    );
    expect(afterDelete).toMatchObject({
      total: 2,
      objects: [
        { id: RECTANGLE_OBJECT_ID },
        { id: POINT_OBJECT_ID },
      ],
    });
  });

  it("rejects invalid object shapes, empty updates and duplicate deletion IDs in the strict schema", async () => {
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    for (const operation of [
      {
        type: "updateObject",
        objectId: RECTANGLE_OBJECT_ID,
        patch: {},
      },
      {
        type: "updateObject",
        objectId: RECTANGLE_OBJECT_ID,
        patch: { shape: "ellipse" },
      },
      {
        type: "deleteObjects",
        objectIds: [POINT_OBJECT_ID, POINT_OBJECT_ID],
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "ellipse",
          x: 1,
          y: 2,
          width: -1,
          height: 3,
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "capsule",
          x: 1,
          y: 2,
          width: 3,
          height: -1,
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "ellipse",
          x: 1,
          y: 2,
          width: 3,
          height: 1_000_000_001,
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "capsule",
          x: 1,
          y: 2,
          width: 3,
          height: 4,
          ellipse: true,
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "point",
          x: 1,
          y: 2,
          width: 3,
        },
      },
    ]) {
      const response = asToolResponse(
        await harness.client.callTool({
          name: "tiled_preview_edits",
          arguments: {
            mapPath: MAP_PATH,
            expectedRevision: summary.revision,
            expectedDependencyRevisions: summary.dependencyRevisions,
            operations: [operation],
          },
        }),
      );
      expect(response.isError).toBe(true);
      expect(response.structuredContent).toBeUndefined();
      expect(response.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Input validation error"),
      });
    }
  });

  it("requires preview to match the revision the caller actually inspected", async () => {
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
      tilesets: Array<{ assetId: string }>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const changed = JSON.parse(await readFile(absoluteMapPath, "utf8")) as JsonObject;
    changed.externalOwnerEdit = "saved after the model read";
    await writeFile(absoluteMapPath, serializeJsonDocument(changed));
    const afterExternalSave = await readFile(absoluteMapPath);

    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: summary.revision,
          expectedDependencyRevisions: summary.dependencyRevisions,
          operations: [
            {
              type: "setTiles",
              layerId: LAYER_ID,
              cells: [
                {
                  x: 0,
                  y: 0,
                  tile: {
                    tileset: {
                      kind: "external",
                      assetId: summary.tilesets[0]?.assetId,
                    },
                    localId: 0,
                  },
                },
              ],
            },
          ],
        },
      }),
    );

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      result: { error: { code: "REVISION_CONFLICT" } },
    });
    expect(await readFile(absoluteMapPath)).toEqual(afterExternalSave);
  });

  it("returns application errors as isError results with a stable code", async () => {
    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: "../outside.tmj" },
      }),
    );

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      result: {
        ok: false,
        error: {
          code: "INVALID_PROJECT_PATH",
          message: expect.any(String),
          details: { path: "../outside.tmj" },
        },
      },
    });
    const textSummary = textSummaryOf(response, false);
    expect(textSummary.error).toEqual({
      code: "INVALID_PROJECT_PATH",
      message:
        "Project path is not canonical or escapes the root: ../outside.tmj",
    });
    expect(response.content[0]?.text).not.toContain(
      '"details"',
    );
  });

  it("normalizes hostile controls and truncates long application-error text summaries", async () => {
    const detailsOnlySentinel =
      "DETAILS_ONLY_SENTINEL_DO_NOT_MIRROR";
    const hostilePath = [
      "../hostile",
      "\n\r\u0000\u061c\u200e\u200f\u2028\u202e",
      "x".repeat(700),
      detailsOnlySentinel,
      "y".repeat(800),
    ].join("");
    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: hostilePath },
      }),
    );

    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        result: {
          ok: false,
          error: {
            code: "INVALID_PROJECT_PATH",
            details: {
              path: expect.stringContaining(
                detailsOnlySentinel,
              ),
            },
          },
        },
      },
    });
    const textSummary = textSummaryOf(response, false);
    expect(textSummary.error).toMatchObject({
      code: "INVALID_PROJECT_PATH",
      messageTruncated: true,
    });
    expect(textSummary.error?.message).toMatch(/…$/u);
    expect(textSummary.error?.message).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u,
    );
    expect(response.content[0]?.text).not.toContain(
      detailsOnlySentinel,
    );
    expect(response.content[0]?.text).not.toContain(
      '"details"',
    );

    const normalizedOnlyResponse = asToolResponse(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: {
          mapPath: "../short\n\u061c\u200ename.tmj",
        },
      }),
    );
    expect(
      textSummaryOf(normalizedOnlyResponse, false).error,
    ).toEqual({
      code: "INVALID_PROJECT_PATH",
      message:
        "Project path is not canonical or escapes the root: ../short name.tmj",
    });

    const quoteHeavyResponse = asToolResponse(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: {
          mapPath: `../${'"'.repeat(404)}.tmj`,
        },
      }),
    );
    const quoteHeavyStructuredMessage = (
      quoteHeavyResponse.structuredContent as {
        result: {
          error: {
            message: string;
          };
        };
      }
    ).result.error.message;
    expect(
      textSummaryOf(quoteHeavyResponse, false).error,
    ).toEqual({
      code: "INVALID_PROJECT_PATH",
      message: quoteHeavyStructuredMessage,
    });
  });

  it("bounds error messages and structured details derived from hostile documents", async () => {
    const hostile = baseMap();
    hostile.tilesets = [
      {
        firstgid: 1,
        source: `../../${"x".repeat(100_000)}`,
      },
    ];
    await writeFile(
      join(harness.root, MAP_PATH),
      serializeJsonDocument(hostile),
    );

    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const serialized = JSON.stringify(response.structuredContent);
    const result = response.structuredContent?.result as {
      error: { message: string; details: { reference?: string } };
    };

    expect(response.isError).toBe(true);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(64 * 1024);
    expect(result.error.message.length).toBeLessThanOrEqual(4_096);
    expect(result.error.details.reference?.length).toBeLessThanOrEqual(1_024);
    expect(textSummaryOf(response, false).error).toMatchObject({
      code: expect.any(String),
      messageTruncated: true,
    });
  });

  it("creates a new map through the additive create tool", async () => {
    const result = resultOf<{
      path: string;
      beforeRevision: null;
      revision: string;
      changed: boolean;
    }>(
      await harness.client.callTool({
        name: "tiled_create_map",
        arguments: {
          mapPath: "maps/created.tmj",
          width: 3,
          height: 2,
          tileWidth: 16,
          tileHeight: 16,
        },
      }),
    );
    expect(result).toMatchObject({
      path: "maps/created.tmj",
      beforeRevision: null,
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      changed: true,
    });

    const created = JSON.parse(
      await readFile(join(harness.root, "maps/created.tmj"), "utf8"),
    ) as JsonObject;
    expect(created).toMatchObject({
      type: "map",
      orientation: "orthogonal",
      infinite: false,
      width: 3,
      height: 2,
      tilewidth: 16,
      tileheight: 16,
      layers: [],
      tilesets: [],
    });

    const checkpoints = resultOf<{
      manifests: Array<{
        path: string;
        status: string;
        before: { existed: boolean };
      }>;
      corruptEntries: unknown[];
      truncated: boolean;
    }>(
      await harness.client.callTool({
        name: "tiled_list_checkpoints",
        arguments: { status: "committed" },
      }),
    );
    expect(checkpoints).toMatchObject({
      manifests: [
        {
          path: "maps/created.tmj",
          status: "committed",
          before: { existed: false },
        },
      ],
      corruptEntries: [],
      truncated: false,
    });
  });
});

async function createHarness(
  options: {
    rasterizerAvailable?: boolean;
    rasterizerPng?: Buffer;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "tiledmcp-server-"));
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeJson(join(root, MAP_PATH), baseMap());
  await writeJson(join(root, TILESET_PATH), baseTileset());
  await writeFile(join(root, "tiles", "terrain.png"), await terrainPng());

  const resolver = await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  const maps = new MapService(resolver, store);
  const missingExecutable = join(root, "does-not-exist");
  const cli = new TiledCliAdapter({
    tiledCliPath: `${missingExecutable}-tiled`,
    rasterizerPath:
      options.rasterizerAvailable === true ||
      options.rasterizerPng !== undefined
      ? process.execPath
      : `${missingExecutable}-tmxrasterizer`,
  });
  if (options.rasterizerPng !== undefined) {
    const rasterizerPng = options.rasterizerPng;
    const metadata = await sharp(rasterizerPng).metadata();
    if (
      metadata.width === undefined ||
      metadata.height === undefined
    ) {
      throw new Error("Expected rasterizerPng dimensions.");
    }
    cli.renderPng = async (_inputMapPath, outputPngPath) => {
      await writeFile(outputPngPath, rasterizerPng);
      return {
        outputPath: outputPngPath,
        bytes: rasterizerPng.byteLength,
        width: metadata.width!,
        height: metadata.height!,
      };
    };
  }
  const created = await createTiledMcpServer({ resolver, store, maps, cli });
  const client = new Client(
    { name: "tiled-mcp-test-client", version: "0.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await created.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { root, client, server: created.server };
}

async function terrainPng(): Promise<Buffer> {
  return sharp(
    Buffer.from(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">',
        '<rect width="16" height="16" x="0" y="0" fill="#4f8f4f"/>',
        '<rect width="16" height="16" x="16" y="0" fill="#8f6b3f"/>',
        '<rect width="16" height="16" x="0" y="16" fill="#467aa3"/>',
        '<rect width="16" height="16" x="16" y="16" fill="#d2bf72"/>',
        "</svg>",
      ].join(""),
      "utf8",
    ),
  )
    .png()
    .toBuffer();
}

function resultOf<T>(response: unknown): T {
  const toolResponse = asToolResponse(response);
  expect(toolResponse.isError).not.toBe(true);
  expect(toolResponse.structuredContent).toBeDefined();
  return (toolResponse.structuredContent as { result: T }).result;
}

function asToolResponse(response: unknown): ToolResponse {
  expect(response).toBeTypeOf("object");
  expect(response).not.toBeNull();
  expect(response).toHaveProperty("content");
  return response as ToolResponse;
}

function textSummaryOf(
  response: ToolResponse,
  expectedOk: boolean,
): ToolTextSummary {
  const textBlock = response.content[0];
  expect(textBlock).toMatchObject({
    type: "text",
    text: expect.any(String),
  });
  if (
    textBlock?.type !== "text" ||
    typeof textBlock.text !== "string"
  ) {
    throw new Error(
      "Expected the first tool content block to be text.",
    );
  }

  expect(
    Buffer.byteLength(textBlock.text, "utf8"),
  ).toBeLessThanOrEqual(1_024);
  expect(textBlock.text).not.toMatch(
    /[\r\n\u2028\u2029]/u,
  );

  const parsed = JSON.parse(
    textBlock.text,
  ) as unknown;
  expect(parsed).toEqual(expect.any(Object));
  if (!isRecord(parsed)) {
    throw new Error(
      "Expected the tool text block to contain a JSON object.",
    );
  }

  expect(parsed.kind).toBe(
    "tiled-mcp-summary",
  );
  expect(parsed.version).toBe(1);
  expect(parsed.ok).toBe(expectedOk);
  expect(parsed.structuredContentBytes).toBe(
    Buffer.byteLength(
      JSON.stringify(
        response.structuredContent,
      ),
      "utf8",
    ),
  );
  expect(textBlock.text).toBe(
    JSON.stringify(parsed),
  );
  const expectedTopLevelKeys = expectedOk
    ? parsed.image === undefined
      ? [
          "kind",
          "ok",
          "structuredContentBytes",
          "version",
        ]
      : [
          "image",
          "kind",
          "ok",
          "structuredContentBytes",
          "version",
        ]
    : [
        "error",
        "kind",
        "ok",
        "structuredContentBytes",
        "version",
      ];
  expect(Object.keys(parsed).sort()).toEqual(
    expectedTopLevelKeys,
  );
  if (parsed.image !== undefined) {
    if (!isRecord(parsed.image)) {
      throw new Error(
        "Expected image summary metadata to be an object.",
      );
    }
    expect(Object.keys(parsed.image).sort()).toEqual([
      "bytes",
      "mimeType",
    ]);
  }
  if (parsed.error !== undefined) {
    if (!isRecord(parsed.error)) {
      throw new Error(
        "Expected error summary metadata to be an object.",
      );
    }
    expect(Object.keys(parsed.error).sort()).toEqual(
      parsed.error.messageTruncated === undefined
        ? ["code", "message"]
        : [
            "code",
            "message",
            "messageTruncated",
          ],
    );
  }
  return parsed as unknown as ToolTextSummary;
}

function expectNoUnconstrainedOutputSchemas(
  schema: unknown,
  toolName: string,
): void {
  const visited = new Set<object>();

  const visit = (candidate: unknown, path: string): void => {
    expect(candidate, `${toolName} ${path} must not use a boolean schema`).not
      .toBe(true);
    if (candidate === false) {
      return;
    }
    expect(candidate, `${toolName} ${path} must be an object schema`).toEqual(
      expect.any(Object),
    );
    if (!isRecord(candidate) || visited.has(candidate)) {
      return;
    }
    visited.add(candidate);

    expect(
      Object.keys(candidate),
      `${toolName} ${path} must not be an empty/unconstrained schema`,
    ).not.toHaveLength(0);

    const types = Array.isArray(candidate.type)
      ? candidate.type
      : [candidate.type];
    if (
      types.includes("object") ||
      "properties" in candidate ||
      "patternProperties" in candidate
    ) {
      expect(
        candidate,
        `${toolName} ${path} object schemas must constrain extra properties`,
      ).toHaveProperty("additionalProperties");
      expect(
        candidate.additionalProperties,
        `${toolName} ${path} must not allow arbitrary extra properties`,
      ).not.toBe(true);
    }

    for (const key of [
      "additionalProperties",
      "unevaluatedProperties",
      "propertyNames",
      "items",
      "contains",
      "not",
      "if",
      "then",
      "else",
      "contentSchema",
    ]) {
      if (key in candidate && candidate[key] !== false) {
        visit(candidate[key], `${path}/${key}`);
      }
    }
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      const children = candidate[key];
      if (Array.isArray(children)) {
        children.forEach((child, index) => {
          visit(child, `${path}/${key}/${index}`);
        });
      }
    }
    for (const key of [
      "properties",
      "patternProperties",
      "dependentSchemas",
      "$defs",
      "definitions",
    ]) {
      const children = candidate[key];
      if (isRecord(children)) {
        for (const [name, child] of Object.entries(children)) {
          visit(child, `${path}/${key}/${name}`);
        }
      }
    }
  };

  visit(schema, "#");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function baseMap(): JsonObject {
  return {
    compressionlevel: -1,
    height: 2,
    infinite: false,
    layers: [
      {
        data: [1, 0, 0, 0],
        height: 2,
        id: LAYER_ID,
        name: "Ground",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 2,
        x: 0,
        y: 0,
      },
      {
        draworder: "topdown",
        id: OBJECT_LAYER_ID,
        name: "Objects",
        objects: [
          {
            class: "Prop",
            height: 9,
            id: RECTANGLE_OBJECT_ID,
            name: "Crate",
            opacity: 1,
            rotation: 0,
            type: "",
            visible: true,
            width: 8,
            x: 4,
            y: 5,
          },
          {
            class: "Marker",
            height: 0,
            id: POINT_OBJECT_ID,
            name: "Spawn",
            opacity: 1,
            point: true,
            rotation: 0,
            type: "",
            visible: true,
            width: 0,
            x: 1,
            y: 2,
          },
        ],
        opacity: 1,
        type: "objectgroup",
        visible: true,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 9,
    nextobjectid: 3,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [{ firstgid: 1, source: "../tiles/terrain.tsj" }],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 2,
  };
}

function baseTileset(): JsonObject {
  return {
    columns: 2,
    image: "terrain.png",
    imageheight: 32,
    imagewidth: 32,
    margin: 0,
    name: "Terrain",
    spacing: 0,
    tilecount: 4,
    tileheight: 16,
    tilewidth: 16,
    tiledversion: "1.12.2",
    type: "tileset",
    version: "1.10",
  };
}

async function writeJson(path: string, document: JsonObject): Promise<void> {
  await writeFile(path, serializeJsonDocument(document));
}
