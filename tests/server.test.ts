import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";

import {
  TiledCliAdapter,
  type RenderPngOptions,
  type RenderPngResult,
} from "../src/adapters/tiledCli.js";
import {
  TILED_MCP_APPLICATION_ERROR_REGISTRY,
  TILED_MCP_APPLICATION_ERROR_REGISTRY_JSON,
} from "../src/errorRegistry.js";
import {
  TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT,
} from "../src/filesystemThreatModelContract.js";
import { serializeJsonDocument, type JsonObject } from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import {
  tileRenderToolOutputSchema,
} from "../src/outputSchemas/read.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  APPLICATION_ERROR_RESOURCE_META,
  APPLICATION_ERROR_RESOURCE_MIME_TYPE,
  APPLICATION_ERROR_RESOURCE_REVISION,
  APPLICATION_ERROR_RESOURCE_SIZE,
  APPLICATION_ERROR_RESOURCE_URI,
} from "../src/resources/applicationErrors.js";
import {
  GUIDE_RESOURCE_MIME_TYPE,
  GUIDE_RESOURCE_REVISION,
  GUIDE_RESOURCE_SIZE,
  GUIDE_RESOURCE_URI,
  MAX_GUIDE_RESOURCE_BYTES,
} from "../src/resources/guide.js";
import {
  ASSET_REGISTRY_RELATIVE_PATH,
} from "../src/project/assetRegistry.js";
import { createTiledMcpServer } from "../src/server.js";
import {
  CHECKPOINT_STORAGE_POLICY,
  DEFAULT_CHECKPOINT_STORAGE_BYTES,
  MAX_CHECKPOINT_OBSERVED_ENTRIES,
  MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT,
  type CheckpointStoreOptions,
} from "../src/storage/checkpoints.js";
import { DocumentStore } from "../src/storage/documentStore.js";
import { revisionOf } from "../src/storage/revision.js";
import { SERVER_NAME, SERVER_VERSION } from "../src/version.js";

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
const LAYER_ID = 7;
const OBJECT_LAYER_ID = 8;
const RECTANGLE_OBJECT_ID = 1;
const POINT_OBJECT_ID = 2;
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
const CORE_TOOLS = [
  "tiled_get_capabilities",
  "tiled_list_files",
  "tiled_list_world_maps",
  "tiled_list_checkpoints",
  "tiled_preview_prepared_checkpoint_discard",
  "tiled_preview_prepared_checkpoint_commit",
  "tiled_preview_prepared_checkpoint_abandon",
  "tiled_preview_checkpoint_prune",
  "tiled_preview_checkpoint_prune_batch",
  "tiled_preview_checkpoint_restore",
  "tiled_get_map_summary",
  "tiled_get_tileset",
  "tiled_find_tiles",
  "tiled_get_region",
  "tiled_render_tileset_sheet",
  "tiled_render_tiles",
  "tiled_render_preview",
  "tiled_list_objects",
  "tiled_get_object",
  "tiled_validate",
  "tiled_analyze_usage",
  "tiled_create_map",
  "tiled_create_tileset",
  "tiled_delete_file",
  "tiled_add_tileset_to_map",
  "tiled_update_tile",
  "tiled_update_wangsets",
  "tiled_create_layer",
  "tiled_preview_edits",
  "tiled_preview_world_edits",
  "tiled_preview_transaction",
  "tiled_apply_change_set",
] as const;

interface Harness {
  root: string;
  client: Client;
  server: McpServer;
  store: DocumentStore;
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

  it("fails closed on a corrupt asset registry before probing capabilities or registering tools", async () => {
    await mkdir(
      join(harness.root, ".tiledmcp"),
      { recursive: true },
    );
    await writeFile(
      join(
        harness.root,
        ASSET_REGISTRY_RELATIVE_PATH,
      ),
      '{"format":"truncated"',
      "utf8",
    );
    const resolver =
      await ProjectPathResolver.create(harness.root);
    const store = new DocumentStore(resolver);
    const maps = new MapService(resolver, store);
    const cli = new TiledCliAdapter({
      tiledCliPath: join(
        harness.root,
        "unused-tiled",
      ),
      rasterizerPath: join(
        harness.root,
        "unused-rasterizer",
      ),
    });
    let probeCalls = 0;
    cli.probeCapabilities = async () => {
      probeCalls += 1;
      throw new Error(
        "capability probe must not run",
      );
    };

    await expect(
      createTiledMcpServer({
        resolver,
        store,
        maps,
        cli,
      }),
    ).rejects.toMatchObject({
      code: "ASSET_REGISTRY_CORRUPT",
    });
    expect(probeCalls).toBe(0);
  });

  it("advertises exactly the thirty-two core tools with safety annotations", async () => {
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
      "tiled_render_tiles",
      "tiled_render_preview",
      "tiled_list_objects",
      "tiled_get_object",
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
      "tiled_preview_prepared_checkpoint_discard",
      "tiled_preview_prepared_checkpoint_commit",
      "tiled_preview_prepared_checkpoint_abandon",
      "tiled_preview_checkpoint_prune",
      "tiled_preview_checkpoint_prune_batch",
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
      "tiled_create_tileset",
      "tiled_delete_file",
      "tiled_add_tileset_to_map",
      "tiled_update_tile",
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
      byName.get("tiled_preview_prepared_checkpoint_discard")
        ?.inputSchema,
    ).toMatchObject({
      type: "object",
      properties: {
        checkpointId: { type: "string" },
      },
      required: ["checkpointId"],
      additionalProperties: false,
    });
    for (const name of [
      "tiled_preview_prepared_checkpoint_commit",
      "tiled_preview_prepared_checkpoint_abandon",
    ]) {
      expect(
        byName.get(name)?.inputSchema,
      ).toMatchObject({
        type: "object",
        properties: {
          checkpointId: { type: "string" },
        },
        required: ["checkpointId"],
        additionalProperties: false,
      });
    }
    expect(
      byName.get("tiled_preview_checkpoint_prune")?.inputSchema,
    ).toMatchObject({
      type: "object",
      properties: {
        checkpointId: { type: "string" },
      },
      required: ["checkpointId"],
      additionalProperties: false,
    });
    expect(
      byName.get(
        "tiled_preview_checkpoint_prune_batch",
      )?.inputSchema,
    ).toMatchObject({
      type: "object",
      properties: {
        checkpointIds: {
          type: "array",
          minItems: 2,
          maxItems: 32,
          items: {
            type: "string",
            pattern:
              "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$",
          },
        },
      },
      required: ["checkpointIds"],
      additionalProperties: false,
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

  it("advertises non-default checkpoint limits and retention through a dynamic registered output schema", async () => {
    const maxBytes = 12_345;
    const maxEntries = 37;
    const retainCommittedPerTarget = 23;
    const customHarness = await createHarness({
      checkpointOptions: {
        maxBytes,
        maxEntries,
        retainCommittedPerTarget,
      },
    });

    try {
      const listed = await customHarness.client.listTools();
      expect(
        listed.tools.some(
          ({ name }) =>
            name === "tiled_get_capabilities",
        ),
      ).toBe(true);

      const response = asToolResponse(
        await customHarness.client.callTool({
          name: "tiled_get_capabilities",
          arguments: {},
        }),
      );
      const capabilities = resultOf<{
        checkpointCapabilities: {
          retention: {
            enabled: boolean;
            retainCommittedPerTarget:
              number | null;
          };
          storagePolicy: {
            maxBytes: number;
            maxEntries: number;
          };
        };
      }>(response);
      expect(
        capabilities.checkpointCapabilities
          .storagePolicy,
      ).toMatchObject({
        maxBytes,
        maxEntries,
      });
      expect(
        capabilities.checkpointCapabilities.retention,
      ).toMatchObject({
        enabled: true,
        retainCommittedPerTarget,
      });

      const outputSchema = (
        customHarness.server as unknown as {
          _registeredTools: Record<
            string,
            { outputSchema?: ZodType }
          >;
        }
      )._registeredTools[
        "tiled_get_capabilities"
      ]?.outputSchema;
      expect(outputSchema).toBeDefined();
      if (outputSchema === undefined) {
        throw new Error(
          "Expected a registered capabilities output schema.",
        );
      }
      expect(
        outputSchema.safeParse(
          response.structuredContent,
        ).success,
      ).toBe(true);

      const alternate = structuredClone(
        response.structuredContent,
      ) as {
        result: {
          checkpointCapabilities: {
            retention: {
              enabled: boolean;
              retainCommittedPerTarget:
                number | null;
            };
            storagePolicy: {
              maxBytes: number;
              maxEntries: number;
            };
          };
        };
      };
      alternate.result.checkpointCapabilities
        .storagePolicy.maxBytes += 1;
      alternate.result.checkpointCapabilities
        .storagePolicy.maxEntries += 1;
      alternate.result.checkpointCapabilities
        .retention.enabled = false;
      alternate.result.checkpointCapabilities
        .retention.retainCommittedPerTarget =
        null;
      expect(outputSchema.parse(alternate)).toEqual(
        alternate,
      );
    } finally {
      await customHarness.client
        .close()
        .catch(() => undefined);
      await customHarness.server
        .close()
        .catch(() => undefined);
      await rm(customHarness.root, {
        recursive: true,
        force: true,
      });
    }
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

  it("lists strict v2 protected and rolling checkpoint manifests when retention is enabled", async () => {
    const retentionHarness =
      await createHarness({
        checkpointOptions: {
          retainCommittedPerTarget: 2,
        },
      });
    try {
      const before = await readFile(
        join(retentionHarness.root, MAP_PATH),
      );
      const protectedCheckpoint =
        await retentionHarness.store.checkpoints.markCommitted(
          await retentionHarness.store.checkpoints.prepare(
            "maps/future.tmj",
            undefined,
            revisionOf(Buffer.from('{"future":true}\n', "utf8")),
            "protected create",
          ),
        );
      const rollingCheckpoint =
        await retentionHarness.store.checkpoints.markCommitted(
          await retentionHarness.store.checkpoints.prepare(
            MAP_PATH,
            before,
            revisionOf(Buffer.from('{"edited":true}\n', "utf8")),
            "rolling edit",
          ),
        );

      const listing = resultOf<{
        manifests: Array<Record<string, unknown>>;
        corruptEntries: unknown[];
      }>(
        await retentionHarness.client.callTool({
          name: "tiled_list_checkpoints",
          arguments: {
            status: "committed",
          },
        }),
      );
      expect(listing.corruptEntries).toEqual([]);
      expect(listing.manifests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: protectedCheckpoint.id,
            version: 2,
            retention: {
              class: "protected",
            },
          }),
          expect.objectContaining({
            id: rollingCheckpoint.id,
            version: 2,
            retention: {
              class: "rolling",
              ordinal: 1,
            },
          }),
        ]),
      );
    } finally {
      await retentionHarness.client
        .close()
        .catch(() => undefined);
      await retentionHarness.server
        .close()
        .catch(() => undefined);
      await rm(retentionHarness.root, {
        recursive: true,
        force: true,
      });
    }
  });

  it("advertises an exact output schema for the optional rasterizer tool", async () => {
    const forwardedRenderOptions:
      RenderPngOptions[] = [];
    const rasterHarness = await createHarness({
      rasterizerAvailable: true,
      rasterizerPng: await terrainPng(),
      onRasterizerRender: async ({
        options,
      }) => {
        forwardedRenderOptions.push({
          ...options,
        });
      },
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
      expectExactRasterResultOutputSchema(
        rasterTool?.outputSchema,
      );
      const capabilities = resultOf<{
        registeredTools: string[];
        rasterMapCapabilities: Record<string, unknown>;
        limits: Record<string, unknown>;
        cli: {
          rasterizer: {
            available: boolean;
            version: string | null;
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
            version: "1.0",
          },
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
        limits: {
          maxInlineImageBytes:
            8 * 1_024 * 1_024,
          maxRenderEdge: 2_048,
          maxRasterInputImages: 64,
          maxRasterInputAggregateBytes:
            64 * 1_024 * 1_024,
          maxRasterInputAggregatePixels:
            16_000_000,
          maxRasterInputEdge: 8_192,
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

      const sourceSummary = resultOf<{
        revision: string;
        dependencyRevisions: Record<string, string>;
      }>(
        await rasterHarness.client.callTool({
          name: "tiled_get_map_summary",
          arguments: {
            mapPath: MAP_PATH,
          },
        }),
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
      const result = (
        rasterResponse.structuredContent as {
          result: Record<string, unknown>;
        }
      ).result;
      expect(result).toEqual({
        mimeType: "image/png",
        pixelSize: {
          width: 32,
          height: 32,
        },
        byteLength: png.byteLength,
        sha256: revisionOf(png),
        map: {
          path: MAP_PATH,
          revision:
            sourceSummary.revision,
        },
        dependencyRevisions:
          sourceSummary.dependencyRevisions,
        renderer: {
          kind: "tmxrasterizer",
          version: "1.0",
          profile:
            "tmxrasterizer-png-v1",
        },
        options: {
          size: 128,
          ignoreVisibility: false,
        },
        snapshotConsistency:
          "non-atomic-read-set",
        truncated: false,
      });
      for (const legacyField of [
        "mapPath",
        "bytes",
        "width",
        "height",
      ]) {
        expect(result).not.toHaveProperty(
          legacyField,
        );
      }

      const defaultSizeResponse = resultOf<{
        options: {
          size: number;
          ignoreVisibility: boolean;
        };
      }>(
        await rasterHarness.client.callTool({
          name: "tiled_render_map",
          arguments: {
            mapPath: MAP_PATH,
            ignoreVisibility: true,
          },
        }),
      );
      expect(defaultSizeResponse.options).toEqual({
        size: 1_400,
        ignoreVisibility: true,
      });
      const maximumSizeResponse =
        resultOf<{
          options: {
            size: number;
            ignoreVisibility: boolean;
          };
        }>(
          await rasterHarness.client.callTool({
            name: "tiled_render_map",
            arguments: {
              mapPath: MAP_PATH,
              size: 2_048,
            },
          }),
        );
      expect(
        maximumSizeResponse.options,
      ).toEqual({
        size: 2_048,
        ignoreVisibility: false,
      });
      const oversizedInput =
        asToolResponse(
          await rasterHarness.client.callTool({
            name: "tiled_render_map",
            arguments: {
              mapPath: MAP_PATH,
              size: 2_049,
            },
          }),
        );
      expect(oversizedInput.isError).toBe(
        true,
      );
      expect(
        oversizedInput.structuredContent,
      ).toBeUndefined();
      expect(
        forwardedRenderOptions,
      ).toEqual([
        {
          size: 128,
          ignoreVisibility: false,
          maxPngBytes:
            8 * 1_024 * 1_024,
        },
        {
          size: 1_400,
          ignoreVisibility: true,
          maxPngBytes:
            8 * 1_024 * 1_024,
        },
        {
          size: 2_048,
          ignoreVisibility: false,
          maxPngBytes:
            8 * 1_024 * 1_024,
        },
      ]);
      expect(
        await readdir(
          join(
            rasterHarness.root,
            ".tiledmcp",
            "renders",
          ),
        ),
      ).toEqual([]);
    } finally {
      await rasterHarness.client.close().catch(() => undefined);
      await rasterHarness.server.close().catch(() => undefined);
      await rm(rasterHarness.root, { recursive: true, force: true });
    }
  });

  it.each([
    "bytes",
    "width",
    "height",
  ] as const)(
    "rejects incoherent rasterizer %s metadata without returning an image",
    async (field) => {
      const rasterizerPng =
        await terrainPng();
      const rasterHarness =
        await createHarness({
          rasterizerPng,
          rasterizerMetadataOverride:
            field === "bytes"
              ? {
                  bytes:
                    rasterizerPng.byteLength +
                    1,
                }
              : {
                  [field]: 33,
                },
        });
      try {
        await rasterHarness.client.listTools();
        const response = asToolResponse(
          await rasterHarness.client.callTool({
            name: "tiled_render_map",
            arguments: {
              mapPath: MAP_PATH,
            },
          }),
        );

        expect(response.isError).toBe(true);
        expect(
          response.content.every(
            (block) => block.type !== "image",
          ),
        ).toBe(true);
        expect(
          response.structuredContent,
        ).toMatchObject({
          result: {
            ok: false,
            error: {
              code:
                "TMXRASTERIZER_OUTPUT_INVALID",
            },
          },
        });
        expect(
          await readdir(
            join(
              rasterHarness.root,
              ".tiledmcp",
              "renders",
            ),
          ),
        ).toEqual([]);
      } finally {
        await rasterHarness.client
          .close()
          .catch(() => undefined);
        await rasterHarness.server
          .close()
          .catch(() => undefined);
        await rm(rasterHarness.root, {
          recursive: true,
          force: true,
        });
      }
    },
  );

  it("rejects raster output larger than the requested effective size", async () => {
    const rasterHarness = await createHarness({
      rasterizerPng: await terrainPng(),
    });
    try {
      await rasterHarness.client.listTools();
      const response = asToolResponse(
        await rasterHarness.client.callTool({
          name: "tiled_render_map",
          arguments: {
            mapPath: MAP_PATH,
            size: 16,
          },
        }),
      );

      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          result: {
            ok: false,
            error: {
              code:
                "TMXRASTERIZER_OUTPUT_INVALID",
              details: {
                width: 32,
                height: 32,
                maxEdge: 16,
                requestedSize: 16,
              },
            },
          },
        },
      });
      expect(
        response.content.every(
          (block) => block.type !== "image",
        ),
      ).toBe(true);
      expect(
        await readdir(
          join(
            rasterHarness.root,
            ".tiledmcp",
            "renders",
          ),
        ),
      ).toEqual([]);
    } finally {
      await rasterHarness.client
        .close()
        .catch(() => undefined);
      await rasterHarness.server
        .close()
        .catch(() => undefined);
      await rm(rasterHarness.root, {
        recursive: true,
        force: true,
      });
    }
  });

  it("fails closed without returning an image when raster cleanup fails", async () => {
    const rasterHarness = await createHarness({
      rasterizerPng: await terrainPng(),
      onRasterizerRender: async ({
        outputPngPath,
      }) => {
        await unlink(outputPngPath);
        await mkdir(outputPngPath);
      },
    });
    try {
      await rasterHarness.client.listTools();
      const response = asToolResponse(
        await rasterHarness.client.callTool({
          name: "tiled_render_map",
          arguments: {
            mapPath: MAP_PATH,
          },
        }),
      );

      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          result: {
            ok: false,
            error: {
              code:
                "RASTER_TEMP_CLEANUP_FAILED",
            },
          },
        },
      });
      expect(
        response.content.every(
          (block) => block.type !== "image",
        ),
      ).toBe(true);
    } finally {
      await rasterHarness.client
        .close()
        .catch(() => undefined);
      await rasterHarness.server
        .close()
        .catch(() => undefined);
      await rm(rasterHarness.root, {
        recursive: true,
        force: true,
      });
    }
  });

  it("rejects oversized raster input images before invoking the rasterizer", async () => {
    let renderCalled = false;
    const rasterHarness = await createHarness({
      rasterizerPng: await terrainPng(),
      onRasterizerRender: async () => {
        renderCalled = true;
      },
    });
    try {
      await writeFile(
        join(
          rasterHarness.root,
          "tiles",
          "terrain.png",
        ),
        [
          '<svg xmlns="http://www.w3.org/2000/svg"',
          ' width="8193" height="1">',
          '<rect width="8193" height="1"/>',
          "</svg>",
        ].join(""),
        "utf8",
      );
      await rasterHarness.client.listTools();
      const response = asToolResponse(
        await rasterHarness.client.callTool({
          name: "tiled_render_map",
          arguments: {
            mapPath: MAP_PATH,
          },
        }),
      );

      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          result: {
            ok: false,
            error: {
              code:
                "INVALID_TILESET_IMAGE",
            },
          },
        },
      });
      expect(renderCalled).toBe(false);
      expect(
        response.content.every(
          (block) => block.type !== "image",
        ),
      ).toBe(true);
    } finally {
      await rasterHarness.client
        .close()
        .catch(() => undefined);
      await rasterHarness.server
        .close()
        .catch(() => undefined);
      await rm(rasterHarness.root, {
        recursive: true,
        force: true,
      });
    }
  });

  it("enforces the aggregate raster input byte budget before invoking the rasterizer", async () => {
    let renderCalled = false;
    const rasterHarness = await createHarness({
      rasterizerPng: await terrainPng(),
      onRasterizerRender: async () => {
        renderCalled = true;
      },
    });
    try {
      const smallImage =
        await terrainPng();
      await writeFile(
        join(
          rasterHarness.root,
          "tiles",
          "raster-small.png",
        ),
        smallImage,
      );
      const sparseImagePath = join(
        rasterHarness.root,
        "tiles",
        "raster-sparse.png",
      );
      await writeFile(
        sparseImagePath,
        Buffer.alloc(0),
      );
      await truncate(
        sparseImagePath,
        64 * 1_024 * 1_024,
      );
      const map = baseMap();
      (
        map.layers as JsonObject[]
      ).push(
        {
          id: 90,
          type: "imagelayer",
          image:
            "../tiles/raster-small.png",
        },
        {
          id: 91,
          type: "imagelayer",
          image:
            "../tiles/raster-sparse.png",
        },
      );
      map.nextlayerid = 92;
      await writeJson(
        join(
          rasterHarness.root,
          MAP_PATH,
        ),
        map,
      );
      await rasterHarness.client.listTools();
      const response = asToolResponse(
        await rasterHarness.client.callTool({
          name: "tiled_render_map",
          arguments: {
            mapPath: MAP_PATH,
          },
        }),
      );

      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          result: {
            ok: false,
            error: {
              code:
                "IMAGE_TOO_LARGE",
              details: {
                path:
                  "tiles/raster-sparse.png",
                limit:
                  64 * 1_024 * 1_024 -
                  smallImage.byteLength,
              },
            },
          },
        },
      });
      expect(renderCalled).toBe(false);
      expect(
        response.content.every(
          (block) => block.type !== "image",
        ),
      ).toBe(true);
    } finally {
      await rasterHarness.client
        .close()
        .catch(() => undefined);
      await rasterHarness.server
        .close()
        .catch(() => undefined);
      await rm(rasterHarness.root, {
        recursive: true,
        force: true,
      });
    }
  });

  it("enforces the aggregate raster input pixel budget before invoking the rasterizer", async () => {
    let renderCalled = false;
    const rasterHarness = await createHarness({
      rasterizerPng: await terrainPng(),
      onRasterizerRender: async () => {
        renderCalled = true;
      },
    });
    try {
      await writeFile(
        join(
          rasterHarness.root,
          "tiles",
          "sixteen-megapixels.svg",
        ),
        [
          '<svg xmlns="http://www.w3.org/2000/svg"',
          ' width="4000" height="4000">',
          '<rect width="4000" height="4000"/>',
          "</svg>",
        ].join(""),
        "utf8",
      );
      const map = baseMap();
      (
        map.layers as JsonObject[]
      ).push({
        id: 90,
        type: "imagelayer",
        image:
          "../tiles/sixteen-megapixels.svg",
      });
      map.nextlayerid = 91;
      await writeJson(
        join(
          rasterHarness.root,
          MAP_PATH,
        ),
        map,
      );
      await rasterHarness.client.listTools();
      const response = asToolResponse(
        await rasterHarness.client.callTool({
          name: "tiled_render_map",
          arguments: {
            mapPath: MAP_PATH,
          },
        }),
      );

      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          result: {
            ok: false,
            error: {
              code:
                "RESULT_LIMIT_EXCEEDED",
              details: {
                path:
                  "tiles/terrain.png",
                limit: 16_000_000,
                actual: 16_000_000,
              },
            },
          },
        },
      });
      expect(renderCalled).toBe(false);
      expect(
        response.content.every(
          (block) => block.type !== "image",
        ),
      ).toBe(true);
    } finally {
      await rasterHarness.client
        .close()
        .catch(() => undefined);
      await rasterHarness.server
        .close()
        .catch(() => undefined);
      await rm(rasterHarness.root, {
        recursive: true,
        force: true,
      });
    }
  });

  it("validates per-tile raster images before invoking the rasterizer", async () => {
    let renderCalled = false;
    const rasterHarness = await createHarness({
      rasterizerPng: await terrainPng(),
      onRasterizerRender: async () => {
        renderCalled = true;
      },
    });
    try {
      const tileset = baseTileset();
      tileset.tiles = [
        {
          id: 0,
          image: "invalid-tile-image.bin",
        },
      ];
      await writeJson(
        join(
          rasterHarness.root,
          TILESET_PATH,
        ),
        tileset,
      );
      await writeFile(
        join(
          rasterHarness.root,
          "tiles",
          "invalid-tile-image.bin",
        ),
        "not an image",
        "utf8",
      );
      await rasterHarness.client.listTools();
      const response = asToolResponse(
        await rasterHarness.client.callTool({
          name: "tiled_render_map",
          arguments: {
            mapPath: MAP_PATH,
          },
        }),
      );

      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          result: {
            ok: false,
            error: {
              code:
                "UNSUPPORTED_IMAGE_FORMAT",
            },
          },
        },
      });
      expect(renderCalled).toBe(false);
      expect(
        response.content.every(
          (block) => block.type !== "image",
        ),
      ).toBe(true);
    } finally {
      await rasterHarness.client
        .close()
        .catch(() => undefined);
      await rasterHarness.server
        .close()
        .catch(() => undefined);
      await rm(rasterHarness.root, {
        recursive: true,
        force: true,
      });
    }
  });

  it("bounds the deduplicated raster image-layer input set", async () => {
    let renderCalled = false;
    const rasterHarness = await createHarness({
      rasterizerPng: await terrainPng(),
      onRasterizerRender: async () => {
        renderCalled = true;
      },
    });
    try {
      const image = await terrainPng();
      const map = baseMap();
      const layers =
        map.layers as JsonObject[];
      for (
        let index = 0;
        index < 64;
        index += 1
      ) {
        const fileName =
          `raster-input-${String(index)}.png`;
        await writeFile(
          join(
            rasterHarness.root,
            "tiles",
            fileName,
          ),
          image,
        );
        layers.push({
          id: 100 + index,
          type: "imagelayer",
          image:
            `../tiles/${fileName}`,
        });
      }
      map.nextlayerid = 164;
      await writeJson(
        join(
          rasterHarness.root,
          MAP_PATH,
        ),
        map,
      );
      await rasterHarness.client.listTools();
      const response = asToolResponse(
        await rasterHarness.client.callTool({
          name: "tiled_render_map",
          arguments: {
            mapPath: MAP_PATH,
          },
        }),
      );

      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          result: {
            ok: false,
            error: {
              code:
                "RESULT_LIMIT_EXCEEDED",
              details: {
                path:
                  "tiles/terrain.png",
                limit: 64,
              },
            },
          },
        },
      });
      expect(renderCalled).toBe(false);
      expect(
        response.content.every(
          (block) => block.type !== "image",
        ),
      ).toBe(true);

      const deduplicatedMap =
        baseMap();
      const deduplicatedLayers =
        deduplicatedMap.layers as JsonObject[];
      await Promise.all([
        writeFile(
          join(
            rasterHarness.root,
            "tiles",
            "raster-input.png",
          ),
          image,
        ),
        writeFile(
          join(
            rasterHarness.root,
            "tiles",
            "raster_input.png",
          ),
          image,
        ),
      ]);
      deduplicatedLayers.push(
        {
          id: 198,
          type: "imagelayer",
          image:
            "../tiles/raster-input.png",
        },
        {
          id: 199,
          type: "imagelayer",
          image:
            "../tiles/raster_input.png",
        },
      );
      for (
        let index = 0;
        index < 65;
        index += 1
      ) {
        deduplicatedLayers.push({
          id: 200 + index,
          type: "imagelayer",
          image:
            "../tiles/terrain.png",
        });
      }
      deduplicatedMap.nextlayerid = 265;
      await writeJson(
        join(
          rasterHarness.root,
          MAP_PATH,
        ),
        deduplicatedMap,
      );
      const deduplicatedResponse =
        asToolResponse(
          await rasterHarness.client.callTool({
            name: "tiled_render_map",
            arguments: {
              mapPath: MAP_PATH,
            },
          }),
        );
      expect(
        deduplicatedResponse.isError,
      ).not.toBe(true);
      expect(renderCalled).toBe(true);
    } finally {
      await rasterHarness.client
        .close()
        .catch(() => undefined);
      await rasterHarness.server
        .close()
        .catch(() => undefined);
      await rm(rasterHarness.root, {
        recursive: true,
        force: true,
      });
    }
  });

  it("cleans a partial rasterizer output when the adapter fails after writing", async () => {
    const rasterHarness = await createHarness({
      rasterizerPng: await terrainPng(),
      onRasterizerRender: async () => {
        throw new Error(
          "injected rasterizer read failure",
        );
      },
    });
    try {
      await rasterHarness.client.listTools();
      const response = asToolResponse(
        await rasterHarness.client.callTool({
          name: "tiled_render_map",
          arguments: {
            mapPath: MAP_PATH,
          },
        }),
      );

      expect(response.isError).toBe(true);
      expect(
        response.content.every(
          (block) => block.type !== "image",
        ),
      ).toBe(true);
      expect(response.structuredContent).toMatchObject({
        result: {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
          },
        },
      });
      expect(
        await readdir(
          join(
            rasterHarness.root,
            ".tiledmcp",
            "renders",
          ),
        ),
      ).toEqual([]);
    } finally {
      await rasterHarness.client
        .close()
        .catch(() => undefined);
      await rasterHarness.server
        .close()
        .catch(() => undefined);
      await rm(rasterHarness.root, {
        recursive: true,
        force: true,
      });
    }
  });

  it("rejects a map revision race after rasterization and removes its temporary PNG", async () => {
    const rasterHarness = await createHarness({
      rasterizerPng: await terrainPng(),
      onRasterizerRender: async ({ root }) => {
        const changedMap = baseMap();
        changedMap.backgroundcolor = "#123456";
        await writeJson(
          join(root, MAP_PATH),
          changedMap,
        );
      },
    });
    try {
      await rasterHarness.client.listTools();
      const response = asToolResponse(
        await rasterHarness.client.callTool({
          name: "tiled_render_map",
          arguments: {
            mapPath: MAP_PATH,
          },
        }),
      );

      expect(response.isError).toBe(true);
      expect(
        response.content.every(
          (block) => block.type !== "image",
        ),
      ).toBe(true);
      expect(response.structuredContent).toMatchObject({
        result: {
          ok: false,
          error: {
            code: "REVISION_CONFLICT",
            details: {
              path: MAP_PATH,
              expectedRevision:
                expect.stringMatching(
                  /^sha256:[0-9a-f]{64}$/u,
                ),
              actualRevision:
                expect.stringMatching(
                  /^sha256:[0-9a-f]{64}$/u,
                ),
            },
          },
        },
      });
      expect(
        await readdir(
          join(
            rasterHarness.root,
            ".tiledmcp",
            "renders",
          ),
        ),
      ).toEqual([]);
    } finally {
      await rasterHarness.client
        .close()
        .catch(() => undefined);
      await rasterHarness.server
        .close()
        .catch(() => undefined);
      await rm(rasterHarness.root, {
        recursive: true,
        force: true,
      });
    }
  });

  it("rejects a tileset revision race after rasterization and removes its temporary PNG", async () => {
    const rasterHarness = await createHarness({
      rasterizerPng: await terrainPng(),
      onRasterizerRender: async ({ root }) => {
        const changedTileset = baseTileset();
        changedTileset.name =
          "Changed while rasterizing";
        await writeJson(
          join(root, TILESET_PATH),
          changedTileset,
        );
      },
    });
    try {
      await rasterHarness.client.listTools();
      const response = asToolResponse(
        await rasterHarness.client.callTool({
          name: "tiled_render_map",
          arguments: {
            mapPath: MAP_PATH,
          },
        }),
      );

      expect(response.isError).toBe(true);
      expect(
        response.content.every(
          (block) => block.type !== "image",
        ),
      ).toBe(true);
      expect(response.structuredContent).toMatchObject({
        result: {
          ok: false,
          error: {
            code:
              "DEPENDENCY_REVISION_CONFLICT",
            details: {
              assetId:
                expect.stringMatching(
                  /^asset_[0-9a-f]{24}$/u,
                ),
              expectedRevision:
                expect.stringMatching(
                  /^sha256:[0-9a-f]{64}$/u,
                ),
              actualRevision:
                expect.stringMatching(
                  /^sha256:[0-9a-f]{64}$/u,
                ),
            },
          },
        },
      });
      expect(
        await readdir(
          join(
            rasterHarness.root,
            ".tiledmcp",
            "renders",
          ),
        ),
      ).toEqual([]);
    } finally {
      await rasterHarness.client
        .close()
        .catch(() => undefined);
      await rasterHarness.server
        .close()
        .catch(() => undefined);
      await rm(rasterHarness.root, {
        recursive: true,
        force: true,
      });
    }
  });

  it("rejects an input image revision race after rasterization", async () => {
    const changedImage = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 4,
        background: "#7b2fbe",
      },
    })
      .png()
      .toBuffer();
    const rasterHarness = await createHarness({
      rasterizerPng: await terrainPng(),
      onRasterizerRender: async ({ root }) => {
        await writeFile(
          join(
            root,
            "tiles",
            "terrain.png",
          ),
          changedImage,
        );
      },
    });
    try {
      await rasterHarness.client.listTools();
      const response = asToolResponse(
        await rasterHarness.client.callTool({
          name: "tiled_render_map",
          arguments: {
            mapPath: MAP_PATH,
          },
        }),
      );

      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          result: {
            ok: false,
            error: {
              code:
                "DEPENDENCY_REVISION_CONFLICT",
              details: {
                path:
                  "tiles/terrain.png",
              },
            },
          },
        },
      });
      expect(
        response.content.every(
          (block) => block.type !== "image",
        ),
      ).toBe(true);
      const imageRaceDetails = (
        response.structuredContent as {
          result: {
            error: {
              details: Record<
                string,
                unknown
              >;
            };
          };
        }
      ).result.error.details;
      expect(
        imageRaceDetails,
      ).not.toHaveProperty(
        "expectedRevision",
      );
      expect(
        imageRaceDetails,
      ).not.toHaveProperty(
        "actualRevision",
      );
      expect(
        await readdir(
          join(
            rasterHarness.root,
            ".tiledmcp",
            "renders",
          ),
        ),
      ).toEqual([]);
    } finally {
      await rasterHarness.client
        .close()
        .catch(() => undefined);
      await rasterHarness.server
        .close()
        .catch(() => undefined);
      await rm(rasterHarness.root, {
        recursive: true,
        force: true,
      });
    }
  });

  it("advertises and serves the bounded direct contract resources", async () => {
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
      {
        uri: APPLICATION_ERROR_RESOURCE_URI,
        name: "application-errors",
        title:
          "TiledMCP stable application error registry",
        description:
          "The versioned identifiers that may appear at structuredContent.result.error.code, plus compatibility and excluded-surface rules.",
        mimeType:
          APPLICATION_ERROR_RESOURCE_MIME_TYPE,
        size: APPLICATION_ERROR_RESOURCE_SIZE,
        annotations: {
          audience: ["assistant", "user"],
          priority: 1,
        },
        _meta: APPLICATION_ERROR_RESOURCE_META,
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
    expect(content.text).toContain(
      "traceable PNG contract",
    );
    expect(content.text).toContain(
      '`snapshotConsistency:"non-atomic-read-set"`',
    );
    expect(content.text).toContain(
      "`filesystemThreatModelContract`",
    );
    expect(content.text).toContain(
      "non-cooperative writer",
    );
    expect(content.text).toContain(
      "OS sandbox or mediated writer",
    );

    const applicationErrors =
      await harness.client.readResource({
        uri: APPLICATION_ERROR_RESOURCE_URI,
      });
    expect(applicationErrors.contents).toHaveLength(
      1,
    );
    const applicationErrorContent =
      applicationErrors.contents[0];
    expect(applicationErrorContent).toMatchObject({
      uri: APPLICATION_ERROR_RESOURCE_URI,
      mimeType:
        APPLICATION_ERROR_RESOURCE_MIME_TYPE,
      _meta: APPLICATION_ERROR_RESOURCE_META,
    });
    if (
      applicationErrorContent === undefined ||
      !("text" in applicationErrorContent)
    ) {
      throw new Error(
        "Expected tiled://application-errors to return text content",
      );
    }
    expect(applicationErrorContent.text).toBe(
      TILED_MCP_APPLICATION_ERROR_REGISTRY_JSON,
    );
    const applicationErrorBytes = Buffer.from(
      applicationErrorContent.text,
      "utf8",
    );
    expect(applicationErrorBytes.byteLength).toBe(
      APPLICATION_ERROR_RESOURCE_SIZE,
    );
    expect(
      revisionOf(applicationErrorBytes),
    ).toBe(
      APPLICATION_ERROR_RESOURCE_REVISION,
    );
    expect(
      JSON.parse(applicationErrorContent.text),
    ).toEqual(
      TILED_MCP_APPLICATION_ERROR_REGISTRY,
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
      applicationErrorContract: {
        name: string;
        registryVersion: number;
        resourceUri: string;
        revision: string;
        size: number;
        wireLocation: string;
        fallbackCode: string;
        codeSetPolicy: string;
        clientUnknownCodePolicy: string;
        messages: string;
        details: string;
        sdkInputErrors: string;
      };
      assetIdentityContract: {
        name: string;
        version: number;
        idFormat: string;
        clientTreatment: string;
        scope: string;
        coveredKinds: string[];
        registryFormat: string;
        registryFormatVersion: number;
        restartPersistence: string;
        initialAssignment: string;
        samePathContinuity: string;
        resolutionOrder: string;
        renameContinuity: string;
        renameEvidence: string;
        registeredPathSwap: string;
        weakIdentityEvidence: string;
        unobservedHardlinkThenOldPathRemoved:
          string;
        contentEquality: string;
        unmatchedOrCrossFilesystemMove:
          string;
        corruptionPolicy: string;
        loadLimitPolicy: string;
        mutationLimitPolicy: string;
        registryLossPolicy: string;
        crashDurability: string;
        readOnlyToolEffect: string;
        identityPersistenceBoundary: string;
      };
      checkpointCapabilities: {
        automaticBeforeWrite: boolean;
        startupPreparedReconciliation: boolean;
        preparedCreateExactMatch: string;
        boundedListing: boolean;
        exactByteRestoreKernel: boolean;
        previewAndApplyRestore: boolean;
        restoreScope: string;
        restoresReferencedDependencies: boolean;
        prune: {
          scope: string;
          workflow: string;
          expectedRevision: string;
          lockOrder: string;
          commitPoint: string;
          garbageCollection: string;
          preparedCheckpoints: string;
          automaticRetention: string;
          tombstones: boolean;
        };
        pruneBatch: {
          scope: string;
          minCheckpointCount: number;
          maxCheckpointCount: number;
          workflow: string;
          ordering: string;
          lockOrder: string;
          preflight: string;
          commitMode: string;
          atomic: boolean;
          stopOnFirstFailure: boolean;
          partialResult: string;
          garbageCollection: string;
          storedBeforeValidation: string;
          automaticSelection: string;
          tombstones: boolean;
        };
        storagePolicy:
          typeof CHECKPOINT_STORAGE_POLICY & {
            maxBytes: number;
            maxEntries: number;
            garbageCollectionTrigger: string;
            quotaFailureCode: string;
          };
      };
      mapCreationCapabilities: {
        profile: string;
        mapFormatVersion: string;
        tiledCompatibilityBaseline: string;
        commitMode: string;
        approvalBoundary: string;
        destinationPrecondition: string;
        contentEquality: string;
        parentDirectory: string;
        retrySemantics: string;
        failedAttemptCheckpoint: string;
        atomicPromotion: string;
        checkpointBeforeState: string;
        checkpointRestore: string;
      };
      mapOperations: string[];
      mapResizeCapabilities: {
        offsetUnit: string;
        offsetMeaning: string;
        cellMapping: string;
        tileLayerRequirement: string;
        croppedGidValidation: string;
        objectPolicy: string;
        outOfBoundsObjectMetric: string;
        templateObjects: string;
        imageLayerPolicy: string;
        groupLayerPolicy: string;
        idCounters: string;
        operationOrdering: string;
        sourcePatch: string;
      };
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
        polygonAndPolylinePoints: {
          coordinateSpace: string;
          polygonMinimum: number;
          polylineMinimum: number;
          maximum: number;
          maximumPerChangeSet: number;
          order: string;
          polygonClosure: string;
          polylineClosure: string;
        };
        polygonAndPolylineUpdates: string;
        textObject:
          typeof EXPECTED_TEXT_OBJECT_CAPABILITIES;
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
      tileRenderCapabilities: {
        locator: string;
        renderProfile: string;
        atlasProfile: string;
        supportedFormats: string[];
        selection: string;
        localIdOrder: string;
        duplicateLocalIds: string;
        selectionReduction: string;
        layout: string;
        columnsSemantics: string;
        labels: string;
        defaultColumns: number;
        defaultScale: number;
        revisionPins: string;
        animation: boolean;
        wangGrouping: boolean;
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
        highlightRectangles: {
          coordinateSpace: string;
          maxRectangles: number;
          intersectionPolicy: string;
          style: string;
          color: {
            r: number;
            g: number;
            b: number;
            a: number;
          };
          blendMode: string;
          overlapMode: string;
          border: string;
          drawOrder: string;
          workBudget: string;
        };
        reportsOmittedVisibleLayers: boolean;
      };
      limits: {
        maxCreateMapDimension: number;
        maxCreateMapTileEdge: number;
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
        maxTileRenderLocalIds: number;
        maxTileRenderColumns: number;
        maxTileRenderScale: number;
        maxTileRenderBytes: number;
        maxTileRenderEdge: number;
        maxTileRenderPixels: number;
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
        maxResizeMapDimension: number;
        maxResizeOffsetMagnitude: number;
        maxResizeSourceCellScans: number;
        maxResizeCroppedCellSample: number;
        maxPendingObjectShapePoints: number;
        maxPendingTextObjectPayloadBytes: number;
        maxCreateTileLayerCells: number;
        maxLayerNameLength: number;
        maxNativePreviewBytes: number;
        maxNativePreviewEdge: number;
        maxNativePreviewPixels: number;
        maxNativePreviewScale: number;
        maxNativePreviewHighlights: number;
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
      filesystemThreatModelContract:
        typeof TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT;
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
        direct: [
          GUIDE_RESOURCE_URI,
          APPLICATION_ERROR_RESOURCE_URI,
        ],
        templates: [],
        subscriptions: false,
        listChanged: true,
      },
      applicationErrorContract: {
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
        fallbackCode: "INTERNAL_ERROR",
        codeSetPolicy:
          "new-server-versions-may-add-codes",
        clientUnknownCodePolicy:
          "handle-as-unknown-and-refresh-discovery",
        messages:
          "bounded-human-readable-not-stable-for-control-flow",
        details:
          "bounded-opaque-no-stable-fields-in-v1",
        sdkInputErrors:
          "excluded-sdk-owned-text-only",
      },
      assetIdentityContract: {
        name: "tiled-mcp-asset-identity",
        version: 2,
        idFormat:
          "asset_<24-lowercase-hex>",
        clientTreatment: "opaque",
        scope: "configured-project-root",
        coveredKinds: [
          "external-tileset",
          "image-layer",
        ],
        registryFormat:
          "tiled-mcp-asset-registry",
        registryFormatVersion: 1,
        restartPersistence:
          "same-project-internal-state",
        initialAssignment:
          "legacy-path-hash-compatible",
        samePathContinuity:
          "preserve-across-content-replacement",
        resolutionOrder:
          "same-kind-canonical-path-before-file-identity",
        renameContinuity:
          "best-effort-unique-stable-file-identity",
        renameEvidence:
          "unique-same-kind-device-inode-nonzero-birthtime-old-path-absent",
        registeredPathSwap:
          "keep-path-ids-refresh-identity",
        weakIdentityEvidence:
          "inode-zero-or-birthtime-zero-does-not-rebind",
        unobservedHardlinkThenOldPathRemoved:
          "indistinguishable-from-rename-may-inherit-old-id",
        contentEquality: "not-identity",
        unmatchedOrCrossFilesystemMove:
          "allocate-new-id",
        corruptionPolicy:
          "startup-fatal-runtime-application-error-fail-closed",
        loadLimitPolicy:
          "startup-fatal-as-corrupt",
        mutationLimitPolicy:
          "runtime-application-error-fail-closed",
        registryLossPolicy:
          "ids-may-be-reassigned",
        crashDurability:
          "not-guaranteed-first-internal-directory-parent-not-fsynced",
        readOnlyToolEffect: "none",
        identityPersistenceBoundary:
          "write-tool-paths-only-reads-and-previews-resolve-lock-free",
      },
      checkpointCapabilities: {
        automaticBeforeWrite: true,
        startupPreparedReconciliation: true,
        preparedCreateExactMatch:
          "conflict-provenance-ambiguous",
        boundedListing: true,
        exactByteRestoreKernel: true,
        previewAndApplyRestore: true,
        restoreScope: "single-existing-json-document",
        restoresReferencedDependencies: false,
        preparedDiscard: {
          scope:
            "single-explicit-prepared-checkpoint",
          workflow: "preview-then-apply",
          eligibility:
            "current-target-equals-checkpoint-before-state",
          existingFileEligibility:
            "target-raw-revision-and-size-equal-before",
          createEligibility: "target-missing",
          expectedRevision:
            "sha256-of-raw-manifest-bytes",
          targetObservationCas:
            "required-at-apply",
          lockOrder:
            "target-then-checkpoint-store",
          commitPoint:
            "manifest-unlink-then-checkpoint-directory-fsync",
          garbageCollection:
            "post-commit-fail-closed-unreferenced-objects-and-private-crash-temporaries",
          storedBeforeValidation:
            "not-read-for-discard",
          operatorForcedCommit:
            "dedicated-prepared-adjudication-workflow",
          forceAbandon:
            "dedicated-prepared-adjudication-workflow",
          automaticDeletion: "never",
          projectAssetMutation: false,
          tombstones: false,
        },
        preparedAdjudication: {
          scope:
            "single-explicit-ambiguous-prepared-checkpoint",
          workflow:
            "separate-commit-or-abandon-preview-then-apply",
          genericForceBoolean: "unsupported",
          supportedConflicts: [
            "create-target-matches-after",
            "create-target-unrelated",
            "existing-target-missing",
            "existing-target-unrelated",
          ],
          commitEligibility:
            "create-target-matches-after-only",
          abandonEligibility:
            "ambiguous-conflict-only-machine-reconcilable-states-rejected",
          expectedRevision:
            "action-domain-separated-sha256-of-full-manifest-and-target-evidence",
          targetObservationCas:
            "required-at-apply",
          manifestCas:
            "raw-bytes-and-full-semantic-metadata",
          lockOrder:
            "target-then-checkpoint-store",
          commitPoint:
            "prepared-to-committed-atomic-manifest-rename",
          commitDurability:
            "checkpoint-directory-fsync-after-rename",
          commitPostPointFailure:
            "bounded-success-durability-unconfirmed-without-garbage-collection",
          abandonPoint:
            "prepared-manifest-unlink",
          abandonDurability:
            "checkpoint-directory-fsync-after-unlink",
          abandonPostPointFailure:
            "bounded-success-manifest-deleted-with-fail-closed-garbage-collection",
          abandonGarbageCollection:
            "post-commit-fail-closed-unreferenced-objects-and-private-crash-temporaries",
          projectAssetMutation: false,
          standingApproval: false,
          tombstones: false,
        },
        prune: {
          scope:
            "single-explicit-committed-checkpoint",
          workflow: "preview-then-apply",
          expectedRevision:
            "sha256-of-raw-manifest-bytes",
          lockOrder:
            "target-then-checkpoint-store",
          commitPoint:
            "manifest-unlink-then-checkpoint-directory-fsync",
          garbageCollection:
            "post-commit-fail-closed-unreferenced-objects-and-private-crash-temporaries",
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
        storagePolicy: {
          ...CHECKPOINT_STORAGE_POLICY,
          maxBytes:
            DEFAULT_CHECKPOINT_STORAGE_BYTES,
          maxEntries:
            MAX_CHECKPOINT_OBSERVED_ENTRIES,
          garbageCollectionTrigger:
            "quota-pressure-approved-checkpoint-prune-approved-prepared-discard-approved-prepared-abandon-automatic-rolling-post-commit-or-explicit-internal-call",
          quotaFailureCode:
            "CHECKPOINT_QUOTA_EXCEEDED",
        },
      },
      mapCreationCapabilities: {
        profile:
          "finite-orthogonal-empty-tmj",
        mapFormatVersion: "1.10",
        tiledCompatibilityBaseline:
          "1.12.2",
        commitMode:
          "direct-additive-no-preview-no-replace",
        approvalBoundary:
          "client-tool-call",
        destinationPrecondition:
          "must-not-exist",
        contentEquality:
          "existing-identical-bytes-still-file-already-exists",
        parentDirectory:
          "must-already-exist",
        retrySemantics:
          "non-idempotent-reinspect-target-before-retry",
        failedAttemptCheckpoint:
          "may-remain-prepared",
        atomicPromotion:
          "same-directory-hard-link-no-replace",
        checkpointBeforeState:
          "existed-false",
        checkpointRestore:
          "revert-would-delete-not-supported",
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
      tileRenderCapabilities: {
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
        overlays: [
          "grid",
          "coordinates",
          "highlights",
          "objectIds",
          "tileObjectCollision",
        ],
        regionCoordinates: "absolute-map-tiles",
        highlightRectangles: {
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
        reportsOmittedVisibleLayers: true,
      },
      limits: {
        maxCreateMapDimension: 100_000,
        maxCreateMapTileEdge: 16_384,
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
        maxTileRenderLocalIds: 64,
        maxTileRenderColumns: 32,
        maxTileRenderScale: 4,
        maxTileRenderBytes: 8 * 1024 * 1024,
        maxTileRenderEdge: 2_048,
        maxTileRenderPixels: 1_500_000,
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
        maxResizeMapDimension: 100_000,
        maxResizeOffsetMagnitude: 100_000,
        maxResizeSourceCellScans: 1_000_000,
        maxResizeCroppedCellSample: 16,
        maxPendingObjectShapePoints: 65_536,
        maxPendingTextObjectPayloadBytes:
          2_097_152,
        maxCreateTileLayerCells: 100_000,
        maxLayerNameLength: 1_024,
        maxNativePreviewBytes: 8 * 1024 * 1024,
        maxNativePreviewEdge: 2_048,
        maxNativePreviewPixels: 1_500_000,
        maxNativePreviewScale: 4,
        maxNativePreviewHighlights: 64,
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
      filesystemThreatModelContract:
        TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT,
      cli: {
        tiled: { available: false },
        rasterizer: { available: false },
      },
    });
    expect(capabilities.objectShapeCapabilities).toEqual({
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
    expect(
      Object.keys(capabilities.safetyStatus),
    ).toEqual([
      "jsonLexicalPreservation",
    ]);

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
      dependencyRevisions:
        Record<string, string>;
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

    const objectDetails = resultOf<{
      mapPath: string;
      revision: string;
      dependencyRevisions:
        Record<string, string>;
      object: Record<string, unknown>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_object",
        arguments: {
          mapPath: MAP_PATH,
          objectId: RECTANGLE_OBJECT_ID,
        },
      }),
    );
    expect(objectDetails).toEqual({
      mapPath: MAP_PATH,
      revision: summary.revision,
      dependencyRevisions:
        objects.dependencyRevisions,
      object: {
        id: RECTANGLE_OBJECT_ID,
        layerId: OBJECT_LAYER_ID,
        layerName: "Objects",
        name: "Crate",
        className: "",
        shape: "rectangle",
        x: 4,
        y: 5,
        width: 8,
        height: 9,
        rotation: 0,
        visible: true,
        opacity: 1,
        properties: [],
        propertyCount: 0,
      },
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

  it("renders an explicit sparse tile selection in input order without page metadata", async () => {
    const summary = resultOf<{
      revision: string;
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
    const tileset = summary.tilesets[0];
    expect(tileset).toBeDefined();

    const localIds = [3, 0, 2];
    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_render_tiles",
        arguments: {
          mapPath: MAP_PATH,
          tilesetAssetId: tileset?.assetId,
          localIds,
          columns: 2,
          scale: 2,
          expectedMapRevision:
            summary.revision,
          expectedTilesetRevision:
            tileset?.revision,
        },
      }),
    );
    expect(response.isError).not.toBe(true);
    expect(
      response.content.map((block) => block.type),
    ).toEqual(["text", "image"]);
    const imageBlock = response.content[1];
    expect(imageBlock).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: expect.any(String),
    });
    const png = Buffer.from(
      imageBlock?.data ?? "",
      "base64",
    );
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a,
        0x1a, 0x0a,
      ]),
    );
    expect(
      textSummaryOf(response, true).image,
    ).toEqual({
      mimeType: "image/png",
      bytes: png.byteLength,
    });

    const result = (
      response.structuredContent as {
        result: {
          mimeType: string;
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
          image: {
            path: string;
            revision: string;
            format: string;
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
    expect(result).toMatchObject({
      mimeType: "image/png",
      byteLength: png.byteLength,
      sha256: revisionOf(png),
      map: {
        path: MAP_PATH,
        revision: summary.revision,
      },
      source: {
        assetId: tileset?.assetId,
        revision: tileset?.revision,
      },
      image: {
        path: "tiles/terrain.png",
        revision: expect.stringMatching(
          /^sha256:[0-9a-f]{64}$/u,
        ),
        format: "png",
      },
      renderProfile:
        "explicit-local-id-atlas-selection-v1",
      selection: {
        localIds,
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
    expect(result).not.toHaveProperty("page");

    const defaults = resultOf<{
      selection: {
        localIds: number[];
        layout: {
          requestedColumns: number;
          columns: number;
          rows: number;
          adjusted: boolean;
        };
      };
      scale: number;
    }>(
      await harness.client.callTool({
        name: "tiled_render_tiles",
        arguments: {
          mapPath: MAP_PATH,
          tilesetAssetId: tileset?.assetId,
          localIds: [1],
        },
      }),
    );
    expect(defaults).toMatchObject({
      selection: {
        localIds: [1],
        layout: {
          requestedColumns: 8,
          columns: 1,
          rows: 1,
          adjusted: false,
        },
      },
      scale: 2,
    });
  });

  it("rejects forged tile render cross-field relationships at the runtime output boundary", async () => {
    const summary = resultOf<{
      tilesets: Array<{
        assetId: string;
      }>;
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
        name: "tiled_render_tiles",
        arguments: {
          mapPath: MAP_PATH,
          tilesetAssetId: tileset?.assetId,
          localIds: [3, 0, 2],
          columns: 2,
          scale: 2,
        },
      }),
    );
    expect(response.isError).not.toBe(true);
    expect(
      tileRenderToolOutputSchema.safeParse(
        response.structuredContent,
      ).success,
    ).toBe(true);
    if (response.structuredContent === undefined) {
      throw new Error(
        "Expected structured tile render output.",
      );
    }

    type MutableTileRenderEnvelope = {
      result: {
        pixelSize: {
          width: number;
          height: number;
        };
        tileset: {
          tileCount: number;
        };
        selection: {
          localIds: number[];
          count: number;
          layout: {
            requestedColumns: number;
            columns: number;
            rows: number;
            adjusted: boolean;
          };
          forgedExtra?: boolean;
        };
      };
    };
    const forge = (
      mutate: (
        result:
          MutableTileRenderEnvelope["result"],
      ) => void,
    ): MutableTileRenderEnvelope => {
      const candidate = structuredClone(
        response.structuredContent,
      ) as unknown as MutableTileRenderEnvelope;
      mutate(candidate.result);
      return candidate;
    };

    const forgedOutputs = [
      [
        "duplicate local IDs",
        forge((candidate) => {
          candidate.selection.localIds = [
            3, 3, 2,
          ];
        }),
      ],
      [
        "count mismatch",
        forge((candidate) => {
          candidate.selection.count = 2;
        }),
      ],
      [
        "row mismatch",
        forge((candidate) => {
          candidate.selection.layout.rows = 1;
        }),
      ],
      [
        "adjusted explicit columns",
        forge((candidate) => {
          candidate.selection.layout.requestedColumns =
            7;
          candidate.selection.layout.columns = 2;
          candidate.selection.layout.rows = 2;
          candidate.selection.layout.adjusted = true;
        }),
      ],
      [
        "out-of-range local ID",
        forge((candidate) => {
          candidate.selection.localIds[0] =
            candidate.tileset.tileCount;
        }),
      ],
      [
        "pixel product overflow",
        forge((candidate) => {
          candidate.pixelSize = {
            width: 2_048,
            height: 2_048,
          };
        }),
      ],
      [
        "unknown selection field",
        forge((candidate) => {
          candidate.selection.forgedExtra = true;
        }),
      ],
    ] as const;
    for (const [name, candidate] of forgedOutputs) {
      expect(
        tileRenderToolOutputSchema.safeParse(
          candidate,
        ).success,
        name,
      ).toBe(false);
    }
  });

  it.each([
    {
      name: "empty local ID selection",
      localIds: [] as number[],
    },
    {
      name: "duplicate local IDs",
      localIds: [1, 1],
    },
    {
      name: "more than 64 local IDs",
      localIds: Array.from(
        { length: 65 },
        (_, index) => index,
      ),
    },
  ])(
    "rejects a tile render $name at the strict input boundary",
    async ({ localIds }) => {
      const response = asToolResponse(
        await harness.client.callTool({
          name: "tiled_render_tiles",
          arguments: {
            mapPath: MAP_PATH,
            tilesetAssetId: "asset_input_only",
            localIds,
          },
        }),
      );
      expect(response.isError).toBe(true);
      expect(
        response.structuredContent,
      ).toBeUndefined();
      expect(
        response.content.every(
          (block) => block.type !== "image",
        ),
      ).toBe(true);
      expect(response.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(
            "Input validation error",
          ),
        }),
      ]);
    },
  );

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
          overlays: {
            grid: true,
            coordinates: true,
            highlights: [
              { x: 0, y: 0, width: 2, height: 2 },
              { x: 1, y: 1, width: 2, height: 2 },
            ],
          },
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
          overlays: {
            grid: boolean;
            coordinates: boolean;
            highlights: {
              style: string;
              entries: Array<{
                sourceIndex: number;
                requestedTileRect: {
                  x: number;
                  y: number;
                  width: number;
                  height: number;
                };
                renderedTileRect: {
                  x: number;
                  y: number;
                  width: number;
                  height: number;
                };
                clipped: boolean;
              }>;
              highlightedTileCount: number;
              color: {
                r: number;
                g: number;
                b: number;
                a: number;
              };
              blendMode: string;
              overlapMode: string;
            };
          };
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
      omittedLayers: [],
      omittedLayerCount: 0,
      omittedLayersTruncated: false,
      partial: false,
      objectLayers: [
        expect.objectContaining({
          id: OBJECT_LAYER_ID,
        }),
      ],
      objectLayerRendering:
        expect.objectContaining({
          profile: "base-object-layers-v1",
        }),
      snapshotConsistency: "non-atomic-read-set",
      overlays: {
        grid: true,
        coordinates: true,
        highlights: {
          style: "selection-amber-v1",
          entries: [
            {
              sourceIndex: 0,
              requestedTileRect: {
                x: 0,
                y: 0,
                width: 2,
                height: 2,
              },
              renderedTileRect: {
                x: 0,
                y: 0,
                width: 2,
                height: 2,
              },
              clipped: false,
            },
            {
              sourceIndex: 1,
              requestedTileRect: {
                x: 1,
                y: 1,
                width: 2,
                height: 2,
              },
              renderedTileRect: {
                x: 1,
                y: 1,
                width: 1,
                height: 1,
              },
              clipped: true,
            },
          ],
          highlightedTileCount: 4,
          color: { r: 250, g: 204, b: 21, a: 96 },
          blendMode: "source-over",
          overlapMode: "tile-union",
        },
      },
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
          layerIds: [999],
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
          code: "LAYER_NOT_FOUND",
          details: { layerId: 999 },
        },
      },
    });
  });

  it("rejects a native preview highlight outside the effective tile region without image content", async () => {
    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_render_preview",
        arguments: {
          mapPath: MAP_PATH,
          region: {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
          },
          overlays: {
            highlights: [
              {
                x: 1,
                y: 1,
                width: 1,
                height: 1,
              },
            ],
          },
        },
      }),
    );
    expect(response.isError).toBe(true);
    expect(
      response.content.every(
        (block) => block.type !== "image",
      ),
    ).toBe(true);
    expect(response.structuredContent).toMatchObject({
      result: {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          details: {
            sourceIndex: 0,
            tileRegion: {
              x: 0,
              y: 0,
              width: 1,
              height: 1,
            },
          },
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

  it("rejects unknown checkpoint prune preview keys through its strict schema", async () => {
    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_preview_checkpoint_prune",
        arguments: {
          checkpointId: "00000000-0000-4000-8000-000000000000",
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

  it("keeps checkpoint prune batch shape errors in the SDK and normalized duplicates in the application protocol", async () => {
    const firstId =
      "aaaaaaaa-0000-4000-8000-000000000001";
    const unknownKey = asToolResponse(
      await harness.client.callTool({
        name:
          "tiled_preview_checkpoint_prune_batch",
        arguments: {
          checkpointIds: [
            firstId,
            "bbbbbbbb-0000-4000-8000-000000000002",
          ],
          unexpected: true,
        },
      }),
    );

    expect(unknownKey.isError).toBe(true);
    expect(
      unknownKey.structuredContent,
    ).toBeUndefined();
    expect(unknownKey.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining(
          "Input validation error",
        ),
      }),
    ]);

    const duplicate = asToolResponse(
      await harness.client.callTool({
        name:
          "tiled_preview_checkpoint_prune_batch",
        arguments: {
          checkpointIds: [
            firstId,
            firstId.toUpperCase(),
          ],
        },
      }),
    );
    expect(duplicate.isError).toBe(true);
    expect(
      duplicate.structuredContent,
    ).toMatchObject({
      result: {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: expect.stringContaining(
            "duplicate UUIDs",
          ),
        },
      },
    });
  });

  it("rejects unknown prepared checkpoint discard preview keys through its strict schema", async () => {
    const response = asToolResponse(
      await harness.client.callTool({
        name: "tiled_preview_prepared_checkpoint_discard",
        arguments: {
          checkpointId: "00000000-0000-4000-8000-000000000000",
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

  it("previews without writing, then applies once and replays the cached result without re-reading changed disk state", async () => {
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

    const readSnapshot = vi.spyOn(
      harness.store,
      "readSnapshot",
    );
    const commitBytes = vi.spyOn(
      harness.store,
      "commitBytes",
    );
    await writeFile(absoluteMapPath, before);

    const secondApply = await harness.client.callTool({
      name: "tiled_apply_change_set",
      arguments: {
        changeSetId: preview.changeSetId,
        expectedRevision: preview.expectedRevision,
      },
    });
    expect(secondApply).toEqual(firstApply);
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(commitBytes).not.toHaveBeenCalled();
    expect(await readFile(absoluteMapPath)).toEqual(
      before,
    );
    readSnapshot.mockRestore();
    commitBytes.mockRestore();

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

  it("previews, applies and idempotently replays a committed checkpoint prune", async () => {
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const before = await readFile(absoluteMapPath);
    const proposed = Buffer.concat([
      before,
      Buffer.from(" "),
    ]);
    const committed = await harness.store.commitBytes(
      MAP_PATH,
      revisionOf(before),
      proposed,
      "server prune integration",
    );
    expect(committed.checkpointId).not.toBeNull();
    const checkpointId = committed.checkpointId;
    if (checkpointId === null) {
      throw new Error(
        "Expected the changing commit to create a checkpoint.",
      );
    }

    const preview = resultOf<{
      kind: string;
      changeSetId: string;
      planDigest: string;
      targetPath: string;
      expectedRevision: string;
      checkpoint: {
        id: string;
        status: string;
        path: string;
        before: {
          existed: boolean;
          revision: string;
          objectHash: string;
          size: number;
        };
        afterRevision: string;
      };
      manifest: {
        revision: string;
        size: number;
      };
      operations: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    }>(
      await harness.client.callTool({
        name: "tiled_preview_checkpoint_prune",
        arguments: { checkpointId },
      }),
    );
    expect(preview).toMatchObject({
      kind: "checkpointPrune",
      changeSetId: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      planDigest: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      targetPath: MAP_PATH,
      expectedRevision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
      checkpoint: {
        id: checkpointId,
        status: "committed",
        path: MAP_PATH,
        before: {
          existed: true,
          revision: revisionOf(before),
          objectHash: revisionOf(before).slice(
            "sha256:".length,
          ),
          size: before.byteLength,
        },
        afterRevision: revisionOf(proposed),
      },
      manifest: {
        revision: expect.stringMatching(
          /^sha256:[0-9a-f]{64}$/u,
        ),
        size: expect.any(Number),
      },
      operations: [
        {
          type: "pruneCheckpoint",
          destructive: true,
          checkpointId,
          targetPath: MAP_PATH,
          status: "committed",
          manifestRevision:
            preview.expectedRevision,
          manifestBytes:
            preview.manifest.size,
          removesRecoveryPoint: true,
          removesProjectAsset: false,
          garbageCollection:
            "fail-closed-after-manifest-prune",
          warning: expect.stringContaining(
            "permanently removes",
          ),
        },
      ],
      summary: {
        operationCount: 1,
        destructive: true,
        checkpointId,
        targetPath: MAP_PATH,
        status: "committed",
        manifestRevision:
          preview.expectedRevision,
        manifestBytes: preview.manifest.size,
        removesRecoveryPoint: true,
        removesProjectAsset: false,
        garbageCollection:
          "fail-closed-after-manifest-prune",
        warning: expect.stringContaining(
          "permanently removes",
        ),
      },
    });
    expect(preview.manifest.revision).toBe(
      preview.expectedRevision,
    );
    expect(await readFile(absoluteMapPath)).toEqual(
      proposed,
    );

    const firstApply =
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision:
            preview.expectedRevision,
        },
      });
    const applied = resultOf<{
      kind: string;
      changeSetId: string;
      checkpoint: {
        id: string;
        path: string;
        status: string;
      };
      manifestDeleted: boolean;
      garbageCollection: {
        status: string;
        deletedObjects: number;
        blockerCount: number;
        blockers: unknown[];
        blockersTruncated: boolean;
      };
    }>(firstApply);
    expect(applied).toMatchObject({
      kind: "checkpointPrune",
      changeSetId: preview.changeSetId,
      checkpoint: {
        id: checkpointId,
        path: MAP_PATH,
        status: "committed",
      },
      manifestDeleted: true,
      garbageCollection: {
        status: "completed",
        deletedObjects: 1,
        blockerCount: 0,
        blockers: [],
        blockersTruncated: false,
      },
    });
    expect(await readFile(absoluteMapPath)).toEqual(
      proposed,
    );
    expect(
      (
        await harness.store.checkpoints.list()
      ).manifests,
    ).toEqual([]);

    const secondApply =
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision:
            preview.expectedRevision,
        },
      });
    expect(secondApply).toEqual(firstApply);
  });

  it("previews, applies and caches an explicit canonical committed-checkpoint prune batch", async () => {
    const absoluteMapPath = join(
      harness.root,
      MAP_PATH,
    );
    const before = await readFile(
      absoluteMapPath,
    );
    const middle = Buffer.concat([
      before,
      Buffer.from(" "),
    ]);
    const after = Buffer.concat([
      middle,
      Buffer.from(" "),
    ]);
    const firstCommit =
      await harness.store.commitBytes(
        MAP_PATH,
        revisionOf(before),
        middle,
        "server batch prune first",
      );
    const secondCommit =
      await harness.store.commitBytes(
        MAP_PATH,
        revisionOf(middle),
        after,
        "server batch prune second",
      );
    if (
      firstCommit.checkpointId === null ||
      secondCommit.checkpointId === null
    ) {
      throw new Error(
        "Expected two committed checkpoints.",
      );
    }
    const orderedIds = [
      firstCommit.checkpointId,
      secondCommit.checkpointId,
    ].sort();

    const preview = resultOf<{
      kind: string;
      changeSetId: string;
      planDigest: string;
      expectedRevision: string;
      targetPaths: string[];
      snapshotConsistency: string;
      checkpoints: Array<{
        id: string;
        version: number;
        path: string;
        manifest: {
          revision: string;
          size: number;
        };
      }>;
      operations: Array<{
        type: string;
        checkpointIds: string[];
        checkpointCount: number;
        atomic: boolean;
        stopOnFirstFailure: boolean;
        partialResult: string;
      }>;
      summary: {
        checkpointIds: string[];
        checkpointCount: number;
        targetPaths: string[];
        manifestBytes: number;
      };
    }>(
      await harness.client.callTool({
        name:
          "tiled_preview_checkpoint_prune_batch",
        arguments: {
          checkpointIds: [
            secondCommit.checkpointId.toUpperCase(),
            firstCommit.checkpointId.toUpperCase(),
          ],
        },
      }),
    );

    expect(preview).toMatchObject({
      kind: "checkpointPruneBatch",
      changeSetId: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      planDigest: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      expectedRevision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
      targetPaths: [MAP_PATH],
      snapshotConsistency:
        "checkpoint-store-locked-manifest-set",
      checkpoints: orderedIds.map(
        (id) => ({
          id,
          version: 1,
          path: MAP_PATH,
          manifest: {
            revision: expect.stringMatching(
              /^sha256:[0-9a-f]{64}$/u,
            ),
            size: expect.any(Number),
          },
        }),
      ),
      operations: [
        {
          type: "pruneCheckpointBatch",
          checkpointIds: orderedIds,
          checkpointCount: 2,
          atomic: false,
          stopOnFirstFailure: true,
          partialResult:
            "cached-final-no-resume",
        },
      ],
      summary: {
        checkpointIds: orderedIds,
        checkpointCount: 2,
        targetPaths: [MAP_PATH],
      },
    });
    expect(
      preview.summary.manifestBytes,
    ).toBe(
      preview.checkpoints.reduce(
        (total, checkpoint) =>
          total + checkpoint.manifest.size,
        0,
      ),
    );
    expect(
      await readFile(absoluteMapPath),
    ).toEqual(after);

    const firstApply =
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision:
            preview.expectedRevision,
        },
      });
    const applied = resultOf<{
      kind: string;
      changeSetId: string;
      status: string;
      replayDisposition: string;
      requestedCheckpointCount: number;
      manifestDeletedCount: number;
      unresolvedCheckpointCount: number;
      outcomes: Array<{
        checkpointId: string;
        path: string;
        outcome: string;
        manifestDeleted: boolean;
        durability: string;
      }>;
      garbageCollection: {
        status: string;
      };
    }>(firstApply);
    expect(applied).toMatchObject({
      kind: "checkpointPruneBatch",
      changeSetId: preview.changeSetId,
      status: "completed",
      replayDisposition:
        "cached-final-no-resume",
      requestedCheckpointCount: 2,
      manifestDeletedCount: 2,
      unresolvedCheckpointCount: 0,
      outcomes: orderedIds.map(
        (checkpointId) => ({
          checkpointId,
          path: MAP_PATH,
          outcome: "deleted",
          manifestDeleted: true,
          durability: "confirmed",
        }),
      ),
      garbageCollection: {
        status: "completed",
      },
    });
    const replay =
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision:
            preview.expectedRevision,
        },
      });
    expect(replay).toEqual(firstApply);
    expect(
      await readFile(absoluteMapPath),
    ).toEqual(after);
  });

  it("returns and exactly replays a final partial checkpoint prune batch without resuming remaining deletions", async () => {
    let postDeleteObserverCalls = 0;
    const originalHarness = harness;
    harness = await createHarness({
      checkpointOptions: {
        observer: {
          afterManifestDeletedBeforeGarbageCollection() {
            postDeleteObserverCalls += 1;
            throw new Error(
              "Injected stop after the first batch manifest deletion.",
            );
          },
        },
      },
    });
    await originalHarness.client
      .close()
      .catch(() => undefined);
    await originalHarness.server
      .close()
      .catch(() => undefined);
    await rm(originalHarness.root, {
      recursive: true,
      force: true,
    });

    const absoluteMapPath = join(
      harness.root,
      MAP_PATH,
    );
    const before = await readFile(
      absoluteMapPath,
    );
    const middle = Buffer.concat([
      before,
      Buffer.from(" "),
    ]);
    const after = Buffer.concat([
      middle,
      Buffer.from(" "),
    ]);
    const firstCommit =
      await harness.store.commitBytes(
        MAP_PATH,
        revisionOf(before),
        middle,
        "server partial batch prune first",
      );
    const secondCommit =
      await harness.store.commitBytes(
        MAP_PATH,
        revisionOf(middle),
        after,
        "server partial batch prune second",
      );
    if (
      firstCommit.checkpointId === null ||
      secondCommit.checkpointId === null
    ) {
      throw new Error(
        "Expected two committed checkpoints.",
      );
    }
    const orderedIds = [
      firstCommit.checkpointId,
      secondCommit.checkpointId,
    ].sort();
    const preview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
    }>(
      await harness.client.callTool({
        name:
          "tiled_preview_checkpoint_prune_batch",
        arguments: {
          checkpointIds: [
            secondCommit.checkpointId,
            firstCommit.checkpointId,
          ],
        },
      }),
    );

    const [
      firstApplyResponse,
      concurrentReplayResponse,
    ] = await Promise.all([
      harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision:
            preview.expectedRevision,
        },
      }),
      harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision:
            preview.expectedRevision,
        },
      }),
    ]);
    const firstApply = asToolResponse(
      firstApplyResponse,
    );
    const concurrentReplay = asToolResponse(
      concurrentReplayResponse,
    );
    expect(firstApply.isError).not.toBe(true);
    expect(concurrentReplay).toEqual(firstApply);
    const applied = resultOf<{
      kind: string;
      changeSetId: string;
      status: string;
      replayDisposition: string;
      requestedCheckpointCount: number;
      manifestDeletedCount: number;
      unresolvedCheckpointCount: number;
      outcomes: Array<Record<string, unknown>>;
      garbageCollection: {
        status: string;
        reason?: string;
      };
    }>(firstApply);
    expect(applied).toMatchObject({
      kind: "checkpointPruneBatch",
      changeSetId: preview.changeSetId,
      status: "partial",
      replayDisposition:
        "cached-final-no-resume",
      requestedCheckpointCount: 2,
      manifestDeletedCount: 1,
      unresolvedCheckpointCount: 1,
      garbageCollection: {
        status: "not-run",
        reason:
          "batch-stopped-before-garbage-collection",
      },
    });
    expect(applied.outcomes).toEqual([
      {
        checkpointId: orderedIds[0],
        path: MAP_PATH,
        outcome: "deleted",
        manifestDeleted: true,
        durability: "confirmed",
      },
      {
        checkpointId: orderedIds[1],
        path: MAP_PATH,
        outcome: "not-attempted",
        reason:
          "batch-stopped-before-checkpoint",
      },
    ]);
    expect(postDeleteObserverCalls).toBe(1);
    const remainingAfterFirstApply = (
      await harness.store.checkpoints.list()
    ).manifests
      .map(({ id }) => id)
      .sort();
    expect(remainingAfterFirstApply).toEqual([
      orderedIds[1],
    ]);

    const replay = asToolResponse(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision:
            preview.expectedRevision,
        },
      }),
    );
    expect(replay).toEqual(firstApply);
    expect(postDeleteObserverCalls).toBe(1);
    const remainingAfterReplay = (
      await harness.store.checkpoints.list()
    ).manifests
      .map(({ id }) => id)
      .sort();
    expect(remainingAfterReplay).toEqual(
      remainingAfterFirstApply,
    );
    expect(
      await readFile(absoluteMapPath),
    ).toEqual(after);
  });

  it("previews, applies and idempotently replays a current-before-verified prepared checkpoint discard", async () => {
    const absoluteMapPath = join(harness.root, MAP_PATH);
    const before = await readFile(absoluteMapPath);
    const proposed = Buffer.concat([
      before,
      Buffer.from(" "),
    ]);
    const prepared =
      await harness.store.checkpoints.prepare(
        MAP_PATH,
        before,
        revisionOf(proposed),
        "server prepared discard integration",
      );

    const preview = resultOf<{
      kind: string;
      changeSetId: string;
      planDigest: string;
      targetPath: string;
      expectedRevision: string;
      checkpoint: {
        id: string;
        status: string;
        path: string;
        before: {
          existed: boolean;
          revision: string;
          objectHash: string;
          size: number;
        };
        afterRevision: string;
      };
      manifest: {
        revision: string;
        size: number;
      };
      target: {
        existed: boolean;
        revision: string;
        size: number;
      };
      eligibility: string;
      operations: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    }>(
      await harness.client.callTool({
        name: "tiled_preview_prepared_checkpoint_discard",
        arguments: {
          checkpointId: prepared.id,
        },
      }),
    );
    expect(preview).toMatchObject({
      kind: "preparedCheckpointDiscard",
      changeSetId: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      planDigest: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      targetPath: MAP_PATH,
      expectedRevision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
      checkpoint: {
        id: prepared.id,
        status: "prepared",
        path: MAP_PATH,
        before: {
          existed: true,
          revision: revisionOf(before),
          objectHash: revisionOf(before).slice(
            "sha256:".length,
          ),
          size: before.byteLength,
        },
        afterRevision: revisionOf(proposed),
      },
      manifest: {
        revision: expect.stringMatching(
          /^sha256:[0-9a-f]{64}$/u,
        ),
        size: expect.any(Number),
      },
      target: {
        existed: true,
        revision: revisionOf(before),
        size: before.byteLength,
      },
      eligibility:
        "current-target-matches-before-state",
      operations: [
        {
          type: "discardPreparedCheckpoint",
          destructive: true,
          checkpointId: prepared.id,
          targetPath: MAP_PATH,
          status: "prepared",
          manifestRevision:
            preview.expectedRevision,
          manifestBytes:
            preview.manifest.size,
          removesRecoveryPoint: true,
          removesProjectAsset: false,
          targetBeforeStateVerified: true,
          garbageCollection:
            "fail-closed-after-prepared-manifest-discard",
          warning: expect.stringContaining(
            "pre-write state",
          ),
        },
      ],
      summary: {
        operationCount: 1,
        destructive: true,
        checkpointId: prepared.id,
        targetPath: MAP_PATH,
        status: "prepared",
        manifestRevision:
          preview.expectedRevision,
        manifestBytes: preview.manifest.size,
        removesRecoveryPoint: true,
        removesProjectAsset: false,
        targetBeforeStateVerified: true,
        garbageCollection:
          "fail-closed-after-prepared-manifest-discard",
        warning: expect.stringContaining(
          "pre-write state",
        ),
      },
    });
    expect(preview.manifest.revision).toBe(
      preview.expectedRevision,
    );
    expect(await readFile(absoluteMapPath)).toEqual(
      before,
    );

    const firstApply =
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision:
            preview.expectedRevision,
        },
      });
    const applied = resultOf<{
      kind: string;
      changeSetId: string;
      checkpoint: {
        id: string;
        path: string;
        status: string;
      };
      target: {
        existed: boolean;
        revision: string;
        size: number;
      };
      manifestDeleted: boolean;
      garbageCollection: {
        status: string;
        deletedObjects: number;
        blockerCount: number;
        blockers: unknown[];
        blockersTruncated: boolean;
      };
    }>(firstApply);
    expect(applied).toMatchObject({
      kind: "preparedCheckpointDiscard",
      changeSetId: preview.changeSetId,
      checkpoint: {
        id: prepared.id,
        path: MAP_PATH,
        status: "prepared",
      },
      target: {
        existed: true,
        revision: revisionOf(before),
        size: before.byteLength,
      },
      manifestDeleted: true,
      garbageCollection: {
        status: "completed",
        deletedObjects: 1,
        blockerCount: 0,
        blockers: [],
        blockersTruncated: false,
      },
    });
    expect(await readFile(absoluteMapPath)).toEqual(
      before,
    );
    expect(
      (
        await harness.store.checkpoints.list()
      ).manifests,
    ).toEqual([]);

    const secondApply =
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision:
            preview.expectedRevision,
        },
      });
    expect(secondApply).toEqual(firstApply);
  });

  it("previews and applies explicit prepared-checkpoint commit and abandon adjudications", async () => {
    const commitPath =
      "maps/ambiguous-create-commit.tmj";
    const commitAbsolute = join(
      harness.root,
      commitPath,
    );
    const committedTarget = Buffer.from(
      '{"type":"map","adjudication":"commit"}\n',
      "utf8",
    );
    const preparedCommit =
      await harness.store.checkpoints.prepare(
        commitPath,
        undefined,
        revisionOf(committedTarget),
        "server ambiguous commit",
      );
    await writeFile(
      commitAbsolute,
      committedTarget,
    );

    const commitPreview = resultOf<{
      kind: string;
      changeSetId: string;
      planDigest: string;
      targetPath: string;
      expectedRevision: string;
      checkpoint: {
        id: string;
        version: number;
        status: string;
        path: string;
        before: { existed: boolean };
        afterRevision: string;
      };
      manifest: {
        revision: string;
        size: number;
      };
      target: {
        existed: boolean;
        revision: string;
        size: number;
      };
      conflict: string;
      operations: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    }>(
      await harness.client.callTool({
        name: "tiled_preview_prepared_checkpoint_commit",
        arguments: {
          checkpointId: preparedCommit.id,
        },
      }),
    );
    expect(commitPreview).toMatchObject({
      kind: "preparedCheckpointCommit",
      changeSetId: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      planDigest: expect.stringMatching(
        /^changeset:[0-9a-f]{64}$/u,
      ),
      targetPath: commitPath,
      expectedRevision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
      checkpoint: {
        id: preparedCommit.id,
        version: 1,
        status: "prepared",
        path: commitPath,
        before: { existed: false },
        afterRevision:
          revisionOf(committedTarget),
      },
      manifest: {
        revision: expect.stringMatching(
          /^sha256:[0-9a-f]{64}$/u,
        ),
        size: expect.any(Number),
      },
      target: {
        existed: true,
        revision:
          revisionOf(committedTarget),
        size: committedTarget.byteLength,
      },
      conflict:
        "create-target-matches-after",
      operations: [
        {
          type: "commitPreparedCheckpoint",
          destructive: false,
          checkpointId: preparedCommit.id,
          targetPath: commitPath,
          status: "prepared",
          operatorDecisionRequired: true,
          commitsCheckpointRecord: true,
          projectAssetModified: false,
          garbageCollection: "not-run",
          warning: expect.stringContaining(
            "Operator decision required",
          ),
        },
      ],
      summary: {
        operationCount: 1,
        destructive: false,
        checkpointId: preparedCommit.id,
        targetPath: commitPath,
        status: "prepared",
        operatorDecisionRequired: true,
        commitsCheckpointRecord: true,
        projectAssetModified: false,
        garbageCollection: "not-run",
      },
    });
    expect(
      commitPreview.expectedRevision,
    ).not.toBe(
      commitPreview.manifest.revision,
    );
    expect(
      commitPreview.operations[0],
    ).toMatchObject({
      manifestRevision:
        commitPreview.manifest.revision,
      manifestBytes:
        commitPreview.manifest.size,
    });

    const committed = resultOf<{
      kind: string;
      changeSetId: string;
      checkpoint: {
        id: string;
        version: number;
        status: string;
      };
      previousStatus: string;
      target: {
        existed: boolean;
        revision: string;
        size: number;
      };
      conflict: string;
      manifestCommitted: boolean;
      projectAssetModified: boolean;
      durability: string;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId:
            commitPreview.changeSetId,
          expectedRevision:
            commitPreview.expectedRevision,
        },
      }),
    );
    expect(committed).toMatchObject({
      kind: "preparedCheckpointCommit",
      changeSetId:
        commitPreview.changeSetId,
      checkpoint: {
        id: preparedCommit.id,
        version: 1,
        status: "committed",
      },
      previousStatus: "prepared",
      target: {
        existed: true,
        revision:
          revisionOf(committedTarget),
        size: committedTarget.byteLength,
      },
      conflict:
        "create-target-matches-after",
      manifestCommitted: true,
      projectAssetModified: false,
      durability: "confirmed",
    });
    expect(
      await readFile(commitAbsolute),
    ).toEqual(committedTarget);

    const abandonPath =
      "maps/ambiguous-create-abandon.tmj";
    const abandonAbsolute = join(
      harness.root,
      abandonPath,
    );
    const intended = Buffer.from(
      '{"type":"map","intended":true}\n',
      "utf8",
    );
    const unrelated = Buffer.from(
      '{"type":"map","external":true}\n',
      "utf8",
    );
    const preparedAbandon =
      await harness.store.checkpoints.prepare(
        abandonPath,
        undefined,
        revisionOf(intended),
        "server ambiguous abandon",
      );
    await writeFile(
      abandonAbsolute,
      unrelated,
    );

    const abandonPreview = resultOf<{
      kind: string;
      changeSetId: string;
      expectedRevision: string;
      checkpoint: {
        id: string;
        version: number;
        status: string;
        before: { existed: boolean };
        afterRevision: string;
      };
      manifest: {
        revision: string;
        size: number;
      };
      target: {
        existed: boolean;
        revision: string;
        size: number;
      };
      conflict: string;
      operations: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    }>(
      await harness.client.callTool({
        name: "tiled_preview_prepared_checkpoint_abandon",
        arguments: {
          checkpointId: preparedAbandon.id,
        },
      }),
    );
    expect(abandonPreview).toMatchObject({
      kind: "preparedCheckpointAbandon",
      checkpoint: {
        id: preparedAbandon.id,
        version: 1,
        status: "prepared",
        before: { existed: false },
        afterRevision: revisionOf(intended),
      },
      target: {
        existed: true,
        revision: revisionOf(unrelated),
        size: unrelated.byteLength,
      },
      conflict: "create-target-unrelated",
      operations: [
        {
          type: "abandonPreparedCheckpoint",
          destructive: true,
          operatorDecisionRequired: true,
          removesRecoveryPoint: true,
          projectAssetModified: false,
          garbageCollection:
            "fail-closed-after-prepared-manifest-abandon",
          warning: expect.stringContaining(
            "permanently deletes",
          ),
        },
      ],
      summary: {
        operationCount: 1,
        destructive: true,
        operatorDecisionRequired: true,
        removesRecoveryPoint: true,
        projectAssetModified: false,
        garbageCollection:
          "fail-closed-after-prepared-manifest-abandon",
      },
    });
    expect(
      abandonPreview.expectedRevision,
    ).not.toBe(
      abandonPreview.manifest.revision,
    );
    expect(
      abandonPreview.expectedRevision,
    ).not.toBe(
      commitPreview.expectedRevision,
    );

    const abandoned = resultOf<{
      kind: string;
      changeSetId: string;
      checkpoint: {
        id: string;
        status: string;
      };
      conflict: string;
      manifestDeleted: boolean;
      projectAssetModified: boolean;
      garbageCollection: {
        status: string;
      };
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId:
            abandonPreview.changeSetId,
          expectedRevision:
            abandonPreview.expectedRevision,
        },
      }),
    );
    expect(abandoned).toMatchObject({
      kind: "preparedCheckpointAbandon",
      changeSetId:
        abandonPreview.changeSetId,
      checkpoint: {
        id: preparedAbandon.id,
        status: "prepared",
      },
      conflict: "create-target-unrelated",
      manifestDeleted: true,
      projectAssetModified: false,
      garbageCollection: {
        status: "completed",
      },
    });
    expect(
      await readFile(abandonAbsolute),
    ).toEqual(unrelated);
    await expect(
      harness.store.checkpoints.read(
        preparedAbandon.id,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_NOT_FOUND",
    });
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

  it("previews bounded object-local polygon and polyline points through closed schemas", async () => {
    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    const polygonPoints = [
      { x: 0, y: 0 },
      { x: 12.5, y: -4 },
      { x: 20, y: 8 },
    ];
    const polylinePoints = [
      { x: -2, y: 1 },
      { x: 0, y: 3 },
      { x: 9.5, y: 7 },
    ];

    const preview = resultOf<{
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
          expectedRevision: summary.revision,
          expectedDependencyRevisions:
            summary.dependencyRevisions,
          operations: [
            {
              type: "createObject",
              layerId: OBJECT_LAYER_ID,
              object: {
                shape: "polygon",
                x: 40,
                y: 50,
                points: polygonPoints,
                name: "Patrol zone",
              },
            },
            {
              type: "createObject",
              layerId: OBJECT_LAYER_ID,
              object: {
                shape: "polyline",
                x: 4,
                y: 6,
                points: polylinePoints,
                rotation: 15,
              },
            },
          ],
        },
      }),
    );

    expect(preview).toMatchObject({
      operations: [
        {
          type: "createObject",
          layerId: OBJECT_LAYER_ID,
          shape: "polygon",
          object: {
            shape: "polygon",
            x: 40,
            y: 50,
            points: polygonPoints,
            name: "Patrol zone",
          },
        },
        {
          type: "createObject",
          layerId: OBJECT_LAYER_ID,
          shape: "polyline",
          object: {
            shape: "polyline",
            x: 4,
            y: 6,
            points: polylinePoints,
            rotation: 15,
          },
        },
      ],
      summary: {
        affectedObjectLayerIds: [
          OBJECT_LAYER_ID,
        ],
        createdObjectIds: [3, 4],
      },
    });

    const created = resultOf<{
      changed: boolean;
      revision: string;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision:
            preview.expectedRevision,
        },
      }),
    );
    expect(created.changed).toBe(true);

    const afterCreate = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );
    expect(afterCreate.revision).toBe(
      created.revision,
    );
    const replacementPolygonPoints = [
      { x: -1, y: 2.5 },
      { x: 14, y: 0 },
      { x: 7, y: 11 },
    ];
    const replacementPolylinePoints = [
      { x: 3, y: -4 },
      { x: 18.5, y: 9 },
    ];
    const updatePreview = resultOf<{
      changeSetId: string;
      expectedRevision: string;
      operations: Array<Record<string, unknown>>;
    }>(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision:
            afterCreate.revision,
          expectedDependencyRevisions:
            afterCreate.dependencyRevisions,
          operations: [
            {
              type: "updateObject",
              objectId: 3,
              patch: {
                points:
                  replacementPolygonPoints,
                name: "Updated patrol zone",
              },
            },
            {
              type: "updateObject",
              objectId: 4,
              patch: {
                points:
                  replacementPolylinePoints,
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
        changedFields: ["name", "points"],
        patch: {
          points: replacementPolygonPoints,
          name: "Updated patrol zone",
        },
      },
      {
        type: "updateObject",
        objectId: 4,
        changedFields: ["points"],
        patch: {
          points: replacementPolylinePoints,
        },
      },
    ]);

    const updated = resultOf<{
      changed: boolean;
      revision: string;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId:
            updatePreview.changeSetId,
          expectedRevision:
            updatePreview.expectedRevision,
        },
      }),
    );
    expect(updated.changed).toBe(true);

    const updatedPolygon = resultOf<{
      revision: string;
      object: Record<string, unknown>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_object",
        arguments: {
          mapPath: MAP_PATH,
          objectId: 3,
        },
      }),
    );
    expect(updatedPolygon).toMatchObject({
      revision: updated.revision,
      object: {
        id: 3,
        shape: "polygon",
        name: "Updated patrol zone",
        points: replacementPolygonPoints,
      },
    });

    const updatedPolyline = resultOf<{
      revision: string;
      object: Record<string, unknown>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_object",
        arguments: {
          mapPath: MAP_PATH,
          objectId: 4,
        },
      }),
    );
    expect(updatedPolyline).toMatchObject({
      revision: updated.revision,
      object: {
        id: 4,
        shape: "polyline",
        points: replacementPolylinePoints,
      },
    });

    for (const {
      objectId,
      patch,
      message,
    } of [
      {
        objectId: RECTANGLE_OBJECT_ID,
        patch: {
          points: replacementPolygonPoints,
        },
        message:
          "Points can be updated only on polygon or polyline objects.",
      },
      {
        objectId: 3,
        patch: {
          points: replacementPolygonPoints,
          width: 12,
        },
        message:
          "Polygon and polyline objects do not have editable width or height.",
      },
      {
        objectId: 3,
        patch: {
          points: replacementPolygonPoints,
          text: "not a path field",
        },
        message:
          "Text-specific fields can be updated only on text objects.",
      },
    ]) {
      const mismatch = asToolResponse(
        await harness.client.callTool({
          name: "tiled_preview_edits",
          arguments: {
            mapPath: MAP_PATH,
            expectedRevision:
              updated.revision,
            expectedDependencyRevisions:
              afterCreate.dependencyRevisions,
            operations: [
              {
                type: "updateObject",
                objectId,
                patch,
              },
            ],
          },
        }),
      );
      expect(mismatch.isError).toBe(true);
      expect(
        mismatch.structuredContent,
      ).toMatchObject({
        result: {
          error: {
            code: "OBJECT_SHAPE_MISMATCH",
            message,
          },
        },
      });
    }
  });

  it("previews, applies and reads a text object with effective defaults", async () => {
    const summary = resultOf<{
      revision: string;
      dependencyRevisions:
        Record<string, string>;
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
        createdObjectIds: number[];
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
              type: "createObject",
              layerId: OBJECT_LAYER_ID,
              object: {
                shape: "text",
                x: 12,
                y: 14,
                width: 80,
                height: 24,
                name: "Greeting",
                className: "Label",
                text: "Hello\t世界\n",
              },
            },
          ],
        },
      }),
    );
    expect(preview).toMatchObject({
      expectedRevision: summary.revision,
      operations: [
        {
          type: "createObject",
          layerId: OBJECT_LAYER_ID,
          shape: "text",
          object: {
            shape: "text",
            x: 12,
            y: 14,
            width: 80,
            height: 24,
            name: "Greeting",
            className: "Label",
            text: "Hello\t世界\n",
          },
        },
      ],
      summary: {
        createdObjectIds: [3],
      },
    });

    const applied = resultOf<{
      revision: string;
      changed: boolean;
    }>(
      await harness.client.callTool({
        name: "tiled_apply_change_set",
        arguments: {
          changeSetId: preview.changeSetId,
          expectedRevision:
            preview.expectedRevision,
        },
      }),
    );
    expect(applied.changed).toBe(true);

    const details = resultOf<{
      mapPath: string;
      revision: string;
      dependencyRevisions:
        Record<string, string>;
      object: Record<string, unknown>;
    }>(
      await harness.client.callTool({
        name: "tiled_get_object",
        arguments: {
          mapPath: MAP_PATH,
          objectId: 3,
        },
      }),
    );
    expect(details).toEqual({
      mapPath: MAP_PATH,
      revision: applied.revision,
      dependencyRevisions:
        summary.dependencyRevisions,
      object: {
        id: 3,
        layerId: OBJECT_LAYER_ID,
        layerName: "Objects",
        name: "Greeting",
        className: "Label",
        shape: "text",
        x: 12,
        y: 14,
        width: 80,
        height: 24,
        rotation: 0,
        visible: true,
        opacity: 1,
        properties: [],
        propertyCount: 0,
        text: "Hello\t世界\n",
        fontFamily: "sans-serif",
        pixelSize: 16,
        wrap: false,
        color: "#000000",
        bold: false,
        italic: false,
        underline: false,
        strikeout: false,
        kerning: true,
        horizontalAlignment: "left",
        verticalAlignment: "top",
      },
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
        type: "updateObject",
        objectId: RECTANGLE_OBJECT_ID,
        patch: {
          points: [{ x: 0, y: 0 }],
        },
      },
      {
        type: "updateObject",
        objectId: RECTANGLE_OBJECT_ID,
        patch: {
          points: Array.from(
            { length: 257 },
            (_, index) => ({
              x: index,
              y: -index,
            }),
          ),
        },
      },
      {
        type: "updateObject",
        objectId: RECTANGLE_OBJECT_ID,
        patch: {
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1, z: 2 },
          ],
        },
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
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "polygon",
          x: 1,
          y: 2,
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "polyline",
          x: 1,
          y: 2,
          points: [{ x: 0, y: 0 }],
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "polygon",
          x: 1,
          y: 2,
          width: 3,
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 0, y: 1 },
          ],
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "rectangle",
          x: 1,
          y: 2,
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 0, y: 1 },
          ],
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "polyline",
          x: 1,
          y: 2,
          points: [
            { x: 0, y: 0, z: 1 },
            { x: 1, y: 1 },
          ],
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "polygon",
          x: 1,
          y: 2,
          points: [
            { x: 0, y: 0 },
            { x: 1_000_000_001, y: 0 },
            { x: 0, y: 1 },
          ],
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "text",
          x: 1,
          y: 2,
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "text",
          x: 1,
          y: 2,
          text: "\ud800",
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "text",
          x: 1,
          y: 2,
          text: "bad\u0000text",
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "text",
          x: 1,
          y: 2,
          text: "hello",
          fontFamily: "bad\nfamily",
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "text",
          x: 1,
          y: 2,
          text: "hello",
          pixelSize: 1_000,
        },
      },
      {
        type: "createObject",
        layerId: OBJECT_LAYER_ID,
        object: {
          shape: "text",
          x: 1,
          y: 2,
          text: {
            text: "nested TMJ is not wire format",
          },
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

    const maximumPoints = Array.from(
      { length: 256 },
      (_, index) => ({
        x: index,
        y: -index,
      }),
    );
    const aggregateOverflow = asToolResponse(
      await harness.client.callTool({
        name: "tiled_preview_edits",
        arguments: {
          mapPath: MAP_PATH,
          expectedRevision: summary.revision,
          expectedDependencyRevisions:
            summary.dependencyRevisions,
          operations: [
            ...Array.from(
              { length: 32 },
              (_, index) => ({
                type: "createObject",
                layerId: OBJECT_LAYER_ID,
                object: {
                  shape: "polyline",
                  x: index,
                  y: 0,
                  points: maximumPoints,
                },
              }),
            ),
            {
              type: "updateObject",
              objectId: RECTANGLE_OBJECT_ID,
              patch: {
                points: [
                  { x: 0, y: 0 },
                  { x: 1, y: 1 },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(aggregateOverflow.isError).toBe(true);
    expect(
      aggregateOverflow.structuredContent,
    ).toBeUndefined();
    expect(
      aggregateOverflow.content[0],
    ).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        "Input validation error",
      ),
    });

    const textPayloadOverflow =
      asToolResponse(
        await harness.client.callTool({
          name: "tiled_preview_edits",
          arguments: {
            mapPath: MAP_PATH,
            expectedRevision: summary.revision,
            expectedDependencyRevisions:
              summary.dependencyRevisions,
            operations: Array.from(
              { length: 17 },
              (_, index) => ({
                type: "createObject",
                layerId: OBJECT_LAYER_ID,
                object: {
                  shape: "text",
                  x: index,
                  y: 0,
                  text: "😀".repeat(4_096),
                },
              }),
            ),
          },
        }),
      );
    expect(textPayloadOverflow.isError).toBe(
      true,
    );
    expect(
      textPayloadOverflow.structuredContent,
    ).toBeUndefined();
    expect(
      textPayloadOverflow.content[0],
    ).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        "Input validation error",
      ),
    });
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

    const createdBytes = await readFile(
      join(
        harness.root,
        "maps/created.tmj",
      ),
    );
    const created = JSON.parse(
      createdBytes.toString("utf8"),
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

    const repeated = asToolResponse(
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
    expect(repeated).toMatchObject({
      isError: true,
      structuredContent: {
        result: {
          ok: false,
          error: {
            code: "FILE_ALREADY_EXISTS",
          },
        },
      },
    });
    expect(
      await readFile(
        join(
          harness.root,
          "maps/created.tmj",
        ),
      ),
    ).toEqual(createdBytes);

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
    rasterizerMetadataOverride?: Partial<
      Pick<
        RenderPngResult,
        "bytes" | "width" | "height"
      >
    >;
    onRasterizerRender?: (context: {
      root: string;
      inputMapPath: string;
      outputPngPath: string;
      options: RenderPngOptions;
    }) => Promise<void>;
    checkpointOptions?: CheckpointStoreOptions;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "tiledmcp-server-"));
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeJson(join(root, MAP_PATH), baseMap());
  await writeJson(join(root, TILESET_PATH), baseTileset());
  await writeFile(join(root, "tiles", "terrain.png"), await terrainPng());

  const resolver = await ProjectPathResolver.create(root);
  const store = new DocumentStore(
    resolver,
    undefined,
    undefined,
    options.checkpointOptions,
  );
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
  if (
    options.rasterizerAvailable === true ||
    options.rasterizerPng !== undefined
  ) {
    cli.getRasterizerVersion =
      async () => "1.0";
  }
  if (options.rasterizerPng !== undefined) {
    const rasterizerPng = options.rasterizerPng;
    const metadata = await sharp(rasterizerPng).metadata();
    if (
      metadata.width === undefined ||
      metadata.height === undefined
    ) {
      throw new Error("Expected rasterizerPng dimensions.");
    }
    cli.renderPng = async (
      inputMapPath,
      outputPngPath,
      renderOptions,
    ) => {
      await writeFile(outputPngPath, rasterizerPng);
      await options.onRasterizerRender?.({
        root,
        inputMapPath,
        outputPngPath,
        options: renderOptions ?? {},
      });
      return {
        outputPath: outputPngPath,
        png: rasterizerPng,
        bytes:
          options.rasterizerMetadataOverride
            ?.bytes ??
          rasterizerPng.byteLength,
        width:
          options.rasterizerMetadataOverride
            ?.width ?? metadata.width!,
        height:
          options.rasterizerMetadataOverride
            ?.height ?? metadata.height!,
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
  return {
    root,
    client,
    server: created.server,
    store,
  };
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

function expectExactRasterResultOutputSchema(
  schema: unknown,
): void {
  const root = schemaRecord(
    schema,
    "raster output root",
  );
  const rootProperties = schemaRecord(
    root.properties,
    "raster output root properties",
  );
  expect(root).toMatchObject({
    type: "object",
    required: ["result"],
    additionalProperties: false,
  });
  expect(
    Object.keys(rootProperties),
  ).toEqual(["result"]);
  const result = schemaRecord(
    rootProperties.result,
    "raster result union",
  );
  expect(result.anyOf).toEqual(
    expect.any(Array),
  );
  if (!Array.isArray(result.anyOf)) {
    throw new Error(
      "Expected raster result anyOf variants.",
    );
  }
  expect(result.anyOf).toHaveLength(2);
  const successVariant =
    result.anyOf.find((candidate) => {
      if (!isRecord(candidate)) {
        return false;
      }
      const candidateProperties =
        candidate.properties;
      return (
        isRecord(candidateProperties) &&
        "mimeType" in
          candidateProperties
      );
    });
  const success = schemaRecord(
    successVariant,
    "raster success result",
  );
  const successFields = [
    "mimeType",
    "pixelSize",
    "byteLength",
    "sha256",
    "map",
    "dependencyRevisions",
    "renderer",
    "options",
    "snapshotConsistency",
    "truncated",
  ];
  expect(success).toMatchObject({
    type: "object",
    additionalProperties: false,
  });
  expectSchemaRequiredFields(
    success,
    successFields,
    "raster success result",
  );
  const properties = schemaRecord(
    success.properties,
    "raster success properties",
  );
  expect(
    Object.keys(properties).sort(),
  ).toEqual(
    [...successFields].sort(),
  );
  expect(properties.mimeType).toMatchObject({
    type: "string",
    const: "image/png",
  });
  expect(properties.byteLength).toMatchObject({
    type: "integer",
    exclusiveMinimum: 0,
    maximum: 8 * 1_024 * 1_024,
  });
  expect(properties.sha256).toMatchObject({
    type: "string",
    pattern:
      "^sha256:[0-9a-f]{64}$",
  });
  expect(
    properties.snapshotConsistency,
  ).toMatchObject({
    type: "string",
    const:
      "non-atomic-read-set",
  });
  expect(properties.truncated).toMatchObject({
    type: "boolean",
    const: false,
  });

  const pixelFields = expectClosedSchemaFields(
    properties.pixelSize,
    "raster pixelSize",
    ["width", "height"],
  );
  for (const field of [
    "width",
    "height",
  ]) {
    expect(pixelFields[field]).toMatchObject({
      type: "integer",
      exclusiveMinimum: 0,
      maximum: 2_048,
    });
  }
  const mapFields = expectClosedSchemaFields(
    properties.map,
    "raster map snapshot",
    ["path", "revision"],
  );
  expect(mapFields.path).toMatchObject({
    type: "string",
    minLength: 1,
  });
  expect(mapFields.revision).toMatchObject({
    type: "string",
    pattern:
      "^sha256:[0-9a-f]{64}$",
  });
  expect(
    properties.dependencyRevisions,
  ).toMatchObject({
    type: "object",
    propertyNames: {
      type: "string",
      pattern:
        "^asset_[0-9a-f]{24}$",
    },
    additionalProperties: {
      type: "string",
      pattern:
        "^sha256:[0-9a-f]{64}$",
    },
  });
  const rendererFields =
    expectClosedSchemaFields(
      properties.renderer,
      "raster renderer",
      ["kind", "version", "profile"],
    );
  expect(rendererFields.kind).toMatchObject({
    type: "string",
    const: "tmxrasterizer",
  });
  expect(rendererFields.version).toMatchObject({
    type: "string",
    minLength: 1,
    maxLength: 1_024,
  });
  expect(rendererFields.profile).toMatchObject({
    type: "string",
    const:
      "tmxrasterizer-png-v1",
  });
  const optionFields =
    expectClosedSchemaFields(
      properties.options,
      "raster effective options",
      ["size", "ignoreVisibility"],
    );
  expect(optionFields.size).toMatchObject({
    type: "integer",
    exclusiveMinimum: 0,
    maximum: 2_048,
  });
  expect(
    optionFields.ignoreVisibility,
  ).toEqual({
    type: "boolean",
  });
}

function expectClosedSchemaFields(
  schema: unknown,
  context: string,
  fields: string[],
): Record<string, unknown> {
  const objectSchema = schemaRecord(
    schema,
    context,
  );
  expect(objectSchema).toMatchObject({
    type: "object",
    additionalProperties: false,
  });
  expectSchemaRequiredFields(
    objectSchema,
    fields,
    context,
  );
  const properties = schemaRecord(
    objectSchema.properties,
    `${context} properties`,
  );
  expect(
    Object.keys(properties).sort(),
  ).toEqual(
    [...fields].sort(),
  );
  return properties;
}

function expectSchemaRequiredFields(
  schema: Record<string, unknown>,
  fields: string[],
  context: string,
): void {
  if (!Array.isArray(schema.required)) {
    throw new Error(
      `Expected ${context} to define required fields.`,
    );
  }
  expect(
    [...schema.required].sort(),
  ).toEqual(
    [...fields].sort(),
  );
}

function schemaRecord(
  value: unknown,
  context: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(
      `Expected ${context} to be a schema object.`,
    );
  }
  return value;
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
